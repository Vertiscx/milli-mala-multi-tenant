/**
 * Cloudflare Worker Entry Point
 * Adapts the milli-mala multi-tenant service to Cloudflare Workers runtime.
 *
 * Routes:
 *   POST /v1/webhook      — Zendesk webhook (ticket close → PDF → archive)
 *   POST /v1/attachments   — Malaskrá attachment forwarding
 *   GET  /v1/health        — Health check
 *   GET  /v1/audit         — Audit log query (requires AUDIT_SECRET)
 *   POST /v1/4-random-digits/codes, GET /v1/4-random-digits/health
 *                          — random 4-digit codes (when RANDOM_DIGITS_API_KEYS is set)
 */

import { timingSafeEqual, createHash } from 'node:crypto'
import { findRoute, type ServiceRoute } from './platform/http/routes.js'
import { archiveRoutes } from './services/archive/routes.js'
import { KvTenantStore, resolveTenantConfig, sanitizeAuditParam } from './platform/tenant.js'
import type { AuditStore } from './platform/types.js'
import { loadFourRandomDigitsConfig } from './services/fourRandomDigits/config.js'
import {
  createFourRandomDigitsHandler,
  isFourRandomDigitsPath,
  type FourRandomDigitsHandler
} from './services/fourRandomDigits/handler.js'

interface CfEnv {
  TENANT_KV?: { get(key: string, format?: string): Promise<string | null> }
  AUDIT_LOG?: AuditStore
  AUDIT_SECRET?: string
  RANDOM_DIGITS_API_KEYS?: string
  RANDOM_DIGITS_CORS_ORIGINS?: string
  RANDOM_DIGITS_RATE_LIMIT_PER_MINUTE?: string
}

const MAX_BODY_SIZE = 1024 * 1024 // 1MB

// Worker bindings arrive per request, but the handler (and its in-memory
// rate limiter) must live for the whole isolate. Rebuild only if the
// configuration itself changes.
let fourRandomDigits: { settings: string; handler: FourRandomDigitsHandler | null } | undefined

function getFourRandomDigitsHandler(env: CfEnv): FourRandomDigitsHandler | null {
  const raw = {
    RANDOM_DIGITS_API_KEYS: env.RANDOM_DIGITS_API_KEYS,
    RANDOM_DIGITS_CORS_ORIGINS: env.RANDOM_DIGITS_CORS_ORIGINS,
    RANDOM_DIGITS_RATE_LIMIT_PER_MINUTE: env.RANDOM_DIGITS_RATE_LIMIT_PER_MINUTE
  }
  const settings = JSON.stringify(raw)
  if (fourRandomDigits?.settings !== settings) {
    const config = loadFourRandomDigitsConfig(raw)
    fourRandomDigits = { settings, handler: config ? createFourRandomDigitsHandler({ config }) : null }
  }
  return fourRandomDigits.handler
}

async function dispatchServiceRoute(request: Request, route: ServiceRoute, env: CfEnv): Promise<Response> {
  try {
    const contentLength = parseInt(request.headers.get('content-length') || '0', 10)
    if (contentLength > MAX_BODY_SIZE) {
      return Response.json({ error: 'Request body too large' }, { status: 413 })
    }
    const rawBody = await request.text()
    if (rawBody.length > MAX_BODY_SIZE) {
      return Response.json({ error: 'Request body too large' }, { status: 413 })
    }

    let body: Record<string, unknown>
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const brandId = body.brand_id != null ? String(body.brand_id) : undefined
    if (!brandId) {
      return Response.json({ error: 'Missing brand_id' }, { status: 400 })
    }

    // Resolve tenant from KV
    if (!env.TENANT_KV) {
      return Response.json({ error: 'Tenant store not configured' }, { status: 500 })
    }
    const tenantStore = new KvTenantStore(env.TENANT_KV)
    const tenantConfig = await resolveTenantConfig(brandId, tenantStore)
    if (!tenantConfig) {
      return Response.json({ error: 'Invalid request' }, { status: 400 })
    }

    const headers = Object.fromEntries(request.headers)
    const result = await route.handler({ body, rawBody, headers, tenantConfig, auditStore: env.AUDIT_LOG })

    return Response.json(result.body, { status: result.status })
  } catch (error) {
    console.error(`${route.path} error`, (error as Error).message)
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export default {
  async fetch(request: Request, env: CfEnv, _ctx: unknown): Promise<Response> {
    const url = new URL(request.url)

    if (isFourRandomDigitsPath(url.pathname)) {
      const handler = getFourRandomDigitsHandler(env)
      if (handler) return handler(request)
    }

    // Health check
    if (url.pathname === '/v1/health' && request.method === 'GET') {
      return Response.json(
        { status: 'ok', service: 'milli-mala', version: '2.0.0', timestamp: new Date().toISOString() },
        { status: 200 }
      )
    }

    // Audit log endpoint
    if (url.pathname === '/v1/audit' && request.method === 'GET') {
      if (!env.AUDIT_LOG) {
        return Response.json({ error: 'Audit log not configured' }, { status: 500 })
      }
      const authHeader = request.headers.get('authorization')
      const expectedAuth = `Bearer ${env.AUDIT_SECRET}`
      let authValid = false
      if (authHeader) {
        const a = createHash('sha256').update(authHeader).digest()
        const b = createHash('sha256').update(expectedAuth).digest()
        authValid = timingSafeEqual(a, b)
      }
      if (!env.AUDIT_SECRET || !authValid) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
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

      const auditLog = env.AUDIT_LOG as AuditStore
      const keys = await auditLog.list({ prefix, limit })
      const entries = await Promise.all(
        keys.keys.map(async (key) => {
          const value = await auditLog.get(key.name, 'json')
          return value
        })
      )
      return Response.json({ count: entries.length, entries }, { status: 200 })
    }

    const route = request.method === 'POST' ? findRoute(archiveRoutes, request.method, url.pathname) : undefined
    if (route) return dispatchServiceRoute(request, route, env)

    return Response.json({ error: 'Not found' }, { status: 404 })
  }
}
