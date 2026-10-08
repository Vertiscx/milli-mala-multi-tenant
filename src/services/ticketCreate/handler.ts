/**
 * POST /v1/tickets/create — create a Zendesk ticket on behalf of a system
 * outside Zendesk (e.g. a web form's backend), authenticated to Zendesk via
 * the tenant's ticketCreate OAuth client (Client Credentials grant).
 *
 * Payload: { "ticket": { "brand_id": ..., <any Zendesk ticket fields> } }.
 * Only brand_id is required. It selects the tenant and is always written
 * onto the created ticket as that tenant's own brand. Everything else in
 * `ticket` is passed to Zendesk, except:
 *   - group_id / ticket_form_id not on the tenant's allowed lists — dropped
 *   - assignee_id, requester_id, submitter_id, organization_id and
 *     comment.author_id — always dropped
 * The brands share one Zendesk account, so those fields could otherwise
 * route a ticket into, or attach it to, another institution's groups,
 * forms, agents or users. Dropping (rather than rejecting) means a
 * citizen's submission is never lost over a field the form shouldn't send.
 *
 * Authenticated by the tenant's X-Api-Key. The caller's Idempotency-Key
 * header is required and passed to Zendesk, so a retried request returns
 * the original ticket instead of creating a second one.
 *
 * Like ticketUpdate, this route resolves the tenant itself because
 * brand_id sits inside `ticket`, not at the top level of the body.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createLogger } from '../../platform/logger.js'
import { fetchWithTimeout } from '../../platform/http.js'
import { resolveTenantConfig, type TenantStore } from '../../platform/tenant.js'
import { getAccessToken, refreshAccessToken } from './oauthClient.js'
import type { HandlerResult, Logger } from '../../platform/types.js'
import type { TicketCreateHttpRequest } from './types.js'

const logger: Logger = createLogger('ticketCreate')

const MAX_BODY_SIZE = 1024 * 1024 // 1MB — matches every other route in this repo
const MAX_IDEMPOTENCY_KEY_LENGTH = 255

const ALWAYS_DROPPED_FIELDS = ['assignee_id', 'requester_id', 'submitter_id', 'organization_id'] as const

// Same check as the archive service's Málaskrá key (SHA-256, then a
// constant-time compare), duplicated rather than imported: services
// don't import each other.
function verifyApiKey(provided: string | undefined, expected: string): boolean {
  if (!provided) return false
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

function isValidIdempotencyKey(key: unknown): key is string {
  return typeof key === 'string' &&
    key.length > 0 &&
    key.length <= MAX_IDEMPOTENCY_KEY_LENGTH &&
    !/[\x00-\x1f\x7f]/.test(key)
}

// Accepts a number or a digits-only string (form templates often produce
// strings); returns the ID as a number only if it is on the allowed list.
function allowedId(value: unknown, allowed: number[]): number | undefined {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  return typeof n === 'number' && Number.isSafeInteger(n) && allowed.includes(n) ? n : undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Build the ticket sent to Zendesk from the caller's ticket: drop the
 * restricted fields, keep group/form IDs only if allowed, and force the
 * tenant's own brand. Returns the names of the fields that were dropped.
 */
function prepareTicket(
  ticket: Record<string, unknown>,
  brandId: string,
  allowedGroupIds: number[],
  allowedFormIds: number[]
): { fields: Record<string, unknown>; dropped: string[] } {
  const { brand_id: _brandId, ...fields } = ticket
  const dropped: string[] = []

  for (const name of ALWAYS_DROPPED_FIELDS) {
    if (name in fields) {
      delete fields[name]
      dropped.push(name)
    }
  }

  if (isPlainObject(fields.comment) && 'author_id' in fields.comment) {
    const { author_id: _authorId, ...comment } = fields.comment
    fields.comment = comment
    dropped.push('comment.author_id')
  }

  for (const [name, allowed] of [['group_id', allowedGroupIds], ['ticket_form_id', allowedFormIds]] as const) {
    if (!(name in fields)) continue
    const id = allowedId(fields[name], allowed)
    if (id === undefined) {
      logger.warn('Dropped field not on the tenant\'s allowed list', {
        brand_id: brandId,
        field: name,
        // Group and form IDs are not personal data; logged so a ticket that
        // lands in the brand's default queue can be explained.
        value: String(fields[name])
      })
      delete fields[name]
      dropped.push(name)
    } else {
      fields[name] = id
    }
  }

  fields.brand_id = Number(brandId)
  return { fields, dropped }
}

// Zendesk's validation messages can echo submitted values (e.g. a
// requester's email), so only the error code and the names of the
// offending fields are logged — never the descriptions.
function summarizeZendeskError(text: string): { zendesk_error?: string; zendesk_error_fields?: string[] } {
  try {
    const parsed = JSON.parse(text) as { error?: unknown; details?: unknown }
    return {
      zendesk_error: typeof parsed.error === 'string' ? parsed.error : undefined,
      zendesk_error_fields: isPlainObject(parsed.details) ? Object.keys(parsed.details) : undefined
    }
  } catch {
    return {}
  }
}

async function callZendeskCreate(
  subdomain: string,
  ticket: Record<string, unknown>,
  accessToken: string,
  idempotencyKey: string
): Promise<Response> {
  return fetchWithTimeout(`https://${subdomain}.zendesk.com/api/v2/tickets.json`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey
    },
    body: JSON.stringify({ ticket })
  })
}

/**
 * Core handler — a pure function of (body, headers, tenantStore), no Node
 * HTTP types involved, so it is testable like handleTicketUpdate.
 */
export async function handleTicketCreate(req: TicketCreateHttpRequest, tenantStore: TenantStore): Promise<HandlerResult> {
  const { body, headers } = req
  const startTime = Date.now()

  // The body is parsed JSON, so it may be null, an array or a scalar.
  const ticket = isPlainObject(body) ? body.ticket : undefined
  if (!isPlainObject(ticket)) {
    return { status: 400, body: { error: 'Missing ticket' } }
  }

  const brandId = ticket.brand_id != null ? String(ticket.brand_id) : undefined
  if (!brandId) {
    return { status: 400, body: { error: 'Missing ticket.brand_id' } }
  }

  const tenantConfig = await resolveTenantConfig(brandId, tenantStore)
  if (!tenantConfig) return { status: 400, body: { error: 'Invalid request' } }

  const ticketCreateConfig = tenantConfig.services?.ticketCreate
  if (!ticketCreateConfig) return { status: 400, body: { error: 'Invalid request' } }

  if (!verifyApiKey(headers['x-api-key'], ticketCreateConfig.apiKey)) {
    logger.warn('Ticket create API key verification failed', { brand_id: brandId })
    return { status: 401, body: { error: 'Invalid or missing API key' } }
  }

  const idempotencyKey = headers['idempotency-key']
  if (!isValidIdempotencyKey(idempotencyKey)) {
    return { status: 400, body: { error: 'Invalid or missing Idempotency-Key header' } }
  }

  const { fields, dropped } = prepareTicket(
    ticket, tenantConfig.brand_id, ticketCreateConfig.allowedGroupIds, ticketCreateConfig.allowedFormIds
  )

  logger.info('Ticket create request', {
    brand_id: brandId, idempotency_key: idempotencyKey, fields: Object.keys(fields), dropped_fields: dropped
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

    let response = await callZendeskCreate(subdomain, fields, accessToken, idempotencyKey)

    // A 401 means the token was rejected and nothing was created, so one
    // retry with a fresh token (and the same Idempotency-Key) is safe.
    if (response.status === 401) {
      logger.info('Zendesk rejected cached token, retrying with a fresh one', { brand_id: brandId })
      try {
        accessToken = await refreshAccessToken(brandId, subdomain, clientId, clientSecret)
      } catch (err) {
        logger.error('Zendesk OAuth token refresh failed', { brand_id: brandId, error: (err as Error).message })
        return { status: 502, body: { error: 'Zendesk authentication failed' } }
      }
      response = await callZendeskCreate(subdomain, fields, accessToken, idempotencyKey)
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      if (response.status === 400 && text.includes('IdempotentRequestError')) {
        logger.warn('Idempotency-Key reused with a different request', {
          brand_id: brandId, idempotency_key: idempotencyKey
        })
        return { status: 409, body: { error: 'Idempotency-Key already used with a different request' } }
      }
      logger.error('Zendesk ticket creation failed', {
        brand_id: brandId, idempotency_key: idempotencyKey, status: response.status, ...summarizeZendeskError(text)
      })
      return { status: 502, body: { error: 'Zendesk ticket creation failed' } }
    }

    const result = (await response.json().catch(() => ({}))) as { ticket?: { id?: unknown } }
    const ticketId = typeof result.ticket?.id === 'number' ? result.ticket.id : null
    const duration = Date.now() - startTime
    logger.info('Ticket created', {
      brand_id: brandId, idempotency_key: idempotencyKey, ticket_id: ticketId, duration_ms: duration
    })

    // Only the new ticket's ID goes back — never its content.
    return {
      status: 201,
      body: {
        success: true,
        ticket_id: ticketId,
        brand_id: tenantConfig.brand_id,
        dropped_fields: dropped
      }
    }
  } catch (error) {
    // e.g. a network error or timeout after the request was sent: the ticket
    // may or may not exist. The caller can retry safely with the same
    // Idempotency-Key — Zendesk returns the original ticket within 2 hours.
    logger.error('Ticket create request failed', {
      brand_id: brandId, idempotency_key: idempotencyKey, error: (error as Error).message
    })
    return { status: 500, body: { error: 'Internal server error', duration_ms: Date.now() - startTime } }
  }
}

// ─── Node HTTP adapter ────────────────────────────────────────────────

function readRawBody(req: IncomingMessage, maxSize: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxSize) {
        req.destroy()
        reject(new Error('Request body too large'))
        return
      }
      body += chunk
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

/**
 * Node HTTP entry point, registered directly in index.ts (like
 * /v1/tickets/update) because brand_id is nested inside `ticket`.
 */
export async function handleTicketCreateHttp(req: IncomingMessage, res: ServerResponse, tenantStore: TenantStore): Promise<void> {
  try {
    const rawBody = await readRawBody(req, MAX_BODY_SIZE)
    let body: Record<string, unknown>
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>
    } catch {
      return sendJson(res, 400, { error: 'Invalid JSON body' })
    }
    const headers = req.headers as Record<string, string>
    const result = await handleTicketCreate({ body, headers }, tenantStore)
    sendJson(res, result.status, result.body)
  } catch (error) {
    logger.error('HTTP handler error', { error: (error as Error).message })
    sendJson(res, 500, { error: 'Internal server error' })
  }
}
