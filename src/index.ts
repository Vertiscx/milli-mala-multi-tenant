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
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { getConfig } from './platform/config.js'
import { findRoute, type ServiceRoute } from './platform/http/routes.js'
import { archiveRoutes } from './services/archive/routes.js'
import { FileTenantStore, resolveTenantConfig, sanitizeAuditParam } from './platform/tenant.js'
import { loadTenantsIsolated, type TenantLoadFailure } from './tenants.config.js'
import { buildHealthBody } from './platform/health.js'
import { FileAuditStore } from './platform/fileAuditStore.js'
import { createLogger } from './platform/logger.js'
import type { Logger } from './platform/types.js'
import { handleTicketUpdateHttp } from './services/ticketUpdate/handler.js'

export { handleWebhook, verifyWebhookSignature, isTimestampFresh } from './services/archive/webhook.js'
export { handleAttachments } from './services/archive/attachments.js'
export { handleCases } from './services/archive/cases.js'
export { handleTicketUpdate } from './services/ticketUpdate/handler.js'

const logger: Logger = createLogger('main')

const MAX_BODY_SIZE = 1024 * 1024 // 1MB

/**
 * Build the tenant store from `src/tenants.config.ts`. Secrets are read from
 * environment variables.
 *
 * Tenants are built independently: one tenant whose variables are missing or
 * whose values fail validation is skipped, loudly, and the rest still serve.
 * One institution's configuration mistake must not stop archiving for the
 * other six. Skipped tenants are reported on /v1/health so the degradation is
 * visible to monitoring rather than only in the boot log.
 *
 * Nothing loading at all is still fatal — a container serving no tenant has
 * nothing to offer, and crashing makes that obvious immediately.
 */
function loadTenantStore(): { store: FileTenantStore; failures: TenantLoadFailure[] } {
  const { tenants, failures } = loadTenantsIsolated()

  for (const failure of failures) {
    logger.error('Tenant skipped — configuration invalid', { tenant: failure.name, error: failure.error })
  }

  if (tenants.length === 0) {
    logger.error('No tenants loaded — refusing to start', { failed: failures.length })
    throw new Error(`No tenants could be loaded (${failures.length} failed)`)
  }

  logger.info('Tenants loaded', { loaded: tenants.length, failed: failures.length })
  return { store: new FileTenantStore(tenants), failures }
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

function handleHealth(
  req: IncomingMessage,
  res: ServerResponse,
  failures: TenantLoadFailure[],
  loadedTenants: number,
  auditSecret: string
): void {
  sendJson(res, 200, buildHealthBody(failures, loadedTenants, isAuditAuthorized(req, auditSecret)))
}

async function dispatchServiceRoute(
  req: IncomingMessage,
  res: ServerResponse,
  route: ServiceRoute,
  tenantStore: FileTenantStore,
  auditStore: FileAuditStore
): Promise<void> {
  try {
    const rawBody = await getRequestBody(req, MAX_BODY_SIZE)
    let body: Record<string, unknown>
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>
    } catch {
      return sendJson(res, 400, { error: 'Invalid JSON body' })
    }
    const brandId = body.brand_id != null ? String(body.brand_id) : undefined
    if (!brandId) return sendJson(res, 400, { error: 'Missing brand_id' })

    const tenantConfig = await resolveTenantConfig(brandId, tenantStore)
    if (!tenantConfig) return sendJson(res, 400, { error: 'Invalid request' })

    const headers = req.headers as Record<string, string>
    const result = await route.handler({ body, rawBody, headers, tenantConfig, auditStore })
    sendJson(res, result.status, result.body)
  } catch (error) {
    logger.error('HTTP handler error', { error: (error as Error).message })
    sendJson(res, 500, { error: 'Internal server error' })
  }
}

/**
 * Constant-time check of the operator bearer token used by /v1/audit, and by
 * /v1/health to decide whether the caller may see tenant-failure detail. An
 * unset AUDIT_SECRET authorizes nobody.
 */
function isAuditAuthorized(req: IncomingMessage, auditSecret: string): boolean {
  if (!auditSecret) return false
  const authHeader = req.headers['authorization'] as string | undefined
  if (!authHeader) return false
  const a = createHash('sha256').update(authHeader).digest()
  const b = createHash('sha256').update(`Bearer ${auditSecret}`).digest()
  return timingSafeEqual(a, b)
}

async function handleAuditHttp(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  auditStore: FileAuditStore,
  auditSecret: string
): Promise<void> {
  if (!isAuditAuthorized(req, auditSecret)) {
    return sendJson(res, 401, { error: 'Unauthorized' })
  }

  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 100)
  const brandId = sanitizeAuditParam(url.searchParams.get('brand_id'))
  const ticketId = sanitizeAuditParam(url.searchParams.get('ticket_id'))

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
  const { store: tenantStore, failures: tenantFailures } = loadTenantStore()
  const auditStore = new FileAuditStore(process.env.AUDIT_DIR || './audit-data')

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, `http://localhost:${port}`)

    if (url.pathname === '/v1/health' && req.method === 'GET') {
      return handleHealth(req, res, tenantFailures, tenantStore.size, config.auditSecret)
    }
    if (url.pathname === '/v1/audit' && req.method === 'GET') return handleAuditHttp(req, res, url, auditStore, config.auditSecret)
    if (url.pathname === '/v1/tickets/update' && req.method === 'POST') return handleTicketUpdateHttp(req, res, tenantStore)

    const route = req.method === 'POST' ? findRoute(archiveRoutes, req.method, url.pathname) : undefined
    if (route) return dispatchServiceRoute(req, res, route, tenantStore, auditStore)

    sendJson(res, 404, { error: 'Not found' })
  })

  server.listen(port, () => logger.info('Server started', { port }))
}

const isCloudFunction = process.env.K_SERVICE !== undefined || process.env.FUNCTION_TARGET !== undefined
if (!isCloudFunction) startServer()
