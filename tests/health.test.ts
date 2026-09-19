import { describe, it, expect } from 'vitest'
import { buildHealthBody } from '../src/platform/health.js'
import type { TenantLoadFailure } from '../src/platform/types.js'

const failures: TenantLoadFailure[] = [
  { name: 'HMS', error: 'Missing required environment variable: HMS_ZENDESK_API_TOKEN' },
]

describe('buildHealthBody', () => {
  it('reports ok with the loaded count when every tenant built', () => {
    const body = buildHealthBody([], 7, false)
    expect(body.status).toBe('ok')
    expect(body.tenants).toEqual({ loaded: 7, failed: 0 })
  })

  it('reports degraded when a tenant was skipped', () => {
    const body = buildHealthBody(failures, 6, false)
    expect(body.status).toBe('degraded')
    expect(body.tenants).toEqual({ loaded: 6, failed: 1 })
  })

  it('withholds which tenant failed from an unauthenticated caller', () => {
    // /v1/health is open to the load balancer. Tenant names and variable
    // names are operationally sensitive, so an anonymous caller sees counts.
    const body = buildHealthBody(failures, 6, false)
    expect(JSON.stringify(body)).not.toContain('HMS')
    expect(JSON.stringify(body)).not.toContain('HMS_ZENDESK_API_TOKEN')
  })

  it('includes the detail for a caller holding the audit secret', () => {
    const body = buildHealthBody(failures, 6, true)
    expect(body.tenants).toEqual({ loaded: 6, failed: 1, failures })
  })

  it('adds no failures key when authorized but nothing failed', () => {
    const body = buildHealthBody([], 7, true)
    expect(body.tenants).toEqual({ loaded: 7, failed: 0 })
  })

  it('keeps the fields the existing health consumers already read', () => {
    const body = buildHealthBody([], 7, false)
    expect(body.service).toBe('milli-mala')
    expect(body.version).toBe('2.0.0')
    expect(typeof body.timestamp).toBe('string')
  })
})
