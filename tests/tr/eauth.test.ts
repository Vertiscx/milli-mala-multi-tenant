import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  handleStartAttempt, handleAttemptStatus, handleCancelAttempt, resetEauthState, settleEauth
} from '../../src/services/tr/eauth/handlers.js'
import { mapEidOutcome } from '../../src/services/tr/eauth/mapper.js'
import { generateSecurityCode, deriveHashValue } from '../../src/services/tr/eauth/securityCode.js'
import { buildNote } from '../../src/services/tr/eauth/note.js'
import { AttemptStore, MAX_ATTEMPTS } from '../../src/services/tr/eauth/attempts.js'
import { clearEauthZendeskTokens } from '../../src/services/tr/eauth/zendesk.js'
import { clearJwksCache } from '../../src/services/tr/shared/agentAuth.js'
import { clearAllTrTokens } from '../../src/services/tr/shared/trAuth0.js'
import { BRAND, HULD, callsTo, installFetch, json, makeReq, makeTenant, makeTrConfig, memoryAudit, signToken } from './helpers.js'

const KT = '1203894599'
const OTHER_KT = '0101302989'
const ZD = 'https://digitaliceland.zendesk.com'
const TICKET = 4242

type Answer = () => Response | Promise<Response>

/**
 * Fetch mock for the whole e-auth flow. `eid` answers TR's e-ID call;
 * leave it pending (a deferred) to test cancel/expiry.
 */
function setup(eid: Answer, opts: { ticketBrand?: string; ticketStatus?: number; noteStatus?: number } = {}) {
  return installFetch((url, init) => {
    if (url === `${ZD}/oauth/tokens`) return json(200, { access_token: 'zd-token', expires_in: 7200 })
    if (url === `${ZD}/api/v2/tickets/${TICKET}.json` && init.method === 'GET') {
      return opts.ticketStatus ? json(opts.ticketStatus, {}) : json(200, { ticket: { id: TICKET, brand_id: Number(opts.ticketBrand ?? BRAND) } })
    }
    if (url === `${ZD}/api/v2/tickets/${TICKET}.json` && init.method === 'PUT') return json(opts.noteStatus ?? 200, {})
    if (url === `${HULD}/authentication/rafraen-skilriki`) {
      return new Promise<Response>((resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        Promise.resolve(eid()).then(resolve, reject)
      })
    }
    return json(404, {})
  })
}

function never(): Promise<Response> {
  return new Promise(() => {})
}

async function start(body: Record<string, unknown> = {}, opts: Parameters<typeof makeReq>[1] = {}) {
  return handleStartAttempt(makeReq({ ticket_id: TICKET, phoneNumberOrNationalId: KT, ...body }, opts))
}

async function status(attemptId: unknown, opts: Parameters<typeof makeReq>[1] = {}) {
  return handleAttemptStatus(makeReq({ attemptId }, opts))
}

function noteBody(mock: ReturnType<typeof vi.fn>): string {
  const put = callsTo(mock, `${ZD}/api/v2/tickets/`).find(([, init]) => init.method === 'PUT')!
  const sent = JSON.parse(put[1].body as string)
  expect(sent.ticket.comment.public).toBe(false)
  return sent.ticket.comment.body
}

beforeEach(() => {
  resetEauthState()
  clearJwksCache()
  clearAllTrTokens()
  clearEauthZendeskTokens()
})

afterEach(() => {
  vi.useRealTimers()
  resetEauthState()
})

describe('mapEidOutcome (fail closed)', () => {
  const kt = { kind: 'kennitala' as const, value: KT }
  const phone = { kind: 'phone' as const, value: '8912345' }
  const ok = (data: unknown) => ({ ok: true as const, status: 200, data })

  it('verifies only with an explicit success flag and the matching kennitala', () => {
    expect(mapEidOutcome(ok({ success: true, nationalId: KT }), kt)).toEqual({ status: 'verified', nationalId: KT })
    expect(mapEidOutcome(ok({ data: { tokst: 'true', kennitala: '120389-4599' } }), kt)).toEqual({ status: 'verified', nationalId: KT })
  })

  it('accepts any valid kennitala when the push went to a phone number', () => {
    expect(mapEidOutcome(ok({ verified: true, nationalId: OTHER_KT }), phone)).toEqual({ status: 'verified', nationalId: OTHER_KT })
  })

  it('fails a reply for a different kennitala', () => {
    expect(mapEidOutcome(ok({ success: true, nationalId: OTHER_KT }), kt)).toEqual({ status: 'failed', reason: 'mismatch' })
  })

  it('fails without an explicit success flag, even when a kennitala is echoed', () => {
    expect(mapEidOutcome(ok({ nationalId: KT }), kt)).toEqual({ status: 'failed', reason: 'declined' })
    expect(mapEidOutcome(ok({ success: 'yes', nationalId: KT }), kt)).toEqual({ status: 'failed', reason: 'declined' })
    expect(mapEidOutcome(ok({ success: false, nationalId: KT }), kt)).toEqual({ status: 'failed', reason: 'declined' })
  })

  it('fails success without a valid kennitala, and malformed bodies', () => {
    expect(mapEidOutcome(ok({ success: true }), phone)).toEqual({ status: 'failed', reason: 'error' })
    expect(mapEidOutcome(ok({ success: true, nationalId: '1203894589' }), phone)).toEqual({ status: 'failed', reason: 'error' })
    expect(mapEidOutcome(ok(null), kt)).toEqual({ status: 'failed', reason: 'error' })
    expect(mapEidOutcome(ok([true]), kt)).toEqual({ status: 'failed', reason: 'error' })
  })

  it('maps transport results', () => {
    expect(mapEidOutcome({ ok: false, kind: 'timeout' }, kt)).toEqual({ status: 'failed', reason: 'timeout' })
    expect(mapEidOutcome({ ok: false, kind: 'http', status: 422, data: null }, kt)).toEqual({ status: 'failed', reason: 'declined' })
    expect(mapEidOutcome({ ok: false, kind: 'http', status: 500, data: null }, kt)).toEqual({ status: 'failed', reason: 'error' })
    expect(mapEidOutcome({ ok: false, kind: 'network' }, kt)).toEqual({ status: 'failed', reason: 'error' })
  })
})

describe('security code', () => {
  it('is four digits and the hash mode is configurable', () => {
    for (let i = 0; i < 50; i++) expect(generateSecurityCode()).toMatch(/^\d{4}$/)
    expect(deriveHashValue('0420', 'code')).toBe('0420')
    expect(deriveHashValue('0420', 'sha256')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('buildNote', () => {
  it('writes an Icelandic note with masked identifiers only', () => {
    const text = buildNote({
      status: 'verified', targetMasked: '120389-****', nationalId: KT, agentEmail: 'anna@tr.is',
      attemptId: 'abc', endedAt: new Date('2026-10-18T14:05:00Z')
    })
    expect(text).toContain('Niðurstaða: Staðfest')
    expect(text).toContain('Staðfest kennitala: 120389-****')
    expect(text).toContain('Starfsmaður: anna@tr.is')
    expect(text).toContain('Tími: 18.10.2026 kl. 14:05')
    expect(text).not.toContain(KT)
  })

  it('names the reason for a failure', () => {
    const text = buildNote({ status: 'failed', reason: 'timeout', targetMasked: '***-**45', agentEmail: 'a@tr.is', attemptId: 'x', endedAt: new Date() })
    expect(text).toContain('Niðurstaða: Ekki staðfest')
    expect(text).toContain('Ástæða: Ekkert svar barst innan tímamarka')
  })
})

describe('e-auth flow', () => {
  it('starts an attempt, returns the code at once, and resolves to verified', async () => {
    const mock = setup(() => json(200, { success: true, nationalId: KT }))
    const audit = memoryAudit()
    const started = await start({}, { auditStore: audit })

    expect(started.status).toBe(200)
    expect(started.body).toMatchObject({ securityCode: expect.stringMatching(/^\d{4}$/) })
    const { attemptId, securityCode } = started.body as { attemptId: string; securityCode: string }

    await settleEauth()
    const s = await status(attemptId)
    expect(s.body).toMatchObject({ status: 'verified', nationalId: KT, note: 'written' })

    const [[, init]] = callsTo(mock, `${HULD}/authentication`)
    expect(JSON.parse(init.body as string)).toEqual({ phoneNumberOrNationalId: KT, securityCode, hashValue: securityCode })

    const note = noteBody(mock)
    expect(note).toContain('Niðurstaða: Staðfest')
    expect(note).toContain('Starfsmaður: anna@tr.is')

    const entries = [...audit.entries.values()].map(v => JSON.parse(v))
    expect(entries[0]).toMatchObject({ service: 'tr.eauth', ticket_id: String(TICKET), outcome: 'verified', note_written: true, target_masked: '120389-****' })
    expect(JSON.stringify(entries)).not.toContain(KT)
    expect(JSON.stringify(entries)).not.toContain(`"${securityCode}"`)
  })

  it('calls TR exactly once and never retries, even on 401', async () => {
    const mock = setup(() => json(401, {}))
    const { attemptId } = (await start()).body as { attemptId: string }
    await settleEauth()
    expect(callsTo(mock, `${HULD}/authentication`)).toHaveLength(1)
    expect((await status(attemptId)).body).toMatchObject({ status: 'failed', reason: 'error' })
  })

  it('records a decline as failed and still writes the note', async () => {
    const mock = setup(() => json(422, { message: 'declined' }))
    const { attemptId } = (await start()).body as { attemptId: string }
    await settleEauth()
    expect((await status(attemptId)).body).toMatchObject({ status: 'failed', reason: 'declined', note: 'written' })
    expect(noteBody(mock)).toContain('Ástæða: Auðkenningu hafnað')
  })

  it('cancel ends the attempt, aborts the TR call and ignores a late answer', async () => {
    let answer!: (r: Response) => void
    const mock = setup(() => new Promise<Response>(r => { answer = r }))
    const { attemptId } = (await start()).body as { attemptId: string }
    await vi.waitFor(() => expect(callsTo(mock, `${HULD}/authentication`)).toHaveLength(1))

    const cancelled = await handleCancelAttempt(makeReq({ attemptId }))
    expect(cancelled.body).toMatchObject({ status: 'cancelled' })
    answer?.(json(200, { success: true, nationalId: KT }))
    await settleEauth()

    expect((await status(attemptId)).body).toMatchObject({ status: 'cancelled', note: 'written' })
    expect(noteBody(mock)).toContain('Niðurstaða: Hætt við')
  })

  it("ends as failed: timeout when TR doesn't answer within timeoutSeconds", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const mock = setup(never)
    const tenant = makeTenant(makeTrConfig({ eauth: { ...makeTrConfig().eauth!, timeoutSeconds: 60, attemptTtlSeconds: 90 } }))
    const { attemptId } = (await start({}, { tenant })).body as { attemptId: string }

    await vi.advanceTimersByTimeAsync(61_000)
    vi.useRealTimers()
    await settleEauth()

    expect((await status(attemptId, { tenant })).body).toMatchObject({ status: 'failed', reason: 'timeout', note: 'written' })
    expect(noteBody(mock)).toContain('Ástæða: Ekkert svar barst innan tímamarka')
  })

  it('reports note failure without changing the outcome', async () => {
    setup(() => json(200, { success: true, nationalId: KT }), { noteStatus: 500 })
    const { attemptId } = (await start()).body as { attemptId: string }
    await settleEauth()
    expect((await status(attemptId)).body).toMatchObject({ status: 'verified', note: 'failed' })
  })
})

describe('e-auth checks before any push', () => {
  it('rejects a bad target or ticket id without calling anyone', async () => {
    const mock = setup(never)
    expect(await start({ phoneNumberOrNationalId: '12345' })).toEqual({ status: 400, body: { outcome: 'invalid_target' } })
    expect(await start({ ticket_id: 'abc' })).toEqual({ status: 400, body: { outcome: 'invalid_ticket' } })
    expect(await start({ ticket_id: undefined })).toEqual({ status: 400, body: { outcome: 'invalid_ticket' } })
    expect(callsTo(mock, ZD)).toHaveLength(0)
    expect(callsTo(mock, HULD)).toHaveLength(0)
  })

  it('refuses a ticket from another brand, or a missing ticket, without pushing', async () => {
    let mock = setup(never, { ticketBrand: '99999' })
    expect(await start()).toEqual({ status: 400, body: { outcome: 'brand_mismatch' } })
    expect(callsTo(mock, HULD)).toHaveLength(0)
    mock = setup(never, { ticketStatus: 404 })
    expect(await start()).toEqual({ status: 400, body: { outcome: 'brand_mismatch' } })
    mock = setup(never, { ticketStatus: 500 })
    expect(await start()).toEqual({ status: 502, body: { outcome: 'error' } })
    expect(callsTo(mock, HULD)).toHaveLength(0)
  })

  it('refuses unauthenticated callers and tenants without e-auth', async () => {
    const mock = setup(never)
    expect((await start({}, { token: null })).status).toBe(401)
    expect((await start({}, { apiKey: 'nope' })).status).toBe(401)
    expect((await start({}, { tenant: makeTenant(makeTrConfig({ eauth: undefined })) })).status).toBe(400)
    expect(callsTo(mock, HULD)).toHaveLength(0)
  })

  it('rate-limits per target', async () => {
    // TR declines at once, so attempts end and the pending cap stays out of the way.
    setup(() => json(422, {}))
    for (let i = 0; i < 3; i++) {
      expect((await start()).status).toBe(200)
      await settleEauth()
    }
    expect(await start()).toEqual({ status: 429, body: { outcome: 'rate_limited' } })
    // A different target is still allowed for the same agent.
    expect((await start({ phoneNumberOrNationalId: '8912345' })).status).toBe(200)
  })

  it('cannot be raced: parallel starts for one target push at most the limit', async () => {
    const mock = setup(never)
    const results = await Promise.all(Array.from({ length: 20 }, () => start()))
    expect(results.filter(r => r.status === 200)).toHaveLength(3)
    expect(results.filter(r => r.status === 429)).toHaveLength(17)
    await vi.waitFor(() => expect(callsTo(mock, `${HULD}/authentication`)).toHaveLength(3))
  })

  it('counts a start whose ticket check fails, so lookups are rate-limited too', async () => {
    setup(never, { ticketBrand: '99999' })
    for (let i = 0; i < 3; i++) expect((await start()).body).toEqual({ outcome: 'brand_mismatch' })
    expect(await start()).toEqual({ status: 429, body: { outcome: 'rate_limited' } })
  })

  it('caps how many pending attempts one agent can hold', async () => {
    setup(never)
    for (const phone of ['8912341', '8912342', '8912343']) {
      expect((await start({ phoneNumberOrNationalId: phone })).status).toBe(200)
    }
    expect(await start({ phoneNumberOrNationalId: '8912344' })).toEqual({ status: 429, body: { outcome: 'rate_limited' } })
    const other = signToken({ 'https://tr.is/email': 'bjorn@tr.is' })
    expect((await start({ phoneNumberOrNationalId: '8912344' }, { token: other })).status).toBe(200)
  })

  it('rate-limits per agent', async () => {
    setup(never)
    const eauth = { ...makeTrConfig().eauth!, rateLimits: { perAgent: { max: 2, windowSeconds: 600 }, perTarget: { max: 10, windowSeconds: 600 } } }
    const tenant = makeTenant(makeTrConfig({ eauth }))
    expect((await start({}, { tenant })).status).toBe(200)
    expect((await start({ phoneNumberOrNationalId: '8912345' }, { tenant })).status).toBe(200)
    expect((await start({ phoneNumberOrNationalId: '8912346' }, { tenant })).status).toBe(429)
    // Another agent is unaffected.
    const other = signToken({ 'https://tr.is/email': 'bjorn@tr.is' })
    expect((await start({ phoneNumberOrNationalId: '8912346' }, { tenant, token: other })).status).toBe(200)
  })
})

describe('attempt ownership', () => {
  it('shows another agent "expired" and does not let them cancel', async () => {
    setup(never)
    const { attemptId } = (await start()).body as { attemptId: string }
    const other = signToken({ 'https://tr.is/email': 'bjorn@tr.is' })

    expect((await status(attemptId, { token: other })).body).toEqual({ status: 'expired', note: 'none' })
    expect((await handleCancelAttempt(makeReq({ attemptId }, { token: other }))).body).toEqual({ status: 'expired', note: 'none' })
    expect((await status(attemptId)).body).toMatchObject({ status: 'pending' })
  })

  it('answers unknown or malformed attempt ids as expired', async () => {
    setup(never)
    expect((await status('does-not-exist')).body).toEqual({ status: 'expired', note: 'none' })
    expect((await status(12)).body).toEqual({ status: 'expired', note: 'none' })
  })
})

describe('AttemptStore', () => {
  const input = {
    brandId: BRAND, subdomain: 'digitaliceland', ticketId: '1', agentEmail: 'a@tr.is', targetMasked: 'x',
    zendeskOAuth: { clientId: 'c', clientSecret: 's' }
  }

  it('lets only the first terminal transition win and fires onFinish once', () => {
    const onFinish = vi.fn()
    const s = new AttemptStore(onFinish)
    const a = s.create(input, 60_000)!
    expect(s.finish(a.id, { status: 'cancelled' })).toBe(true)
    expect(s.finish(a.id, { status: 'verified', nationalId: KT })).toBe(false)
    expect(s.get(a.id)!.status).toBe('cancelled')
    expect(onFinish).toHaveBeenCalledTimes(1)
    s.clear()
  })

  it('expires a still-pending attempt after its TTL (safety net behind the TR timeout)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const onFinish = vi.fn()
    const s = new AttemptStore(onFinish)
    const a = s.create(input, 90_000)!
    await vi.advanceTimersByTimeAsync(89_000)
    expect(s.get(a.id)!.status).toBe('pending')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(s.get(a.id)!.status).toBe('expired')
    expect(a.abort.signal.aborted).toBe(true)
    expect(onFinish).toHaveBeenCalledTimes(1)
    s.clear()
  })

  it('sweeps terminal attempts ten minutes after they expire', () => {
    const s = new AttemptStore(() => {})
    const a = s.create(input, 60_000, 0)!
    s.finish(a.id, { status: 'cancelled' }, 1_000)
    s.sweep(60_000 + 10 * 60_000)
    expect(s.get(a.id)).toBeDefined()
    s.sweep(60_000 + 10 * 60_000 + 1)
    expect(s.get(a.id)).toBeUndefined()
  })

  it('makes room by evicting the oldest finished attempt instead of refusing', () => {
    const s = new AttemptStore(() => {})
    const first = s.create(input, 60_000)!
    s.finish(first.id, { status: 'cancelled' }, 1)
    const second = s.create(input, 60_000)!
    s.finish(second.id, { status: 'cancelled' }, 2)
    for (let i = 2; i < MAX_ATTEMPTS; i++) s.create({ ...input, agentEmail: `a${i}@tr.is` }, 60_000)
    expect(s.size).toBe(MAX_ATTEMPTS)
    expect(s.create(input, 60_000)).not.toBeNull()
    expect(s.get(first.id)).toBeUndefined()
    expect(s.get(second.id)).toBeDefined()
    s.clear()
  })

  it('refuses new attempts only when full of pending ones', () => {
    const s = new AttemptStore(() => {})
    for (let i = 0; i < MAX_ATTEMPTS; i++) expect(s.create(input, 60_000)).not.toBeNull()
    expect(s.create(input, 60_000)).toBeNull()
    s.clear()
  })
})
