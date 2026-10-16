/**
 * POST /v1/tickets/uploads — upload one file to Zendesk for a ticket the
 * caller is about to create, and return Zendesk's upload token. The caller
 * then sends the token(s) in `comment.uploads` on /v1/tickets/create.
 *
 * Request: the raw file bytes as the body (not multipart, not base64), the
 * file's MIME type in Content-Type, the tenant's X-Api-Key, and in the
 * query string `brand_id`, `filename` and optionally `token` (a token from
 * an earlier upload, to add this file to it).
 *
 * The gateway does the upload because the caller holds no Zendesk
 * credentials: it uses the ticketCreate service's own OAuth client and
 * token cache, the same ones that create the ticket.
 *
 * Only the token goes back to the caller. Zendesk's attachment details
 * (content_url, thumbnails) do not, and the filename is never logged — it
 * can carry a citizen's name or kennitala.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createLogger } from '../../platform/logger.js'
import { fetchWithTimeout } from '../../platform/http.js'
import { resolveTenantConfig, type TenantStore } from '../../platform/tenant.js'
import { getAccessToken, refreshAccessToken } from './oauthClient.js'
import { verifyApiKey, summarizeZendeskError, isValidUploadToken } from './handler.js'
import type { HandlerResult, Logger } from '../../platform/types.js'
import type { TicketUploadHttpRequest } from './types.js'

const logger: Logger = createLogger('ticketCreate.uploads')

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024 // 20 MB per file
const MAX_FILENAME_LENGTH = 255
const MAX_CONTENT_TYPE_LENGTH = 255
const OVERSIZE_DRAIN_MS = 5_000

export class UploadTooLargeError extends Error {
  constructor() {
    super('Upload too large')
  }
}

// A name with an extension, as agents see it on the ticket. No path
// separators or control characters; Icelandic letters are fine.
function isValidFilename(name: string | null): name is string {
  return name !== null &&
    name.length > 0 &&
    name.length <= MAX_FILENAME_LENGTH &&
    !/[\x00-\x1f\x7f/\\]/.test(name) &&
    /^[^.].*\.[^.]+$/.test(name)
}

function isValidContentType(value: string | undefined): value is string {
  return typeof value === 'string' &&
    value.length <= MAX_CONTENT_TYPE_LENGTH &&
    !/[\x00-\x1f\x7f]/.test(value) &&
    /^[\w.+-]+\/[\w.+-]+(\s*;.*)?$/.test(value)
}

async function callZendeskUpload(
  subdomain: string,
  query: URLSearchParams,
  contentType: string,
  file: Buffer,
  accessToken: string
): Promise<Response> {
  return fetchWithTimeout(`https://${subdomain}.zendesk.com/api/v2/uploads?${query}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': contentType },
    body: file
  })
}

/**
 * Core handler — no Node HTTP types involved, so it is testable like
 * handleTicketCreate. Every check that needs no file runs before readBody.
 */
export async function handleTicketUpload(req: TicketUploadHttpRequest, tenantStore: TenantStore): Promise<HandlerResult> {
  const { query, headers } = req
  const startTime = Date.now()

  const brandId = query.get('brand_id') || undefined
  if (!brandId) return { status: 400, body: { error: 'Missing brand_id' } }

  const tenantConfig = await resolveTenantConfig(brandId, tenantStore)
  if (!tenantConfig) return { status: 400, body: { error: 'Invalid request' } }

  const ticketCreateConfig = tenantConfig.services?.ticketCreate
  if (!ticketCreateConfig) return { status: 400, body: { error: 'Invalid request' } }

  if (!verifyApiKey(headers['x-api-key'], ticketCreateConfig.apiKey)) {
    logger.warn('Ticket upload API key verification failed', { brand_id: brandId })
    return { status: 401, body: { error: 'Invalid or missing API key' } }
  }

  const filename = query.get('filename')
  if (!isValidFilename(filename)) {
    return { status: 400, body: { error: 'Invalid or missing filename' } }
  }

  const contentType = headers['content-type']
  if (!isValidContentType(contentType)) {
    return { status: 400, body: { error: 'Invalid or missing Content-Type header' } }
  }

  const existingToken = query.get('token')
  if (existingToken !== null && !isValidUploadToken(existingToken)) {
    return { status: 400, body: { error: 'Invalid token' } }
  }

  // A declared size over the cap is refused before anything is read.
  const declaredLength = Number(headers['content-length'])
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES) {
    return { status: 413, body: { error: 'File too large' } }
  }

  let file: Buffer
  try {
    file = await req.readBody()
  } catch (err) {
    if (err instanceof UploadTooLargeError) return { status: 413, body: { error: 'File too large' } }
    throw err
  }
  if (file.length === 0) return { status: 400, body: { error: 'Empty file' } }

  const zendeskQuery = new URLSearchParams({ filename })
  if (existingToken !== null) zendeskQuery.set('token', existingToken)

  logger.info('Ticket upload request', {
    brand_id: brandId, size_bytes: file.length, content_type: contentType, adds_to_token: existingToken !== null
  })

  try {
    const { subdomain } = tenantConfig.zendesk
    const { clientId, clientSecret } = ticketCreateConfig.oauth

    let accessToken: string
    try {
      accessToken = await getAccessToken(brandId, subdomain, clientId, clientSecret)
    } catch (err) {
      logger.error('Zendesk OAuth token fetch failed', { brand_id: brandId, error: (err as Error).message })
      return { status: 502, body: { error: 'Zendesk authentication failed' } }
    }

    let response = await callZendeskUpload(subdomain, zendeskQuery, contentType, file, accessToken)

    // A 401 means the token was rejected and nothing was stored, so one
    // retry with a fresh token is safe.
    if (response.status === 401) {
      logger.info('Zendesk rejected cached token, retrying with a fresh one', { brand_id: brandId })
      try {
        accessToken = await refreshAccessToken(brandId, subdomain, clientId, clientSecret)
      } catch (err) {
        logger.error('Zendesk OAuth token refresh failed', { brand_id: brandId, error: (err as Error).message })
        return { status: 502, body: { error: 'Zendesk authentication failed' } }
      }
      response = await callZendeskUpload(subdomain, zendeskQuery, contentType, file, accessToken)
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      logger.error('Zendesk upload failed', {
        brand_id: brandId, status: response.status, ...summarizeZendeskError(text)
      })
      // Like ticket create: what Zendesk refuses outright must not look
      // retryable.
      if (response.status === 413) return { status: 413, body: { error: 'File too large' } }
      if (response.status === 422) return { status: 422, body: { error: 'Upload rejected by Zendesk validation' } }
      return { status: 502, body: { error: 'Zendesk upload failed' } }
    }

    const result = (await response.json().catch(() => ({}))) as { upload?: { token?: unknown } }
    const token = typeof result.upload?.token === 'string' ? result.upload.token : null
    if (!token) {
      logger.error('Zendesk upload response had no token', { brand_id: brandId })
      return { status: 502, body: { error: 'Zendesk upload failed' } }
    }

    logger.info('File uploaded', {
      brand_id: brandId, size_bytes: file.length, duration_ms: Date.now() - startTime
    })
    return { status: 201, body: { success: true, token } }
  } catch (error) {
    // e.g. a network error or timeout. Nothing is attached to anything
    // until a ticket uses the token, so the caller can simply upload again.
    logger.error('Ticket upload request failed', { brand_id: brandId, error: (error as Error).message })
    return { status: 500, body: { error: 'Internal server error', duration_ms: Date.now() - startTime } }
  }
}

// ─── Node HTTP adapter ────────────────────────────────────────────────

function readFileBody(req: IncomingMessage, maxSize: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxSize) {
        reject(new UploadTooLargeError())
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

/**
 * Node HTTP entry point, registered directly in index.ts like the other
 * /v1/tickets routes: the body is a file, not JSON, so the shared route
 * gate cannot read brand_id from it.
 */
export async function handleTicketUploadHttp(req: IncomingMessage, res: ServerResponse, tenantStore: TenantStore): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const headers = req.headers as Record<string, string>
    const result = await handleTicketUpload(
      { query: url.searchParams, headers, readBody: () => readFileBody(req, MAX_UPLOAD_BYTES) },
      tenantStore
    )
    if (result.status === 413) {
      // Closing the socket while the client is still sending makes it fail
      // (EPIPE / reset) before it ever reads the 413, and so does
      // Connection: close. So discard the rest of the body for a short
      // while; if it hasn't ended by then, destroy the connection.
      res.on('finish', () => {
        const timer = setTimeout(() => req.destroy(), OVERSIZE_DRAIN_MS)
        req.on('end', () => clearTimeout(timer))
        req.resume()
      })
      return sendJson(res, result.status, result.body)
    }
    sendJson(res, result.status, result.body)
  } catch (error) {
    logger.error('HTTP handler error', { error: (error as Error).message })
    sendJson(res, 500, { error: 'Internal server error' })
  }
}
