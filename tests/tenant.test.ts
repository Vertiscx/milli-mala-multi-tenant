import { describe, it, expect } from 'vitest'
import {
  FileTenantStore,
  KvTenantStore,
  resolveTenantConfig,
  validateTenantConfig,
  resolveEndpoint,
  sanitizeAuditParam
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

  it('should validate config and return null for invalid tenant', async () => {
    // Tenant with missing webhookSecret — should fail validation
    const badTenant = makeValidTenant()
    badTenant.zendesk.webhookSecret = ''
    const store = new FileTenantStore([badTenant])
    expect(await resolveTenantConfig('360001234567', store)).toBeNull()
  })

  it('should validate config and return null for invalid subdomain', async () => {
    const badTenant = makeValidTenant()
    badTenant.zendesk.subdomain = 'evil.com/path#'
    const store = new FileTenantStore([badTenant])
    expect(await resolveTenantConfig('360001234567', store)).toBeNull()
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

  // ─── Subdomain validation ───────────────────────────────────────────

  it('should reject subdomain with dots (URL injection)', () => {
    const tenant = makeValidTenant()
    tenant.zendesk.subdomain = 'evil.com/path#'
    expect(() => validateTenantConfig(tenant)).toThrow('invalid characters')
  })

  it('should reject subdomain with slashes', () => {
    const tenant = makeValidTenant()
    tenant.zendesk.subdomain = 'evil/path'
    expect(() => validateTenantConfig(tenant)).toThrow('invalid characters')
  })

  it('should accept valid subdomain with hyphens', () => {
    const tenant = makeValidTenant()
    tenant.zendesk.subdomain = 'my-company-123'
    expect(() => validateTenantConfig(tenant)).not.toThrow()
  })

  // ─── baseUrl validation ─────────────────────────────────────────────

  it('should reject HTTP baseUrl (requires HTTPS)', () => {
    expect(() => validateTenantConfig(makeValidTenant({
      endpoints: {
        onesystems: { type: 'onesystems', baseUrl: 'http://api.onesystems.test', appKey: 'k' }
      }
    }))).toThrow('HTTPS')
  })

  it('should reject baseUrl pointing to localhost', () => {
    expect(() => validateTenantConfig(makeValidTenant({
      endpoints: {
        onesystems: { type: 'onesystems', baseUrl: 'https://localhost/api', appKey: 'k' }
      }
    }))).toThrow('private')
  })

  it('should reject baseUrl pointing to 127.0.0.1', () => {
    expect(() => validateTenantConfig(makeValidTenant({
      endpoints: {
        onesystems: { type: 'onesystems', baseUrl: 'https://127.0.0.1/api', appKey: 'k' }
      }
    }))).toThrow('private')
  })

  it('should reject baseUrl pointing to 10.x.x.x', () => {
    expect(() => validateTenantConfig(makeValidTenant({
      endpoints: {
        onesystems: { type: 'onesystems', baseUrl: 'https://10.0.0.1/api', appKey: 'k' }
      }
    }))).toThrow('private')
  })

  it('should reject baseUrl pointing to 192.168.x.x', () => {
    expect(() => validateTenantConfig(makeValidTenant({
      endpoints: {
        onesystems: { type: 'onesystems', baseUrl: 'https://192.168.1.1/api', appKey: 'k' }
      }
    }))).toThrow('private')
  })

  it('should reject baseUrl pointing to 169.254.x.x (link-local)', () => {
    expect(() => validateTenantConfig(makeValidTenant({
      endpoints: {
        onesystems: { type: 'onesystems', baseUrl: 'https://169.254.169.254/latest', appKey: 'k' }
      }
    }))).toThrow('private')
  })

  it('should accept valid HTTPS baseUrl', () => {
    expect(() => validateTenantConfig(makeValidTenant({
      endpoints: {
        onesystems: { type: 'onesystems', baseUrl: 'https://api.onesystems.is', appKey: 'k' }
      }
    }))).not.toThrow()
  })

  it('should reject invalid baseUrl', () => {
    expect(() => validateTenantConfig(makeValidTenant({
      endpoints: {
        onesystems: { type: 'onesystems', baseUrl: 'not-a-url', appKey: 'k' }
      }
    }))).toThrow('invalid baseUrl')
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

  it('should not leak available endpoint names in error message', () => {
    const tenant = makeValidTenant({
      endpoints: {
        onesystems: { type: 'onesystems', baseUrl: 'https://a.test', appKey: 'k' },
        gopro: { type: 'gopro', baseUrl: 'https://b.test', username: 'u', password: 'p' }
      }
    })
    try {
      resolveEndpoint(tenant, 'bad')
      expect.unreachable('should have thrown')
    } catch (e) {
      expect((e as Error).message).toContain('Unknown doc_endpoint')
      expect((e as Error).message).not.toContain('onesystems')
      expect((e as Error).message).not.toContain('gopro')
    }
  })
})

describe('sanitizeAuditParam', () => {
  it('should accept alphanumeric brand_id', () => {
    expect(sanitizeAuditParam('360001234567')).toBe('360001234567')
  })

  it('should accept brand_id with hyphens and underscores', () => {
    expect(sanitizeAuditParam('brand-a_123')).toBe('brand-a_123')
  })

  it('should reject brand_id with colons (prefix injection)', () => {
    expect(sanitizeAuditParam('tenant_b:2024')).toBeNull()
  })

  it('should reject brand_id with slashes', () => {
    expect(sanitizeAuditParam('../../etc')).toBeNull()
  })

  it('should reject brand_id with spaces', () => {
    expect(sanitizeAuditParam('brand id')).toBeNull()
  })

  it('should return null for empty string', () => {
    expect(sanitizeAuditParam('')).toBeNull()
  })

  it('should return null for null input', () => {
    expect(sanitizeAuditParam(null)).toBeNull()
  })
})

describe('validateTenantConfig — pdf section', () => {
  it('should throw for missing pdf section', () => {
    const tenant = makeValidTenant()
    delete (tenant as any).pdf
    expect(() => validateTenantConfig(tenant)).toThrow('pdf')
  })

  it('should throw for missing pdf.companyName', () => {
    const tenant = makeValidTenant()
    tenant.pdf.companyName = ''
    expect(() => validateTenantConfig(tenant)).toThrow('pdf.companyName')
  })

  it('should accept pdf with only companyName', () => {
    const tenant = makeValidTenant()
    tenant.pdf = { companyName: 'Test' } as any
    expect(() => validateTenantConfig(tenant)).not.toThrow()
  })
})

describe('validateTenantConfig — IPv6-mapped private IPs', () => {
  it('should reject baseUrl pointing to ::ffff:127.0.0.1', () => {
    expect(() => validateTenantConfig(makeValidTenant({
      endpoints: {
        onesystems: { type: 'onesystems', baseUrl: 'https://[::ffff:127.0.0.1]/api', appKey: 'k' }
      }
    }))).toThrow('private')
  })

  it('should reject baseUrl pointing to ::ffff:10.0.0.1', () => {
    expect(() => validateTenantConfig(makeValidTenant({
      endpoints: {
        onesystems: { type: 'onesystems', baseUrl: 'https://[::ffff:10.0.0.1]/api', appKey: 'k' }
      }
    }))).toThrow('private')
  })

  it('should reject baseUrl pointing to ::ffff:169.254.169.254', () => {
    expect(() => validateTenantConfig(makeValidTenant({
      endpoints: {
        onesystems: { type: 'onesystems', baseUrl: 'https://[::ffff:169.254.169.254]/api', appKey: 'k' }
      }
    }))).toThrow('private')
  })
})
