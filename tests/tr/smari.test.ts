import { describe, it, expect, beforeEach } from 'vitest'
import { handleClientLookup } from '../../src/services/tr/smari/clientLookup.js'
import { mapClientLookup } from '../../src/services/tr/smari/mapper.js'
import { clearJwksCache } from '../../src/services/tr/shared/agentAuth.js'
import { clearAllTrTokens } from '../../src/services/tr/shared/trAuth0.js'
import { HULD, callsTo, installFetch, json, makeReq, makeTenant, makeTrConfig, memoryAudit } from './helpers.js'

const KT = '1203894599'

const SAMPLE = {
  data: {
    kennitala: KT,
    nafn: 'Jón Jónsson',
    simi: '8912345',
    netfang: 'jon@example.is',
    slod: 'https://smari.tr.is/client/1',
    umsoknir: [
      { tegund: 'Ellilífeyrir', staða: 'Í vinnslu', dagsetning: '2026-09-14', slod: 'https://smari.tr.is/app/9' },
      { tegund: 'Heimilisuppbót', staða: 'Lokið', dagsetning: '2026-01-02' },
      { tegund: 'Bad link', staða: 'Opin', slod: 'javascript:alert(1)' }
    ]
  }
}

beforeEach(() => {
  clearJwksCache()
  clearAllTrTokens()
})

describe('mapClientLookup', () => {
  it('normalizes Icelandic keys, drops closed applications and unsafe links', () => {
    expect(mapClientLookup(SAMPLE)).toEqual({
      name: 'Jón Jónsson',
      nationalId: KT,
      phone: '8912345',
      email: 'jon@example.is',
      url: 'https://smari.tr.is/client/1',
      applications: [
        { type: 'Ellilífeyrir', status: 'Í vinnslu', submittedDate: '14.09.2026', url: 'https://smari.tr.is/app/9' },
        { type: 'Bad link', status: 'Opin', submittedDate: null, url: null }
      ]
    })
  })

  it('returns null for an empty or unrecognizable body', () => {
    expect(mapClientLookup(null)).toBeNull()
    expect(mapClientLookup({ foo: 'bar' })).toBeNull()
  })
})

describe('handleClientLookup', () => {
  it('returns the customer card and sends the verified agent email, not one from the body', async () => {
    const mock = installFetch(() => json(200, SAMPLE))
    const audit = memoryAudit()
    const result = await handleClientLookup(makeReq(
      { nationalId: '120389-4599', employeeEmail: 'forged@tr.is', ticket_id: 42 },
      { auditStore: audit }
    ))

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ outcome: 'found', customer: { name: 'Jón Jónsson', nationalId: KT } })

    const [[url, init]] = callsTo(mock, HULD)
    expect(url).toBe(`${HULD}/clientlookup`)
    expect(JSON.parse(init.body as string)).toEqual({ nationalId: KT, employeeEmail: 'anna@tr.is' })
  })

  it('audits metadata only, with the kennitala masked', async () => {
    installFetch(() => json(200, SAMPLE))
    const audit = memoryAudit()
    await handleClientLookup(makeReq({ nationalId: KT, ticket_id: '42' }, { auditStore: audit }))

    const stored = [...audit.entries.values()]
    expect(stored).toHaveLength(2) // brand-wide and per-ticket keys
    const entry = JSON.parse(stored[0])
    expect(entry).toMatchObject({ service: 'tr.smari', ticket_id: '42', agent_email: 'anna@tr.is', target_masked: '120389-****', outcome: 'found' })
    expect(stored.join()).not.toContain(KT)
    expect(stored.join()).not.toContain('Jón')
  })

  it('maps Huld 404 and an unrecognizable body to not_found', async () => {
    installFetch(() => json(404, {}))
    expect((await handleClientLookup(makeReq({ nationalId: KT }))).body).toEqual({ outcome: 'not_found' })
    installFetch(() => json(200, {}))
    expect((await handleClientLookup(makeReq({ nationalId: KT }))).body).toEqual({ outcome: 'not_found' })
  })

  it('returns 502 error for Huld failures', async () => {
    installFetch(() => json(500, {}))
    expect(await handleClientLookup(makeReq({ nationalId: KT }))).toEqual({ status: 502, body: { outcome: 'error' } })
  })

  it('rejects an invalid kennitala without calling Huld', async () => {
    const mock = installFetch(() => json(200, SAMPLE))
    expect(await handleClientLookup(makeReq({ nationalId: '1203894589' }))).toEqual({ status: 400, body: { outcome: 'invalid_national_id' } })
    expect(await handleClientLookup(makeReq({ nationalId: 1203894599 }))).toEqual({ status: 400, body: { outcome: 'invalid_national_id' } })
    expect(callsTo(mock, HULD)).toHaveLength(0)
  })

  it('refuses unauthenticated callers and tenants without Smári', async () => {
    const mock = installFetch(() => json(200, SAMPLE))
    expect((await handleClientLookup(makeReq({ nationalId: KT }, { token: null }))).status).toBe(401)
    expect((await handleClientLookup(makeReq({ nationalId: KT }, { apiKey: 'nope' }))).status).toBe(401)
    expect((await handleClientLookup(makeReq({ nationalId: KT }, { tenant: makeTenant(makeTrConfig({ smari: undefined })) }))).status).toBe(400)
    expect(callsTo(mock, HULD)).toHaveLength(0)
  })
})
