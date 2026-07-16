import { describe, it, expect } from 'vitest'
import { findRoute } from '../src/platform/http/routes.js'
import type { GatewayRequest } from '../src/platform/http/routes.js'
import { archiveRoutes } from '../src/services/archive/routes.js'
import type { TenantConfig } from '../src/platform/types.js'

function makeTenantConfig(overrides: Partial<TenantConfig> = {}): TenantConfig {
  return {
    brand_id: '360001234567',
    name: 'Test Tenant',
    zendesk: {
      subdomain: 'test',
      email: 'test@example.com',
      apiToken: 'test-token',
      webhookSecret: 'test-webhook-secret'
    },
    endpoints: {
      onesystems: {
        type: 'onesystems',
        baseUrl: 'https://api.onesystems.test',
        appKey: 'test-key'
      }
    },
    malaskra: { apiKey: 'test-malaskra-key' },
    pdf: {
      companyName: 'Test Company',
      locale: 'is-IS',
      includeInternalNotes: false
    },
    ...overrides
  }
}

describe('findRoute', () => {
  it('finds a route by method and path', () => {
    const routes = [
      { method: 'POST' as const, path: '/v1/webhook', handler: async () => ({ status: 200, body: {} }) },
    ]
    const found = findRoute(routes, 'POST', '/v1/webhook')
    expect(found).toBe(routes[0])
  })

  it('returns undefined for an unknown path', () => {
    const routes = [
      { method: 'POST' as const, path: '/v1/webhook', handler: async () => ({ status: 200, body: {} }) },
    ]
    expect(findRoute(routes, 'POST', '/v1/unknown')).toBeUndefined()
  })

  it('returns undefined for a mismatched method', () => {
    const routes = [
      { method: 'POST' as const, path: '/v1/webhook', handler: async () => ({ status: 200, body: {} }) },
    ]
    expect(findRoute(routes, 'GET', '/v1/webhook')).toBeUndefined()
  })
})

describe('archiveRoutes', () => {
  it('contains exactly the three archive paths', () => {
    const paths = archiveRoutes.map(r => `${r.method} ${r.path}`).sort()
    expect(paths).toEqual([
      'POST /v1/attachments',
      'POST /v1/cases',
      'POST /v1/webhook',
    ])
  })

  it.each(['/v1/webhook', '/v1/attachments', '/v1/cases'])(
    'returns 400 Missing doc_endpoint for %s without calling through, when doc_endpoint is absent',
    async (path) => {
      const route = archiveRoutes.find(r => r.path === path)!
      const req: GatewayRequest = {
        body: {},
        rawBody: '{}',
        headers: {},
        tenantConfig: makeTenantConfig(),
      }
      const result = await route.handler(req)
      expect(result).toEqual({ status: 400, body: { error: 'Missing doc_endpoint' } })
    }
  )
})
