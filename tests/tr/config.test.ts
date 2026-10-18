import { describe, it, expect } from 'vitest'
import { validateTrConfig, validateTenantConfig, FileTenantStore } from '../../src/platform/tenant.js'
import type { TenantConfig } from '../../src/platform/types.js'
import { makeTenant, makeTrConfig } from './helpers.js'

describe('validateTrConfig', () => {
  it('accepts a complete section and strips a trailing slash from the Huld URL', () => {
    const tr = makeTrConfig({ huld: { baseUrl: 'https://huldtest.tr.is/api/v1/' } })
    expect(() => validateTrConfig(tr, 'TR')).not.toThrow()
    expect(tr.huld.baseUrl).toBe('https://huldtest.tr.is/api/v1')
  })

  it('names every missing field', () => {
    const tr = makeTrConfig({ apiKey: '', agentAuth: { domain: '', audience: 'a', clientId: '', emailClaim: '', emailVerifiedClaim: '' } })
    expect(() => validateTrConfig(tr, 'TR')).toThrow('missing tr apiKey, agentAuth.domain, agentAuth.clientId, agentAuth.emailClaim, agentAuth.emailVerifiedClaim')
  })

  it('requires at least one sub-service', () => {
    expect(() => validateTrConfig(makeTrConfig({ smari: undefined }), 'TR')).toThrow('no service switched on')
  })

  it('rejects a weak API key and one reused from Málaskrá', () => {
    expect(() => validateTrConfig(makeTrConfig({ apiKey: 'short' }), 'TR')).toThrow('tr.apiKey must be at least 32')
    const tr = makeTrConfig()
    expect(() => validateTrConfig(tr, 'TR', tr.apiKey)).toThrow('must differ from malaskra.apiKey')
  })

  it('rejects a non-HTTPS or private Huld URL', () => {
    expect(() => validateTrConfig(makeTrConfig({ huld: { baseUrl: 'http://huld.tr.is' } }), 'TR')).toThrow('must use HTTPS')
    expect(() => validateTrConfig(makeTrConfig({ huld: { baseUrl: 'https://10.0.0.5/api' } }), 'TR')).toThrow('private/reserved')
  })

  it('rejects an Auth0 domain given as a URL', () => {
    const tr = makeTrConfig({ agentAuth: { ...makeTrConfig().agentAuth, domain: 'https://tr.eu.auth0.com/' } })
    expect(() => validateTrConfig(tr, 'TR')).toThrow('tr.agentAuth.domain must be a bare hostname')
  })

  it('refuses an agent-login audience equal to the Huld machine audience', () => {
    const base = makeTrConfig()
    const tr = makeTrConfig({ agentAuth: { ...base.agentAuth, audience: base.auth0.audience } })
    expect(() => validateTrConfig(tr, 'TR')).toThrow('tr.agentAuth.audience must differ from tr.auth0.audience')
  })

  it('is run by validateTenantConfig when the section is present', () => {
    expect(() => validateTenantConfig(makeTenant(makeTrConfig({ apiKey: '' })))).toThrow('missing tr apiKey')
  })
})

describe('FileTenantStore.fromJson — TR key uniqueness', () => {
  it('rejects two tenants sharing a TR API key', () => {
    const a: TenantConfig = { ...makeTenant(), brand_id: '1', name: 'A' }
    const b: TenantConfig = { ...makeTenant(), brand_id: '2', name: 'B' }
    expect(() => FileTenantStore.fromJson(JSON.stringify({ tenants: [a, b] }))).toThrow('Duplicate tr.apiKey')
  })
})
