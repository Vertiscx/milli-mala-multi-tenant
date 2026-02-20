/**
 * Cloudflare Worker Entry Point
 * Adapts the milli-mala multi-tenant service to Cloudflare Workers runtime.
 *
 * Routes:
 *   POST /v1/webhook      — Zendesk webhook (ticket close → PDF → archive)
 *   POST /v1/attachments   — Malaskrá attachment forwarding
 *   GET  /v1/health        — Health check
 *   GET  /v1/audit         — Audit log query (requires AUDIT_SECRET)
 */

import { timingSafeEqual, createHash } from 'node:crypto'
import { handleWebhook } from './webhook.js'
import { handleAttachments } from './attachments.js'
import { KvTenantStore, resolveTenantConfig, sanitizeAuditParam } from './tenant.js'
import type { AuditStore } from './types.js'

interface CfEnv {
  TENANT_KV?: { get(key: string, format?: string): Promise<string | null> }
  AUDIT_LOG?: AuditStore
  AUDIT_SECRET?: string
}

const MAX_BODY_SIZE = 1024 * 1024 // 1MB

/**
 * Parse brand_id and doc_endpoint from request body.
 * Returns the parsed body + extracted fields.
 */
function parseRequestBody(rawBody: string): {
  body: Record<string, unknown>
  brandId: string | undefined
  docEndpoint: string | undefined
} | null {
  try {
    const body = JSON.parse(rawBody) as Record<string, unknown>
    const brandId = body.brand_id != null ? String(body.brand_id) : undefined
    const docEndpoint = body.doc_endpoint != null ? String(body.doc_endpoint) : undefined
    return { body, brandId, docEndpoint }
  } catch {
    return null
  }
}

export default {
  async fetch(request: Request, env: CfEnv, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    // Health check
    if (url.pathname === '/v1/health' && request.method === 'GET') {
      return Response.json(
        { status: 'ok', service: 'milli-mala', version: '2.0.0', timestamp: new Date().toISOString() },
        { status: 200 }
      )
    }

    // Webhook endpoint
    if (url.pathname === '/v1/webhook' && request.method === 'POST') {
      try {
        const contentLength = parseInt(request.headers.get('content-length') || '0', 10)
        if (contentLength > MAX_BODY_SIZE) {
          return Response.json({ error: 'Request body too large' }, { status: 413 })
        }
        const rawBody = await request.text()
        if (rawBody.length > MAX_BODY_SIZE) {
          return Response.json({ error: 'Request body too large' }, { status: 413 })
        }

        const parsed = parseRequestBody(rawBody)
        if (!parsed) {
          return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
        }
        const { body, brandId, docEndpoint } = parsed
        if (!brandId) {
          return Response.json({ error: 'Missing brand_id' }, { status: 400 })
        }
        if (!docEndpoint) {
          return Response.json({ error: 'Missing doc_endpoint' }, { status: 400 })
        }

        // Resolve tenant from KV
        if (!env.TENANT_KV) {
          return Response.json({ error: 'Tenant store not configured' }, { status: 500 })
        }
        const tenantStore = new KvTenantStore(env.TENANT_KV)
        const tenantConfig = await resolveTenantConfig(brandId, tenantStore)
        if (!tenantConfig) {
          return Response.json({ error: 'Unknown tenant' }, { status: 404 })
        }

        const headers = Object.fromEntries(request.headers)
        const result = await handleWebhook({
          body, rawBody, headers, tenantConfig, docEndpoint, auditStore: env.AUDIT_LOG
        })

        return Response.json(result.body, { status: result.status })
      } catch (error) {
        console.error('Webhook error', (error as Error).message)
        return Response.json({ error: 'Internal server error' }, { status: 500 })
      }
    }

    // Attachments endpoint
    if (url.pathname === '/v1/attachments' && request.method === 'POST') {
      try {
        const contentLength = parseInt(request.headers.get('content-length') || '0', 10)
        if (contentLength > MAX_BODY_SIZE) {
          return Response.json({ error: 'Request body too large' }, { status: 413 })
        }
        const rawBody = await request.text()
        if (rawBody.length > MAX_BODY_SIZE) {
          return Response.json({ error: 'Request body too large' }, { status: 413 })
        }

        const parsed = parseRequestBody(rawBody)
        if (!parsed) {
          return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
        }
        const { body, brandId, docEndpoint } = parsed
        if (!brandId) {
          return Response.json({ error: 'Missing brand_id' }, { status: 400 })
        }
        if (!docEndpoint) {
          return Response.json({ error: 'Missing doc_endpoint' }, { status: 400 })
        }

        // Resolve tenant from KV
        if (!env.TENANT_KV) {
          return Response.json({ error: 'Tenant store not configured' }, { status: 500 })
        }
        const tenantStore = new KvTenantStore(env.TENANT_KV)
        const tenantConfig = await resolveTenantConfig(brandId, tenantStore)
        if (!tenantConfig) {
          return Response.json({ error: 'Unknown tenant' }, { status: 404 })
        }

        const headers = Object.fromEntries(request.headers)
        const result = await handleAttachments({ body, headers, tenantConfig, docEndpoint })

        return Response.json(result.body, { status: result.status })
      } catch (error) {
        console.error('Attachments error', (error as Error).message)
        return Response.json({ error: 'Internal server error' }, { status: 500 })
      }
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

    return Response.json({ error: 'Not found' }, { status: 404 })
  }
}
