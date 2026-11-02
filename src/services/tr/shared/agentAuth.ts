/**
 * Verifies the agent's own TR Auth0 access token.
 *
 * The TR Smári app signs the agent in through TR's Auth0 and sends the
 * access token as X-Agent-Token. The agent's email is taken from that
 * token, never from the request body, so a browser cannot choose who it
 * claims to be.
 *
 * Checks: RS256 only (pinned, no "none"/HS256 downgrade), signature
 * against TR's published JWKS, issuer, audience, exp/nbf with a small
 * clock skew, that the token was issued to the TR Smári app itself (azp),
 * that TR marked the email verified, and a well-formed email in the
 * configured claim. The azp and verified checks stop a token from another
 * TR Auth0 app, or from an account someone signed up with a colleague's
 * address, from passing as that colleague.
 *
 * Built on node:crypto rather than a JWT library to keep the dependency
 * surface unchanged.
 */

import { createPublicKey, verify, type KeyObject, type JsonWebKey } from 'node:crypto'
import { createLogger } from '../../../platform/logger.js'
import { fetchWithTimeout } from '../../../platform/http.js'
import type { Logger, TrServiceConfig } from '../../../platform/types.js'

const logger: Logger = createLogger('tr.agentAuth')

const CLOCK_SKEW_SECONDS = 60
const JWKS_TIMEOUT_MS = 10_000
const JWKS_MAX_AGE_MS = 24 * 60 * 60 * 1000
// An unknown kid triggers at most one JWKS refetch per minute, so a flood
// of forged tokens can't turn the gateway into a load generator on Auth0.
const JWKS_REFETCH_MIN_INTERVAL_MS = 60_000
const MAX_TOKEN_LENGTH = 8192
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface VerifiedAgent {
  email: string
}

interface JwksEntry {
  keys: Map<string, KeyObject>
  fetchedAt: number          // last successful fetch
}

// Keyed by Auth0 domain.
const jwksCache = new Map<string, JwksEntry>()
// Last download attempt per domain, successful or not, and the download
// in progress, if any.
const lastAttemptAt = new Map<string, number>()
const inFlight = new Map<string, Promise<void>>()

/** Test seam: forget cached signing keys. */
export function clearJwksCache(): void {
  jwksCache.clear()
  lastAttemptAt.clear()
  inFlight.clear()
}

async function fetchJwks(domain: string): Promise<Map<string, KeyObject>> {
  const response = await fetchWithTimeout(`https://${domain}/.well-known/jwks.json`, {}, JWKS_TIMEOUT_MS)
  if (!response.ok) throw new Error(`JWKS fetch failed: ${response.status}`)
  const body = await response.json() as { keys?: unknown }
  const keys = new Map<string, KeyObject>()
  for (const jwk of Array.isArray(body.keys) ? body.keys : []) {
    const k = jwk as JsonWebKey & { kid?: unknown; use?: unknown }
    if (k.kty !== 'RSA' || typeof k.kid !== 'string' || (k.use !== undefined && k.use !== 'sig')) continue
    try {
      keys.set(k.kid, createPublicKey({ key: k, format: 'jwk' }))
    } catch {
      // Skip a malformed key rather than reject the whole set.
    }
  }
  return keys
}

function refreshJwks(domain: string, now: number): void {
  lastAttemptAt.set(domain, now)
  const download = fetchJwks(domain)
    .then(keys => { jwksCache.set(domain, { keys, fetchedAt: Date.now() }) })
    .catch(err => { logger.warn('Could not fetch TR Auth0 signing keys', { domain, error: (err as Error).message }) })
    .finally(() => inFlight.delete(domain))
  inFlight.set(domain, download)
}

async function getSigningKey(domain: string, kid: string): Promise<KeyObject | null> {
  const now = Date.now()
  const entry = jwksCache.get(domain)
  if (entry && now - entry.fetchedAt < JWKS_MAX_AGE_MS && entry.keys.has(kid)) return entry.keys.get(kid)!

  // Unknown kid or an old set: download again, at most once a minute per
  // domain whatever the outcome, with concurrent callers sharing one
  // download. A failed download keeps the previous set rather than lock
  // every agent out.
  const lastAttempt = lastAttemptAt.get(domain)
  if (!inFlight.has(domain) && (lastAttempt === undefined || now - lastAttempt >= JWKS_REFETCH_MIN_INTERVAL_MS)) {
    refreshJwks(domain, now)
  }
  await inFlight.get(domain)
  return jwksCache.get(domain)?.keys.get(kid) ?? null
}

function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

/**
 * Returns the verified agent, or null for any token that fails a check.
 * Callers answer null with a bare 401 — the reason is logged, not returned.
 */
export async function verifyAgentToken(
  token: string | undefined,
  agentAuth: TrServiceConfig['agentAuth'],
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<VerifiedAgent | null> {
  if (!token || token.length > MAX_TOKEN_LENGTH) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [headerB64, payloadB64, signatureB64] = parts

  const header = decodeSegment(headerB64)
  const payload = decodeSegment(payloadB64)
  if (!header || !payload) return null
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') {
    logger.warn('Agent token rejected: unexpected alg or missing kid', { alg: String(header.alg).slice(0, 16) })
    return null
  }

  const key = await getSigningKey(agentAuth.domain, header.kid)
  if (!key) {
    logger.warn('Agent token rejected: unknown signing key')
    return null
  }

  const signed = Buffer.from(`${headerB64}.${payloadB64}`)
  const signature = Buffer.from(signatureB64, 'base64url')
  if (!verify('RSA-SHA256', signed, key, signature)) {
    logger.warn('Agent token rejected: bad signature')
    return null
  }

  if (payload.iss !== `https://${agentAuth.domain}/`) {
    logger.warn('Agent token rejected: wrong issuer')
    return null
  }
  const aud = payload.aud
  const audiences = Array.isArray(aud) ? aud : [aud]
  if (!audiences.includes(agentAuth.audience)) {
    logger.warn('Agent token rejected: wrong audience')
    return null
  }
  if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_SECONDS < nowSeconds) {
    logger.info('Agent token rejected: expired')
    return null
  }
  if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || payload.nbf - CLOCK_SKEW_SECONDS > nowSeconds)) {
    logger.warn('Agent token rejected: not yet valid')
    return null
  }

  if (payload.azp !== agentAuth.clientId) {
    logger.warn('Agent token rejected: issued to another application')
    return null
  }
  if (payload[agentAuth.emailVerifiedClaim] !== true) {
    logger.warn('Agent token rejected: email not verified')
    return null
  }

  const email = payload[agentAuth.emailClaim]
  if (typeof email !== 'string' || !EMAIL_PATTERN.test(email) || email.length > 254) {
    logger.warn('Agent token rejected: no usable email claim')
    return null
  }

  return { email: email.toLowerCase() }
}
