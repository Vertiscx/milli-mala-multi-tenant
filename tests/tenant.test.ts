import { describe, it, expect } from 'vitest'
import {
  FileTenantStore,
  KvTenantStore,
  resolveTenantConfig,
  validateTenantConfig,
  resolveEndpoint
} from '../src/tenant.js'
import type { TenantConfig } from '../src/types.js'

function makeValidTenant(overrides: Partial<TenantConfig> = {}): TenantConfig {
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

describe('FileTenantStore', () => {
  it('should resolve tenant by brand_id', async () => {
    const store = new FileTenantStore([makeValidTenant()])
    const config = await store.get('360001234567')
    expect(config).not.toBeNull()
    expect(config!.name).toBe('Test Tenant')
  })

  it('should return null for unknown brand_id', async () => {
    const store = new FileTenantStore([makeValidTenant()])
    const config = await store.get('unknown-id')
    expect(config).toBeNull()
  })

  it('should handle multiple tenants', async () => {
    const store = new FileTenantStore([
      makeValidTenant({ brand_id: 'brand-a', name: 'Tenant A' }),
      makeValidTenant({ brand_id: 'brand-b', name: 'Tenant B' })
    ])
    expect((await store.get('brand-a'))!.name).toBe('Tenant A')
    expect((await store.get('brand-b'))!.name).toBe('Tenant B')
  })

  it('should parse from JSON', () => {
    const json = JSON.stringify({ tenants: [makeValidTenant()] })
    const store = FileTenantStore.fromJson(json)
    expect(store).toBeInstanceOf(FileTenantStore)
  })
})

describe('KvTenantStore', () => {
  it('should resolve tenant from KV namespace', async () => {
    const tenant = makeValidTenant()
    const kv = { get: async (key: string) => key === 'tenant:360001234567' ? JSON.stringify(tenant) : null }
    const store = new KvTenantStore(kv)
    const config = await store.get('360001234567')
    expect(config).not.toBeNull()
    expect(config!.name).toBe('Test Tenant')
  })

  it('should return null for unknown brand_id', async () => {
    const kv = { get: async () => null }
    const store = new KvTenantStore(kv)
    expect(await store.get('unknown')).toBeNull()
  })

  it('should return null for invalid JSON in KV', async () => {
    const kv = { get: async () => 'not-json' }
    const store = new KvTenantStore(kv)
    expect(await store.get('bad')).toBeNull()
  })
})

describe('resolveTenantConfig', () => {
  it('should return tenant config for valid brand_id', async () => {
    const store = new FileTenantStore([makeValidTenant()])
    const config = await resolveTenantConfig('360001234567', store)
    expect(config).not.toBeNull()
  })

  it('should return null for empty brand_id', async () => {
    const store = new FileTenantStore([makeValidTenant()])
    expect(await resolveTenantConfig('', store)).toBeNull()
  })

  it('should return null for unknown brand_id', async () => {
    const store = new FileTenantStore([makeValidTenant()])
    expect(await resolveTenantConfig('unknown', store)).toBeNull()
  })
})

describe('validateTenantConfig', () => {
  it('should pass for a valid config', () => {
    expect(() => validateTenantConfig(makeValidTenant())).not.toThrow()
  })

  it('should throw for missing brand_id', () => {
    expect(() => validateTenantConfig(makeValidTenant({ brand_id: '' }))).toThrow('brand_id')
  })

  it('should throw for missing zendesk subdomain', () => {
    const tenant = makeValidTenant()
    tenant.zendesk.subdomain = ''
    expect(() => validateTenantConfig(tenant)).toThrow('zendesk.subdomain')
  })

  it('should throw for missing malaskra apiKey', () => {
    const tenant = makeValidTenant()
    tenant.malaskra.apiKey = ''
    expect(() => validateTenantConfig(tenant)).toThrow('malaskra.apiKey')
  })

  it('should throw for empty endpoints', () => {
    expect(() => validateTenantConfig(makeValidTenant({ endpoints: {} }))).toThrow('endpoints')
  })

  it('should throw for onesystems endpoint missing appKey', () => {
    expect(() => validateTenantConfig(makeValidTenant({
      endpoints: {
        onesystems: { type: 'onesystems', baseUrl: 'https://test.com' }
      }
    }))).toThrow('appKey')
  })

  it('should throw for gopro endpoint missing username', () => {
    expect(() => validateTenantConfig(makeValidTenant({
      endpoints: {
        gopro: { type: 'gopro', baseUrl: 'https://test.com' }
      }
    }))).toThrow('username')
  })

  it('should throw for unknown endpoint type', () => {
    expect(() => validateTenantConfig(makeValidTenant({
      endpoints: {
        custom: { type: 'sharepoint' as any, baseUrl: 'https://test.com' }
      }
    }))).toThrow('unknown type')
  })

  it('should validate gopro endpoint with all required fields', () => {
    expect(() => validateTenantConfig(makeValidTenant({
      endpoints: {
        gopro: { type: 'gopro', baseUrl: 'https://gopro.test', username: 'u', password: 'p' }
      }
    }))).not.toThrow()
  })
})

describe('resolveEndpoint', () => {
  it('should return the endpoint config for a valid doc_endpoint', () => {
    const tenant = makeValidTenant()
    const ep = resolveEndpoint(tenant, 'onesystems')
    expect(ep.type).toBe('onesystems')
    expect(ep.baseUrl).toBe('https://api.onesystems.test')
  })

  it('should throw for unknown doc_endpoint', () => {
    const tenant = makeValidTenant()
    expect(() => resolveEndpoint(tenant, 'sharepoint')).toThrow('Unknown doc_endpoint')
  })

  it('should list available endpoints in error message', () => {
    const tenant = makeValidTenant({
      endpoints: {
        onesystems: { type: 'onesystems', baseUrl: 'https://a.test', appKey: 'k' },
        gopro: { type: 'gopro', baseUrl: 'https://b.test', username: 'u', password: 'p' }
      }
    })
    try {
      resolveEndpoint(tenant, 'bad')
    } catch (e) {
      expect((e as Error).message).toContain('onesystems')
      expect((e as Error).message).toContain('gopro')
    }
  })
})
