import { describe, it, expect } from 'vitest'
import { loadTenants } from '../src/tenants.config.js'
import { validateTenantConfig } from '../src/platform/tenant.js'

/**
 * Deterministic, fixture-only secret generator. Produces a value of exact
 * `len` with a readable per-field prefix and varied filler so it satisfies
 * the SYN-MUT-28-1 strength rules (>= minLength AND not a single repeated
 * character). Distinct seeds keep per-tenant uniqueness. These are test
 * fixtures only; real values come from DevOps at deployment time.
 */
function testSecret(seed: string, len: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let out = `${seed}-`
  for (let i = 0; out.length < len; i++) {
    out += alphabet[(seed.charCodeAt(i % seed.length) + i) % alphabet.length]
  }
  return out.slice(0, len)
}

/**
 * Minimum env vars required for `loadTenants` to succeed. Secret values are
 * strong enough to pass the SYN-MUT-28-1 secret strength validation
 * (length + not-a-repeated-character).
 */
const validEnv: Record<string, string> = {
  KERFISSTJORN_ZENDESK_SUBDOMAIN: 'kerfisstjorn-test',
  KERFISSTJORN_ZENDESK_EMAIL: 'admin@kerfisstjorn.test',
  KERFISSTJORN_ZENDESK_API_TOKEN: testSecret('kerf-zd-token', 40),
  KERFISSTJORN_ZENDESK_WEBHOOK_SECRET: testSecret('kerf-zd-webhook', 40),
  KERFISSTJORN_ONESYSTEMS_BASE_URL: 'https://onesystems.test.example/',
  KERFISSTJORN_ONESYSTEMS_APP_KEY: testSecret('kerf-os-appkey', 40),
  KERFISSTJORN_MALASKRA_API_KEY: testSecret('kerf-malaskra-key', 40),
  VINNUEFTIRLIT_ZENDESK_SUBDOMAIN: 'vinnueftirlit-test',
  VINNUEFTIRLIT_ZENDESK_EMAIL: 'admin@vinnueftirlit.test',
  VINNUEFTIRLIT_ZENDESK_API_TOKEN: testSecret('vinn-zd-token', 40),
  VINNUEFTIRLIT_ZENDESK_WEBHOOK_SECRET: testSecret('vinn-zd-webhook', 40),
  VINNUEFTIRLIT_GOPRO_BASE_URL: 'https://gopro.test.example/',
  VINNUEFTIRLIT_GOPRO_USERNAME: 'verjandi',
  VINNUEFTIRLIT_GOPRO_PASSWORD: testSecret('vinn-gopro-pass', 24),
  VINNUEFTIRLIT_MALASKRA_API_KEY: testSecret('vinn-malaskra-key', 40),
  SAMGONGUSTOFA_ZENDESK_SUBDOMAIN: 'samgongustofa-test',
  SAMGONGUSTOFA_ZENDESK_EMAIL: 'admin@samgongustofa.test',
  SAMGONGUSTOFA_ZENDESK_API_TOKEN: testSecret('samg-zd-token', 40),
  SAMGONGUSTOFA_ZENDESK_WEBHOOK_SECRET: testSecret('samg-zd-webhook', 40),
  SAMGONGUSTOFA_ONESYSTEMS_BASE_URL: 'https://onesystems.test.example/',
  SAMGONGUSTOFA_ONESYSTEMS_APP_KEY: testSecret('samg-os-appkey', 40),
  SAMGONGUSTOFA_MALASKRA_API_KEY: testSecret('samg-malaskra-key', 40),
  TRYGGINGASTOFNUN_ZENDESK_SUBDOMAIN: 'tryggingastofnun-test',
  TRYGGINGASTOFNUN_ZENDESK_EMAIL: 'admin@tryggingastofnun.test',
  TRYGGINGASTOFNUN_ZENDESK_API_TOKEN: testSecret('trygg-zd-token', 40),
  TRYGGINGASTOFNUN_ZENDESK_WEBHOOK_SECRET: testSecret('trygg-zd-webhook', 40),
  TRYGGINGASTOFNUN_ONESYSTEMS_BASE_URL: 'https://onesystems.test.example/',
  TRYGGINGASTOFNUN_ONESYSTEMS_APP_KEY: testSecret('trygg-os-appkey', 40),
  TRYGGINGASTOFNUN_MALASKRA_API_KEY: testSecret('trygg-malaskra-key', 40),
  TRYGGINGASTOFNUN_INTERNAL_ZENDESK_SUBDOMAIN: 'tryggingastofnun-test',
  TRYGGINGASTOFNUN_INTERNAL_ZENDESK_EMAIL: 'admin@tryggingastofnun.test',
  TRYGGINGASTOFNUN_INTERNAL_ZENDESK_API_TOKEN: testSecret('tryggint-zd-token', 40),
  TRYGGINGASTOFNUN_INTERNAL_ZENDESK_WEBHOOK_SECRET: testSecret('tryggint-zd-webhook', 40),
  TRYGGINGASTOFNUN_INTERNAL_ONESYSTEMS_BASE_URL: 'https://onesystems.test.example/',
  TRYGGINGASTOFNUN_INTERNAL_ONESYSTEMS_APP_KEY: testSecret('tryggint-os-appkey', 40),
  TRYGGINGASTOFNUN_INTERNAL_MALASKRA_API_KEY: testSecret('tryggint-malaskra-key', 40),
  HMS_ZENDESK_SUBDOMAIN: 'hms-test',
  HMS_ZENDESK_EMAIL: 'admin@hms.test',
  HMS_ZENDESK_API_TOKEN: testSecret('hms-zd-token', 40),
  HMS_ZENDESK_WEBHOOK_SECRET: testSecret('hms-zd-webhook', 40),
  HMS_ONESYSTEMS_BASE_URL: 'https://onesystems.test.example/',
  HMS_ONESYSTEMS_APP_KEY: testSecret('hms-os-appkey', 40),
  HMS_MALASKRA_API_KEY: testSecret('hms-malaskra-key', 40),
}

describe('loadTenants', () => {
  it('returns all tenants when all env vars are set', () => {
    const tenants = loadTenants(validEnv)
    expect(tenants).toHaveLength(6)
    expect(tenants[0].name).toBe('Kerfisstjórn')
    expect(tenants[1].name).toBe('Vinnueftirlitið')
    expect(tenants[2].name).toBe('Samgöngustofa')
    expect(tenants[3].name).toBe('Tryggingastofnun')
    expect(tenants[4].name).toBe('Tryggingastofnun-internal')
    expect(tenants[5].name).toBe('HMS')
  })

  it('produces tenants that pass validateTenantConfig', () => {
    const tenants = loadTenants(validEnv)
    for (const tenant of tenants) {
      expect(() => validateTenantConfig(tenant)).not.toThrow()
    }
  })

  it('preserves Icelandic characters in PDF company name', () => {
    const tenants = loadTenants(validEnv)
    expect(tenants[0].pdf.companyName).toBe('Kerfisstjórn')
    expect(tenants[1].pdf.companyName).toBe('Vinnueftirlitið')
    expect(tenants[2].pdf.companyName).toBe('Samgöngustofa')
    expect(tenants[3].pdf.companyName).toBe('Tryggingastofnun')
    expect(tenants[4].pdf.companyName).toBe('Tryggingastofnun')
    expect(tenants[5].pdf.companyName).toBe('HMS')
  })

  it('uses per-tenant Zendesk credentials (no shared secrets across tenants)', () => {
    const tenants = loadTenants(validEnv)
    expect(tenants[0].zendesk.apiToken).not.toBe(tenants[1].zendesk.apiToken)
    expect(tenants[0].zendesk.webhookSecret).not.toBe(tenants[1].zendesk.webhookSecret)
  })

  it('uses different malaskra api keys per tenant (cross-tenant uniqueness)', () => {
    const tenants = loadTenants(validEnv)
    expect(tenants[0].malaskra.apiKey).not.toBe(tenants[1].malaskra.apiKey)
  })

  it('reads Zendesk subdomain, email, and baseUrl from env vars (not committed in code)', () => {
    const [kerfisstjorn, vinnueftirlit] = loadTenants(validEnv)
    expect(kerfisstjorn.zendesk.subdomain).toBe('kerfisstjorn-test')
    expect(kerfisstjorn.zendesk.email).toBe('admin@kerfisstjorn.test')
    expect(kerfisstjorn.endpoints.onesystems?.baseUrl).toBe('https://onesystems.test.example/')
    expect(vinnueftirlit.zendesk.subdomain).toBe('vinnueftirlit-test')
    expect(vinnueftirlit.zendesk.email).toBe('admin@vinnueftirlit.test')
    expect(vinnueftirlit.endpoints.gopro?.baseUrl).toBe('https://gopro.test.example/')
  })

  it('configures Kerfisstjórn with a OneSystems endpoint', () => {
    const [kerfisstjorn] = loadTenants(validEnv)
    expect(kerfisstjorn.endpoints.onesystems?.type).toBe('onesystems')
  })

  it('configures Vinnueftirlitið with a GoPro endpoint', () => {
    const [, vinnueftirlit] = loadTenants(validEnv)
    expect(vinnueftirlit.endpoints.gopro?.type).toBe('gopro')
  })

  it('configures Samgöngustofa with a OneSystems endpoint', () => {
    const [, , samgongustofa] = loadTenants(validEnv)
    expect(samgongustofa.endpoints.onesystems?.type).toBe('onesystems')
  })

  it('configures both Tryggingastofnun brands with OneSystems endpoints and distinct brand_ids', () => {
    const [, , , tryggingastofnun, tryggingastofnunInternal] = loadTenants(validEnv)
    expect(tryggingastofnun.endpoints.onesystems?.type).toBe('onesystems')
    expect(tryggingastofnun.brand_id).toBe('11204917066386')
    expect(tryggingastofnunInternal.endpoints.onesystems?.type).toBe('onesystems')
    expect(tryggingastofnunInternal.brand_id).toBe('36102499292434')
  })

  it('configures HMS with a OneSystems endpoint and the expected brand_id', () => {
    const tenants = loadTenants(validEnv)
    const hms = tenants.find(t => t.name === 'HMS')!
    expect(hms.endpoints.onesystems?.type).toBe('onesystems')
    expect(hms.brand_id).toBe('25782179205266')
    expect(hms.pdf.includeInternalNotes).toBe(false)
  })

  it('throws with a clear error when HMS_ZENDESK_API_TOKEN is missing', () => {
    const env = { ...validEnv }
    delete env.HMS_ZENDESK_API_TOKEN
    expect(() => loadTenants(env)).toThrow('HMS_ZENDESK_API_TOKEN')
  })

  it('throws with a clear error when KERFISSTJORN_ZENDESK_API_TOKEN is missing', () => {
    const env = { ...validEnv }
    delete env.KERFISSTJORN_ZENDESK_API_TOKEN
    expect(() => loadTenants(env)).toThrow('KERFISSTJORN_ZENDESK_API_TOKEN')
  })

  it('throws when KERFISSTJORN_ZENDESK_SUBDOMAIN is missing', () => {
    const env = { ...validEnv }
    delete env.KERFISSTJORN_ZENDESK_SUBDOMAIN
    expect(() => loadTenants(env)).toThrow('KERFISSTJORN_ZENDESK_SUBDOMAIN')
  })

  it('throws when VINNUEFTIRLIT_ZENDESK_WEBHOOK_SECRET is missing', () => {
    const env = { ...validEnv }
    delete env.VINNUEFTIRLIT_ZENDESK_WEBHOOK_SECRET
    expect(() => loadTenants(env)).toThrow('VINNUEFTIRLIT_ZENDESK_WEBHOOK_SECRET')
  })

  it('throws when KERFISSTJORN_ONESYSTEMS_BASE_URL is missing', () => {
    const env = { ...validEnv }
    delete env.KERFISSTJORN_ONESYSTEMS_BASE_URL
    expect(() => loadTenants(env)).toThrow('KERFISSTJORN_ONESYSTEMS_BASE_URL')
  })

  it('throws when VINNUEFTIRLIT_GOPRO_PASSWORD is missing', () => {
    const env = { ...validEnv }
    delete env.VINNUEFTIRLIT_GOPRO_PASSWORD
    expect(() => loadTenants(env)).toThrow('VINNUEFTIRLIT_GOPRO_PASSWORD')
  })

  it('throws when an env var is the empty string', () => {
    const env = { ...validEnv, KERFISSTJORN_ZENDESK_API_TOKEN: '' }
    expect(() => loadTenants(env)).toThrow('KERFISSTJORN_ZENDESK_API_TOKEN')
  })

  // ─── Optional field-ID env vars (CONF-03) ─────────────────────────────

  it('wires TEMPLATE_FIELD_ID and KENNITALA_FIELD_ID env vars into the OneSystems endpoint', () => {
    const env = {
      ...validEnv,
      TRYGGINGASTOFNUN_TEMPLATE_FIELD_ID: '11111',
      TRYGGINGASTOFNUN_KENNITALA_FIELD_ID: '22222',
    }
    const tenants = loadTenants(env)
    const tryggingastofnun = tenants.find(t => t.name === 'Tryggingastofnun')!
    expect(tryggingastofnun.endpoints.onesystems?.templateFieldId).toBe(11111)
    expect(tryggingastofnun.endpoints.onesystems?.kennitalaFieldId).toBe(22222)
  })

  it('succeeds with the field-ID vars unset — both fields undefined (graceful absence)', () => {
    const tenants = loadTenants(validEnv)
    for (const tenant of tenants) {
      for (const ep of Object.values(tenant.endpoints)) {
        expect(ep.templateFieldId).toBeUndefined()
        expect(ep.kennitalaFieldId).toBeUndefined()
      }
    }
  })

  it('throws at startup for a malformed field-ID value (fail fast)', () => {
    const env = { ...validEnv, KERFISSTJORN_TEMPLATE_FIELD_ID: 'abc' }
    expect(() => loadTenants(env)).toThrow('KERFISSTJORN_TEMPLATE_FIELD_ID')
  })

  it('does not wire template/kennitala field IDs for the GoPro tenant (Vinnueftirlitið)', () => {
    const env = {
      ...validEnv,
      VINNUEFTIRLIT_TEMPLATE_FIELD_ID: '33333',
      VINNUEFTIRLIT_KENNITALA_FIELD_ID: '44444',
    }
    const tenants = loadTenants(env)
    const vinnueftirlit = tenants.find(t => t.name === 'Vinnueftirlitið')!
    expect(vinnueftirlit.endpoints.gopro?.templateFieldId).toBeUndefined()
    expect(vinnueftirlit.endpoints.gopro?.kennitalaFieldId).toBeUndefined()
  })
})
