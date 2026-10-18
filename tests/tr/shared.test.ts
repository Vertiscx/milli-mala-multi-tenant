import { describe, it, expect, beforeEach } from 'vitest'
import { verifyAgentToken, clearJwksCache } from '../../src/services/tr/shared/agentAuth.js'
import { isValidKennitala, maskKennitala } from '../../src/services/tr/shared/kennitala.js'
import { postHuld } from '../../src/services/tr/shared/huldClient.js'
import { clearAllTrTokens } from '../../src/services/tr/shared/trAuth0.js'
import { authenticateTrRequest, isTrContext } from '../../src/services/tr/shared/request.js'
import {
  AGENT_AUDIENCE, AGENT_DOMAIN, BRAND, EMAIL_CLAIM, HULD, SPA_CLIENT_ID, TR_AUTH0_DOMAIN, VERIFIED_CLAIM,
  callsTo, installFetch, json, makeReq, makeTenant, makeTrConfig, signToken
} from './helpers.js'

const agentAuth = { domain: AGENT_DOMAIN, audience: AGENT_AUDIENCE, clientId: SPA_CLIENT_ID, emailClaim: EMAIL_CLAIM, emailVerifiedClaim: VERIFIED_CLAIM }

beforeEach(() => {
  clearJwksCache()
  clearAllTrTokens()
})

describe('kennitala helpers', () => {
  it('accepts a valid kennitala with or without a hyphen', () => {
    expect(isValidKennitala('1203894599')).toBe(true)
    expect(isValidKennitala('120389-4599')).toBe(true)
  })

  it('rejects a bad check digit and wrong lengths', () => {
    expect(isValidKennitala('1203894589')).toBe(false)
    expect(isValidKennitala('12038945')).toBe(false)
  })

  it('masks a kennitala for logs and audit', () => {
    expect(maskKennitala('1203894569')).toBe('120389-****')
  })
})

describe('verifyAgentToken', () => {
  beforeEach(() => { installFetch(() => json(404, {})) })

  it('accepts a valid token and returns the lower-cased email claim', async () => {
    expect(await verifyAgentToken(signToken(), agentAuth)).toEqual({ email: 'anna@tr.is' })
  })

  it('accepts a single-string audience', async () => {
    expect(await verifyAgentToken(signToken({ aud: AGENT_AUDIENCE }), agentAuth)).toEqual({ email: 'anna@tr.is' })
  })

  it('rejects a missing or malformed token', async () => {
    expect(await verifyAgentToken(undefined, agentAuth)).toBeNull()
    expect(await verifyAgentToken('not.a.jwt.at.all', agentAuth)).toBeNull()
    expect(await verifyAgentToken('abc', agentAuth)).toBeNull()
  })

  it('rejects a token signed with another key', async () => {
    expect(await verifyAgentToken(signToken({}, { wrongKey: true }), agentAuth)).toBeNull()
  })

  it('rejects alg downgrades (none, HS256)', async () => {
    const forged = signToken()
    const [, payload] = forged.split('.')
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', kid: 'test-kid-1' })).toString('base64url')}.${payload}.`
    expect(await verifyAgentToken(none, agentAuth)).toBeNull()
    expect(await verifyAgentToken(signToken({}, { header: { alg: 'HS256' } }), agentAuth)).toBeNull()
  })

  it('rejects a token whose payload was edited after signing', async () => {
    const [h, , s] = signToken().split('.')
    const edited = Buffer.from(JSON.stringify({ iss: `https://${AGENT_DOMAIN}/`, aud: AGENT_AUDIENCE, exp: 9999999999, [EMAIL_CLAIM]: 'boss@tr.is' })).toString('base64url')
    expect(await verifyAgentToken(`${h}.${edited}.${s}`, agentAuth)).toBeNull()
  })

  it('rejects wrong issuer, wrong audience, expiry and not-before', async () => {
    const now = Math.floor(Date.now() / 1000)
    expect(await verifyAgentToken(signToken({ iss: 'https://evil.auth0.com/' }), agentAuth)).toBeNull()
    expect(await verifyAgentToken(signToken({ aud: 'https://someone-else' }), agentAuth)).toBeNull()
    expect(await verifyAgentToken(signToken({ exp: now - 120 }), agentAuth)).toBeNull()
    expect(await verifyAgentToken(signToken({ nbf: now + 600 }), agentAuth)).toBeNull()
  })

  it('tolerates small clock skew on exp', async () => {
    const now = Math.floor(Date.now() / 1000)
    expect(await verifyAgentToken(signToken({ exp: now - 30 }), agentAuth)).toEqual({ email: 'anna@tr.is' })
  })

  it('rejects a token issued to another TR Auth0 application (azp)', async () => {
    expect(await verifyAgentToken(signToken({ azp: 'citizen-portal-client' }), agentAuth)).toBeNull()
    expect(await verifyAgentToken(signToken({ azp: undefined }), agentAuth)).toBeNull()
  })

  it('rejects an email TR has not marked verified', async () => {
    expect(await verifyAgentToken(signToken({ [VERIFIED_CLAIM]: false }), agentAuth)).toBeNull()
    expect(await verifyAgentToken(signToken({ [VERIFIED_CLAIM]: 'true' }), agentAuth)).toBeNull()
    expect(await verifyAgentToken(signToken({ [VERIFIED_CLAIM]: undefined }), agentAuth)).toBeNull()
  })

  it('rejects a token without a usable email claim', async () => {
    expect(await verifyAgentToken(signToken({ [EMAIL_CLAIM]: undefined }), agentAuth)).toBeNull()
    expect(await verifyAgentToken(signToken({ [EMAIL_CLAIM]: 'not-an-email' }), agentAuth)).toBeNull()
  })

  it('caches JWKS and does not refetch for every request', async () => {
    const mock = installFetch(() => json(404, {}))
    await verifyAgentToken(signToken(), agentAuth)
    await verifyAgentToken(signToken(), agentAuth)
    expect(callsTo(mock, `https://${AGENT_DOMAIN}/`)).toHaveLength(1)
  })

  it('throttles key downloads while Auth0 is failing, including before the first success', async () => {
    const mock = installFetch(() => json(404, {}))
    mock.mockImplementation(async () => json(503, {}))
    for (let i = 0; i < 5; i++) expect(await verifyAgentToken(signToken(), agentAuth)).toBeNull()
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('shares one key download between concurrent requests', async () => {
    const mock = installFetch(() => json(404, {}))
    const results = await Promise.all(Array.from({ length: 10 }, () => verifyAgentToken(signToken(), agentAuth)))
    expect(results.every(r => r?.email === 'anna@tr.is')).toBe(true)
    expect(callsTo(mock, `https://${AGENT_DOMAIN}/`)).toHaveLength(1)
  })

  it('refetches at most once a minute for unknown kids', async () => {
    const mock = installFetch(() => json(404, {}))
    await verifyAgentToken(signToken(), agentAuth)
    expect(await verifyAgentToken(signToken({}, { header: { kid: 'unknown' } }), agentAuth)).toBeNull()
    expect(await verifyAgentToken(signToken({}, { header: { kid: 'unknown-2' } }), agentAuth)).toBeNull()
    expect(callsTo(mock, `https://${AGENT_DOMAIN}/`)).toHaveLength(1)
  })
})

describe('authenticateTrRequest', () => {
  beforeEach(() => { installFetch(() => json(404, {})) })

  it('passes a request with the right key and a valid agent token', async () => {
    const ctx = await authenticateTrRequest(makeReq({}), 'smari')
    expect(isTrContext(ctx) && ctx.agent.email).toBe('anna@tr.is')
  })

  it('returns a neutral 400 when the tenant has no TR section or the sub-service is off', async () => {
    expect(await authenticateTrRequest(makeReq({}, { tenant: { ...makeTenant(), services: {} } }), 'smari'))
      .toEqual({ status: 400, body: { error: 'Invalid request' } })
    expect(await authenticateTrRequest(makeReq({}, { tenant: makeTenant(makeTrConfig({ smari: undefined })) }), 'smari'))
      .toEqual({ status: 400, body: { error: 'Invalid request' } })
  })

  it('returns 401 for a wrong or missing API key, before looking at the token', async () => {
    const mock = installFetch(() => json(404, {}))
    expect(await authenticateTrRequest(makeReq({}, { apiKey: 'wrong' }), 'smari')).toEqual({ status: 401, body: { error: 'Unauthorized' } })
    expect(await authenticateTrRequest(makeReq({}, { apiKey: null }), 'smari')).toEqual({ status: 401, body: { error: 'Unauthorized' } })
    expect(mock).not.toHaveBeenCalled()
  })

  it('returns 401 for a missing or invalid agent token', async () => {
    expect(await authenticateTrRequest(makeReq({}, { token: null }), 'smari')).toEqual({ status: 401, body: { error: 'Unauthorized' } })
    expect(await authenticateTrRequest(makeReq({}, { token: signToken({}, { wrongKey: true }) }), 'smari')).toEqual({ status: 401, body: { error: 'Unauthorized' } })
  })
})

describe('postHuld', () => {
  const tr = makeTrConfig()

  it('sends the Auth0 bearer token and returns parsed data', async () => {
    const mock = installFetch(() => json(200, { ok: 1 }))
    const result = await postHuld(BRAND, tr, '/clientlookup', { a: 1 }, { timeoutMs: 1000, retryOn401: true })
    expect(result).toEqual({ ok: true, status: 200, data: { ok: 1 } })
    const [[url, init]] = callsTo(mock, HULD)
    expect(url).toBe(`${HULD}/clientlookup`)
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tr-access-token')
  })

  it('retries once on 401 with a fresh token when allowed', async () => {
    let n = 0
    const mock = installFetch(() => (++n === 1 ? json(401, {}) : json(200, { ok: 1 })))
    const result = await postHuld(BRAND, tr, '/clientlookup', {}, { timeoutMs: 1000, retryOn401: true })
    expect(result.ok).toBe(true)
    expect(callsTo(mock, HULD)).toHaveLength(2)
    expect(callsTo(mock, `https://${TR_AUTH0_DOMAIN}/`)).toHaveLength(2)
  })

  it('never retries when retryOn401 is false', async () => {
    const mock = installFetch(() => json(401, {}))
    const result = await postHuld(BRAND, tr, '/authentication/rafraen-skilriki', {}, { timeoutMs: 1000, retryOn401: false })
    expect(result).toMatchObject({ ok: false, kind: 'http', status: 401 })
    expect(callsTo(mock, HULD)).toHaveLength(1)
  })

  it('reports auth failure when TR Auth0 refuses the token', async () => {
    const mock = installFetch(() => json(200, {}))
    mock.mockImplementation(async (input: string | URL | Request) =>
      String(input) === `https://${TR_AUTH0_DOMAIN}/oauth/token` ? json(403, {}) : json(200, {}))
    const result = await postHuld(BRAND, tr, '/clientlookup', {}, { timeoutMs: 1000, retryOn401: true })
    expect(result).toEqual({ ok: false, kind: 'auth' })
    expect(callsTo(mock, HULD)).toHaveLength(0)
  })

  it('reports a timeout and an abort distinctly', async () => {
    installFetch((_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    expect(await postHuld(BRAND, tr, '/x', {}, { timeoutMs: 20, retryOn401: false })).toEqual({ ok: false, kind: 'timeout' })
    const controller = new AbortController()
    const pending = postHuld(BRAND, tr, '/x', {}, { timeoutMs: 5000, retryOn401: false, signal: controller.signal })
    await new Promise(r => setTimeout(r, 10)) // let the call reach Huld
    controller.abort()
    expect(await pending).toEqual({ ok: false, kind: 'aborted' })
  })

  it('does not call Huld at all when cancelled before the call starts', async () => {
    const mock = installFetch(() => json(200, {}))
    const controller = new AbortController()
    controller.abort()
    expect(await postHuld(BRAND, tr, '/x', {}, { timeoutMs: 1000, retryOn401: false, signal: controller.signal }))
      .toEqual({ ok: false, kind: 'aborted' })
    expect(callsTo(mock, HULD)).toHaveLength(0)
  })
})
