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
  TRYGGINGASTOFNUN_TICKET_UPDATE_WEBHOOK_SECRET: testSecret('trygg-ticket-update-webhook', 40),
  TRYGGINGASTOFNUN_ZENDESK_OAUTH_CLIENT_ID: testSecret('trygg-oauth-client-id', 40),
  TRYGGINGASTOFNUN_ZENDESK_OAUTH_CLIENT_SECRET: testSecret('trygg-oauth-client-secret', 40),
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
  SYSLUMENN_ZENDESK_SUBDOMAIN: 'syslumenn-test',
  SYSLUMENN_ZENDESK_EMAIL: 'admin@syslumenn.test',
  SYSLUMENN_ZENDESK_API_TOKEN: testSecret('syslu-zd-token', 40),
  SYSLUMENN_ZENDESK_WEBHOOK_SECRET: testSecret('syslu-zd-webhook', 40),
  SYSLUMENN_ONESYSTEMS_BASE_URL: 'https://onesystems.test.example/',
  SYSLUMENN_ONESYSTEMS_APP_KEY: testSecret('syslu-os-appkey', 40),
  SYSLUMENN_MALASKRA_API_KEY: testSecret('syslu-malaskra-key', 40),
  THJODSKRA_ZENDESK_SUBDOMAIN: 'thjodskra-test',
  THJODSKRA_TICKET_CREATE_API_KEY: testSecret('thjod-create-api-key', 40),
  THJODSKRA_TICKET_CREATE_OAUTH_CLIENT_ID: testSecret('thjod-create-client-id', 40),
  THJODSKRA_TICKET_CREATE_OAUTH_CLIENT_SECRET: testSecret('thjod-create-client-secret', 40),
  THSK_ZENDESK_SUBDOMAIN: 'thsk-test',
  THSK_ZENDESK_EMAIL: 'admin@thsk.test',
  THSK_ZENDESK_API_TOKEN: testSecret('thsk-zd-token', 40),
  THSK_ZENDESK_WEBHOOK_SECRET: testSecret('thsk-zd-webhook', 40),
  THSK_ONESYSTEMS_BASE_URL: 'https://onesystems.test.example',
  THSK_ONESYSTEMS_APP_KEY: testSecret('thsk-os-appkey', 40),
  THSK_MALASKRA_API_KEY: testSecret('thsk-malaskra-key', 40),
}

describe('loadTenants', () => {
  it('returns all tenants when all env vars are set', () => {
    const tenants = loadTenants(validEnv)
    expect(tenants).toHaveLength(9)
    expect(tenants[0].name).toBe('Kerfisstjórn')
    expect(tenants[1].name).toBe('Vinnueftirlitið')
    expect(tenants[2].name).toBe('Samgöngustofa')
    expect(tenants[3].name).toBe('Tryggingastofnun')
    expect(tenants[4].name).toBe('Tryggingastofnun-internal')
    expect(tenants[5].name).toBe('HMS')
    expect(tenants[7].name).toBe('Þjóðskrá')
    expect(tenants[8].name).toBe('Þjóðskjalasafn Íslands')
  })

  it('produces tenants that pass validateTenantConfig', () => {
    const tenants = loadTenants(validEnv)
    for (const tenant of tenants) {
      expect(() => validateTenantConfig(tenant)).not.toThrow()
    }
  })

  it('preserves Icelandic characters in PDF company name', () => {
    const tenants = loadTenants(validEnv)
    expect(tenants[0].services.archive!.pdf.companyName).toBe('Kerfisstjórn')
    expect(tenants[1].services.archive!.pdf.companyName).toBe('Vinnueftirlitið')
    expect(tenants[2].services.archive!.pdf.companyName).toBe('Samgöngustofa')
    expect(tenants[3].services.archive!.pdf.companyName).toBe('Tryggingastofnun')
    expect(tenants[4].services.archive!.pdf.companyName).toBe('Tryggingastofnun')
    expect(tenants[5].services.archive!.pdf.companyName).toBe('HMS')
    expect(tenants[8].services.archive!.pdf.companyName).toBe('Þjóðskjalasafn Íslands')
  })

  it('uses per-tenant Zendesk credentials (no shared secrets across tenants)', () => {
    const tenants = loadTenants(validEnv)
    expect(tenants[0].zendesk.apiToken).not.toBe(tenants[1].zendesk.apiToken)
    expect(tenants[0].zendesk.webhookSecret).not.toBe(tenants[1].zendesk.webhookSecret)
  })

  it('uses different malaskra api keys per tenant (cross-tenant uniqueness)', () => {
    const tenants = loadTenants(validEnv)
    expect(tenants[0].services.archive!.malaskra.apiKey).not.toBe(tenants[1].services.archive!.malaskra.apiKey)
  })

  it('reads Zendesk subdomain, email, and baseUrl from env vars (not committed in code)', () => {
    const [kerfisstjorn, vinnueftirlit] = loadTenants(validEnv)
    expect(kerfisstjorn.zendesk.subdomain).toBe('kerfisstjorn-test')
    expect(kerfisstjorn.zendesk.email).toBe('admin@kerfisstjorn.test')
    expect(kerfisstjorn.services.archive!.endpoints.onesystems?.baseUrl).toBe('https://onesystems.test.example/')
    expect(vinnueftirlit.zendesk.subdomain).toBe('vinnueftirlit-test')
    expect(vinnueftirlit.zendesk.email).toBe('admin@vinnueftirlit.test')
    expect(vinnueftirlit.services.archive!.endpoints.gopro?.baseUrl).toBe('https://gopro.test.example/')
  })

  it('configures Kerfisstjórn with a OneSystems endpoint', () => {
    const [kerfisstjorn] = loadTenants(validEnv)
    expect(kerfisstjorn.services.archive!.endpoints.onesystems?.type).toBe('onesystems')
  })

  it('configures Vinnueftirlitið with a GoPro endpoint', () => {
    const [, vinnueftirlit] = loadTenants(validEnv)
    expect(vinnueftirlit.services.archive!.endpoints.gopro?.type).toBe('gopro')
  })

  it('configures Samgöngustofa with a OneSystems endpoint', () => {
    const [, , samgongustofa] = loadTenants(validEnv)
    expect(samgongustofa.services.archive!.endpoints.onesystems?.type).toBe('onesystems')
  })

  it('includes internal notes in the Samgöngustofa PDF — the only tenant that does', () => {
    const tenants = loadTenants(validEnv)
    const samgongustofa = tenants.find(t => t.name === 'Samgöngustofa')!
    expect(samgongustofa.services.archive!.pdf.includeInternalNotes).toBe(true)
    // Only archive tenants have a PDF config (Þjóðskrá has no archive).
    for (const other of tenants.filter(t => t.name !== 'Samgöngustofa' && t.services.archive)) {
      expect(other.services.archive!.pdf.includeInternalNotes).toBe(false)
    }
  })

  it('configures both Tryggingastofnun brands with OneSystems endpoints and distinct brand_ids', () => {
    const [, , , tryggingastofnun, tryggingastofnunInternal] = loadTenants(validEnv)
    expect(tryggingastofnun.services.archive!.endpoints.onesystems?.type).toBe('onesystems')
    expect(tryggingastofnun.brand_id).toBe('11204917066386')
    expect(tryggingastofnunInternal.services.archive!.endpoints.onesystems?.type).toBe('onesystems')
    expect(tryggingastofnunInternal.brand_id).toBe('36102499292434')
  })

  it('configures ticketUpdate credentials for Tryggingastofnun only', () => {
    const tenants = loadTenants(validEnv)
    const tryggingastofnun = tenants.find(t => t.name === 'Tryggingastofnun')!
    expect(tryggingastofnun.services.ticketUpdate?.webhookSecret).toBe(testSecret('trygg-ticket-update-webhook', 40))
    expect(tryggingastofnun.services.ticketUpdate?.oauth.clientId).toBe(testSecret('trygg-oauth-client-id', 40))
    expect(tryggingastofnun.services.ticketUpdate?.oauth.clientSecret).toBe(testSecret('trygg-oauth-client-secret', 40))

    for (const other of tenants.filter(t => t.name !== 'Tryggingastofnun')) {
      expect(other.services.ticketUpdate).toBeUndefined()
    }
  })

  it('throws with a clear error when TRYGGINGASTOFNUN_ZENDESK_OAUTH_CLIENT_SECRET is missing', () => {
    const env = { ...validEnv }
    delete env.TRYGGINGASTOFNUN_ZENDESK_OAUTH_CLIENT_SECRET
    expect(() => loadTenants(env)).toThrow('TRYGGINGASTOFNUN_ZENDESK_OAUTH_CLIENT_SECRET')
  })

  it('loads every tenant with no ticketUpdate section when none of its three variables are set', () => {
    const env = { ...validEnv }
    delete env.TRYGGINGASTOFNUN_TICKET_UPDATE_WEBHOOK_SECRET
    delete env.TRYGGINGASTOFNUN_ZENDESK_OAUTH_CLIENT_ID
    delete env.TRYGGINGASTOFNUN_ZENDESK_OAUTH_CLIENT_SECRET

    // The service is opt-in: unprovisioned means absent, not a boot failure.
    // Anything else would let an unused service stop the container — and with
    // it the archive service for every tenant — from starting.
    const tenants = loadTenants(env)
    expect(tenants.length).toBe(loadTenants(validEnv).length)
    for (const tenant of tenants) {
      expect(tenant.services.ticketUpdate).toBeUndefined()
    }

    const tryggingastofnun = tenants.find(t => t.name === 'Tryggingastofnun')!
    expect(tryggingastofnun.services.archive!.endpoints.onesystems?.type).toBe('onesystems')
  })

  it('configures HMS with a OneSystems endpoint and the expected brand_id', () => {
    const tenants = loadTenants(validEnv)
    const hms = tenants.find(t => t.name === 'HMS')!
    expect(hms.services.archive!.endpoints.onesystems?.type).toBe('onesystems')
    expect(hms.brand_id).toBe('25782179205266')
    expect(hms.services.archive!.pdf.includeInternalNotes).toBe(false)
  })

  it('configures Þjóðskjalasafn Íslands with a OneSystems endpoint and the expected brand_id', () => {
    const tenants = loadTenants(validEnv)
    const thsk = tenants.find(t => t.brand_id === '35200806133010')!
    expect(thsk.name).toBe('Þjóðskjalasafn Íslands')
    expect(thsk.services.archive!.endpoints.onesystems?.type).toBe('onesystems')
    expect(thsk.services.archive!.pdf.includeInternalNotes).toBe(false)
    expect(thsk.services.ticketUpdate).toBeUndefined()
  })

  it('throws with a clear error when THSK_ONESYSTEMS_APP_KEY is missing', () => {
    const env = { ...validEnv }
    delete env.THSK_ONESYSTEMS_APP_KEY
    expect(() => loadTenants(env)).toThrow('THSK_ONESYSTEMS_APP_KEY')
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
    expect(tryggingastofnun.services.archive!.endpoints.onesystems?.templateFieldId).toBe(11111)
    expect(tryggingastofnun.services.archive!.endpoints.onesystems?.kennitalaFieldId).toBe(22222)
  })

  it('succeeds with the field-ID vars unset — both fields undefined (graceful absence)', () => {
    const tenants = loadTenants(validEnv).filter(t => t.services.archive)
    for (const tenant of tenants) {
      for (const ep of Object.values(tenant.services.archive!.endpoints)) {
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
    expect(vinnueftirlit.services.archive!.endpoints.gopro?.templateFieldId).toBeUndefined()
    expect(vinnueftirlit.services.archive!.endpoints.gopro?.kennitalaFieldId).toBeUndefined()
  })
})

describe('loadTenants — Þjóðskrá (ticket creation only)', () => {
  function thjodskra(env: Record<string, string | undefined> = validEnv) {
    return loadTenants(env).find(t => t.brand_id === '30303665547154')!
  }

  it('configures Þjóðskrá with its brand, name and subdomain, and no archive or Zendesk credentials', () => {
    const tenant = thjodskra()
    expect(tenant.name).toBe('Þjóðskrá')
    expect(tenant.zendesk).toEqual({ subdomain: 'thjodskra-test' })
    expect(tenant.services.archive).toBeUndefined()
    expect(tenant.services.ticketUpdate).toBeUndefined()
  })

  it('wires the ticketCreate API key and OAuth client', () => {
    expect(thjodskra().services.ticketCreate).toEqual({
      apiKey: testSecret('thjod-create-api-key', 40),
      oauth: {
        clientId: testSecret('thjod-create-client-id', 40),
        clientSecret: testSecret('thjod-create-client-secret', 40),
      },
    })
  })

  it('passes validateTenantConfig', () => {
    expect(() => validateTenantConfig(thjodskra())).not.toThrow()
  })

  it('is the only tenant with a ticketCreate section', () => {
    for (const other of loadTenants(validEnv).filter(t => t.name !== 'Þjóðskrá')) {
      expect(other.services.ticketCreate).toBeUndefined()
    }
  })

  it('has no ticketCreate section, and still loads, when none of its three variables are set', () => {
    const env = { ...validEnv }
    delete env.THJODSKRA_TICKET_CREATE_API_KEY
    delete env.THJODSKRA_TICKET_CREATE_OAUTH_CLIENT_ID
    delete env.THJODSKRA_TICKET_CREATE_OAUTH_CLIENT_SECRET

    expect(thjodskra(env).services.ticketCreate).toBeUndefined()
    expect(loadTenants(env)).toHaveLength(9)
  })

  it.each([
    'THJODSKRA_TICKET_CREATE_API_KEY',
    'THJODSKRA_TICKET_CREATE_OAUTH_CLIENT_ID',
    'THJODSKRA_TICKET_CREATE_OAUTH_CLIENT_SECRET',
  ])('throws naming %s when only that one of the three is missing', (name) => {
    const env = { ...validEnv }
    delete env[name]
    expect(() => loadTenants(env)).toThrow(name)
  })

  it('throws when THJODSKRA_ZENDESK_SUBDOMAIN is missing', () => {
    const env = { ...validEnv }
    delete env.THJODSKRA_ZENDESK_SUBDOMAIN
    expect(() => loadTenants(env)).toThrow('THJODSKRA_ZENDESK_SUBDOMAIN')
  })
})

describe('loadTenants — TR services (Tryggingastofnun main brand)', () => {
  const trEnv = {
    TRYGGINGASTOFNUN_TR_API_KEY: testSecret('trygg-tr-api-key', 40),
    TRYGGINGASTOFNUN_TR_HULD_BASE_URL: 'https://huldtest.tr.is/zendesktest/api/protected/v1',
    TRYGGINGASTOFNUN_TR_AUTH0_DOMAIN: 'tr-test.eu.auth0.com',
    TRYGGINGASTOFNUN_TR_AUTH0_AUDIENCE: 'https://zendesk.dev.tr.is',
    TRYGGINGASTOFNUN_TR_AUTH0_CLIENT_ID: 'tr-m2m-client',
    TRYGGINGASTOFNUN_TR_AUTH0_CLIENT_SECRET: testSecret('trygg-tr-auth0-secret', 40),
    TRYGGINGASTOFNUN_TR_AGENT_AUTH_DOMAIN: 'tr-test.eu.auth0.com',
    TRYGGINGASTOFNUN_TR_AGENT_AUTH_AUDIENCE: 'https://milli-mala.tr-services',
    TRYGGINGASTOFNUN_TR_AGENT_AUTH_CLIENT_ID: 'tr-smari-spa-client',
    TRYGGINGASTOFNUN_TR_AGENT_AUTH_EMAIL_CLAIM: 'https://tr.is/email',
    TRYGGINGASTOFNUN_TR_AGENT_AUTH_EMAIL_VERIFIED_CLAIM: 'https://tr.is/email_verified',
    TRYGGINGASTOFNUN_TR_EAUTH_ZENDESK_OAUTH_CLIENT_ID: 'tr-eauth-zd-client',
    TRYGGINGASTOFNUN_TR_EAUTH_ZENDESK_OAUTH_CLIENT_SECRET: testSecret('trygg-tr-eauth-zd-secret', 40),
  }
  const byBrand = (env: Record<string, string | undefined>, brand: string) =>
    loadTenants(env).find(t => t.brand_id === brand)!

  it('has no tr section unless a TR service is switched on', () => {
    expect(byBrand({ ...validEnv, ...trEnv }, '11204917066386').services.tr).toBeUndefined()
  })

  it('builds Smári only, with e-auth off', () => {
    const tr = byBrand({ ...validEnv, ...trEnv, TRYGGINGASTOFNUN_TR_SMARI_ENABLED: 'true' }, '11204917066386').services.tr!
    expect(tr.smari).toEqual({ enabled: true })
    expect(tr.eauth).toBeUndefined()
    expect(tr.agentAuth).toEqual({
      domain: 'tr-test.eu.auth0.com',
      audience: 'https://milli-mala.tr-services',
      clientId: 'tr-smari-spa-client',
      emailClaim: 'https://tr.is/email',
      emailVerifiedClaim: 'https://tr.is/email_verified',
    })
  })

  it('builds e-auth with defaults and per-tenant overrides', () => {
    const tr = byBrand({
      ...validEnv, ...trEnv,
      TRYGGINGASTOFNUN_TR_EAUTH_ENABLED: 'true',
      TRYGGINGASTOFNUN_TR_EAUTH_HASH_VALUE_MODE: 'sha256',
      TRYGGINGASTOFNUN_TR_EAUTH_RATE_PER_TARGET_MAX: '5',
    }, '11204917066386').services.tr!
    expect(tr.smari).toBeUndefined()
    expect(tr.eauth).toEqual({
      hashValueMode: 'sha256',
      timeoutSeconds: 120,
      attemptTtlSeconds: 180,
      rateLimits: { perAgent: { max: 10, windowSeconds: 600 }, perTarget: { max: 5, windowSeconds: 600 } },
      zendeskOAuth: { clientId: 'tr-eauth-zd-client', clientSecret: trEnv.TRYGGINGASTOFNUN_TR_EAUTH_ZENDESK_OAUTH_CLIENT_SECRET },
    })
  })

  it('throws naming a missing shared variable once a service is on', () => {
    const env: Record<string, string | undefined> = { ...validEnv, ...trEnv, TRYGGINGASTOFNUN_TR_SMARI_ENABLED: 'true' }
    delete env.TRYGGINGASTOFNUN_TR_AGENT_AUTH_AUDIENCE
    expect(() => loadTenants(env)).toThrow('TRYGGINGASTOFNUN_TR_AGENT_AUTH_AUDIENCE')
  })

  it('never gives the internal TR brand a tr section', () => {
    const env = { ...validEnv, ...trEnv, TRYGGINGASTOFNUN_TR_SMARI_ENABLED: 'true', TRYGGINGASTOFNUN_TR_EAUTH_ENABLED: 'true' }
    expect(byBrand(env, '36102499292434').services.tr).toBeUndefined()
  })
})
