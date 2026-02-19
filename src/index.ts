/**
 * Milli-Mala Service - Node.js Entry Point
 * Standalone HTTP server for non-Cloudflare deployments (Docker, K8s).
 *
 * Routes:
 *   POST /v1/webhook      — Zendesk webhook (ticket close → PDF → archive)
 *   POST /v1/attachments   — Malaskrá attachment forwarding
 *   GET  /v1/health        — Health check
 *   GET  /v1/audit         — Audit log query (requires AUDIT_SECRET)
 */

import { timingSafeEqual, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { getConfig } from './config.js'
import { handleWebhook } from './webhook.js'
import { handleAttachments } from './attachments.js'
import { FileTenantStore, resolveTenantConfig } from './tenant.js'
import { FileAuditStore } from './fileAuditStore.js'
import { createLogger } from './logger.js'
import type { TenantConfig, Logger } from './types.js'

export { handleWebhook, verifyWebhookSignature, isTimestampFresh } from './webhook.js'
export { handleAttachments } from './attachments.js'

const logger: Logger = createLogger('main')

const MAX_BODY_SIZE = 1024 * 1024 // 1MB

/**
 * Load tenant store from tenants.json file.
 */
function loadTenantStore(): FileTenantStore {
  const tenantsPath = process.env.TENANTS_FILE || './tenants.json'
  try {
    const json = readFileSync(tenantsPath, 'utf-8')
    return FileTenantStore.fromJson(json)
  } catch (err) {
    logger.error('Failed to load tenants file', { path: tenantsPath, error: (err as Error).message })
    // Return empty store — all tenant lookups will return null
    return new FileTenantStore([])
  }
}

function getRequestBody(req: IncomingMessage, maxSize: number): Promise<string> {
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

function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, { status: 'ok', service: 'milli-mala', version: '2.0.0', timestamp: new Date().toISOString() })
}

async function handleWebhookHttp(
  req: IncomingMessage,
  res: ServerResponse,
  tenantStore: FileTenantStore,
  auditStore: FileAuditStore
): Promise<void> {
  try {
    const rawBody = await getRequestBody(req, MAX_BODY_SIZE)
    const body = JSON.parse(rawBody) as Record<string, unknown>
    const brandId = body.brand_id != null ? String(body.brand_id) : undefined
    const docEndpoint = body.doc_endpoint != null ? String(body.doc_endpoint) : undefined

    if (!brandId) return sendJson(res, 400, { error: 'Missing brand_id' })
    if (!docEndpoint) return sendJson(res, 400, { error: 'Missing doc_endpoint' })

    const tenantConfig = await resolveTenantConfig(brandId, tenantStore)
    if (!tenantConfig) return sendJson(res, 404, { error: 'Unknown tenant' })

    const headers = req.headers as Record<string, string>
    const result = await handleWebhook({ body, rawBody, headers, tenantConfig, docEndpoint, auditStore })
    sendJson(res, result.status, result.body)
  } catch (error) {
    logger.error('HTTP handler error', { error: (error as Error).message })
    sendJson(res, 500, { error: 'Internal server error' })
  }
}

async function handleAttachmentsHttp(
  req: IncomingMessage,
  res: ServerResponse,
  tenantStore: FileTenantStore
): Promise<void> {
  try {
    const rawBody = await getRequestBody(req, MAX_BODY_SIZE)
    const body = JSON.parse(rawBody) as Record<string, unknown>
    const brandId = body.brand_id != null ? String(body.brand_id) : undefined
    const docEndpoint = body.doc_endpoint != null ? String(body.doc_endpoint) : undefined

    if (!brandId) return sendJson(res, 400, { error: 'Missing brand_id' })
    if (!docEndpoint) return sendJson(res, 400, { error: 'Missing doc_endpoint' })

    const tenantConfig = await resolveTenantConfig(brandId, tenantStore)
    if (!tenantConfig) return sendJson(res, 404, { error: 'Unknown tenant' })

    const headers = req.headers as Record<string, string>
    const result = await handleAttachments({ body, headers, tenantConfig, docEndpoint })
    sendJson(res, result.status, result.body)
  } catch (error) {
    logger.error('Attachments handler error', { error: (error as Error).message })
    sendJson(res, 500, { error: 'Internal server error' })
  }
}

async function handleAuditHttp(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  auditStore: FileAuditStore,
  auditSecret: string
): Promise<void> {
  const authHeader = req.headers['authorization'] as string | undefined
  const expectedAuth = `Bearer ${auditSecret}`
  let authValid = false
  if (authHeader) {
    const a = createHash('sha256').update(authHeader).digest()
    const b = createHash('sha256').update(expectedAuth).digest()
    authValid = timingSafeEqual(a, b)
  }
  if (!auditSecret || !authValid) {
    return sendJson(res, 401, { error: 'Unauthorized' })
  }

  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 100)
  const brandId = url.searchParams.get('brand_id')
  const ticketId = url.searchParams.get('ticket_id')

  let prefix = 'audit:'
  if (brandId && ticketId) {
    prefix = `ticket:${brandId}:${ticketId}:`
  } else if (brandId) {
    prefix = `audit:${brandId}:`
  }

  const keys = await auditStore.list({ prefix, limit })
  const entries = await Promise.all(
    keys.keys.map(async (key) => {
      const value = await auditStore.get(key.name, 'json')
      return value
    })
  )
  sendJson(res, 200, { count: entries.length, entries })
}

function startServer(): void {
  const config = getConfig()
  const port = config.service.port
  const tenantStore = loadTenantStore()
  const auditStore = new FileAuditStore(process.env.AUDIT_DIR || './audit-data')

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, `http://localhost:${port}`)

    if (url.pathname === '/v1/health' && req.method === 'GET') return handleHealth(req, res)
    if (url.pathname === '/v1/webhook' && req.method === 'POST') return handleWebhookHttp(req, res, tenantStore, auditStore)
    if (url.pathname === '/v1/attachments' && req.method === 'POST') return handleAttachmentsHttp(req, res, tenantStore)
    if (url.pathname === '/v1/audit' && req.method === 'GET') return handleAuditHttp(req, res, url, auditStore, config.auditSecret)

    sendJson(res, 404, { error: 'Not found' })
  })

  server.listen(port, () => logger.info('Server started', { port }))
}

const isCloudFunction = process.env.K_SERVICE !== undefined || process.env.FUNCTION_TARGET !== undefined
if (!isCloudFunction) startServer()
