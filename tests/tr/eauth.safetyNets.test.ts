/**
 * The e-auth handler's two safety nets: an unexpected error while deciding
 * an outcome, or while writing the note and audit, must neither crash the
 * gateway nor leave an attempt stuck in "pending". Neither path throws in
 * normal use, so the mapper and note builder are replaced here to force it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../src/services/tr/eauth/mapper.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/tr/eauth/mapper.js')>()
  return { ...actual, mapEidOutcome: vi.fn(actual.mapEidOutcome) }
})
vi.mock('../../src/services/tr/eauth/note.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/tr/eauth/note.js')>()
  return { ...actual, buildNote: vi.fn(actual.buildNote) }
})

import { handleStartAttempt, handleAttemptStatus, resetEauthState, settleEauth } from '../../src/services/tr/eauth/handlers.js'
import { mapEidOutcome } from '../../src/services/tr/eauth/mapper.js'
import { buildNote } from '../../src/services/tr/eauth/note.js'
import { clearEauthZendeskTokens } from '../../src/services/tr/eauth/zendesk.js'
import { clearJwksCache } from '../../src/services/tr/shared/agentAuth.js'
import { clearAllTrTokens } from '../../src/services/tr/shared/trAuth0.js'
import { BRAND, HULD, installFetch, json, makeReq, memoryAudit } from './helpers.js'

const ZD = 'https://digitaliceland.zendesk.com'
const TICKET = 4242
const KT = '1203894599'

function setup() {
  return installFetch((url, init) => {
    if (url === `${ZD}/oauth/tokens`) return json(200, { access_token: 'zd-token', expires_in: 7200 })
    if (url === `${ZD}/api/v2/tickets/${TICKET}.json` && init.method === 'GET') {
      return json(200, { ticket: { id: TICKET, brand_id: Number(BRAND) } })
    }
    if (url === `${ZD}/api/v2/tickets/${TICKET}.json` && init.method === 'PUT') return json(200, {})
    if (url === `${HULD}/authentication/rafraen-skilriki`) return json(200, { success: true, nationalId: KT })
    return json(404, {})
  })
}

async function startAndSettle(auditStore = memoryAudit()) {
  const started = await handleStartAttempt(makeReq({ ticket_id: TICKET, phoneNumberOrNationalId: KT }, { auditStore }))
  const { attemptId } = started.body as { attemptId: string }
  await settleEauth()
  return (await handleAttemptStatus(makeReq({ attemptId }))).body
}

beforeEach(() => {
  resetEauthState()
  clearJwksCache()
  clearAllTrTokens()
  clearEauthZendeskTokens()
})

describe('e-auth safety nets', () => {
  it('fails the attempt, not the gateway, when deciding the outcome throws', async () => {
    setup()
    vi.mocked(mapEidOutcome).mockImplementationOnce(() => { throw new Error('unexpected reply shape') })
    expect(await startAndSettle()).toMatchObject({ status: 'failed', reason: 'error' })
  })

  it('keeps the outcome when writing the note and audit throws', async () => {
    setup()
    vi.mocked(buildNote).mockImplementationOnce(() => { throw new Error('template broke') })
    const audit = memoryAudit()
    expect(await startAndSettle(audit)).toMatchObject({ status: 'verified', note: 'pending' })
    expect(audit.entries.size).toBe(0)
  })
})
