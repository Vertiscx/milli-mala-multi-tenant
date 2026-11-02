/**
 * Auth0 Client Credentials token for TR's Huld API, cached in memory per
 * tenant. Replaces the browser-side fetch in tr-smari/src/tr/auth.ts: the
 * client secret now lives only in the gateway's env vars.
 */

import { createLogger, capBody } from '../../../platform/logger.js'
import { fetchWithTimeout } from '../../../platform/http.js'
import type { Logger, TrServiceConfig } from '../../../platform/types.js'

const logger: Logger = createLogger('tr.auth0')

// Refresh well before expiry so a cached token can't expire in flight.
const TOKEN_EXPIRY_BUFFER_MS = 60_000
const MIN_CACHE_TTL_MS = 30_000
const TOKEN_TIMEOUT_MS = 10_000

interface CachedToken {
  accessToken: string
  expiresAt: number
}

// Keyed by brand_id — tokens are never shared across tenants.
const tokenCache = new Map<string, CachedToken>()

export function clearTrToken(brandId: string): void {
  tokenCache.delete(brandId)
}

/** Test seam: forget every cached token. */
export function clearAllTrTokens(): void {
  tokenCache.clear()
}

export async function getTrAccessToken(brandId: string, auth0: TrServiceConfig['auth0']): Promise<string> {
  const cached = tokenCache.get(brandId)
  if (cached && Date.now() < cached.expiresAt) return cached.accessToken

  const response = await fetchWithTimeout(`https://${auth0.domain}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: auth0.clientId,
      client_secret: auth0.clientSecret,
      audience: auth0.audience
    })
  }, TOKEN_TIMEOUT_MS)

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    logger.error('TR Auth0 token request failed', { brand_id: brandId, status: response.status, body: capBody(text) })
    throw new Error(`TR Auth0 token request failed: ${response.status}`)
  }

  const token = await response.json() as { access_token?: unknown; expires_in?: unknown }
  if (typeof token.access_token !== 'string' || !token.access_token) {
    throw new Error('TR Auth0 token response had no access_token')
  }
  const expiresIn = typeof token.expires_in === 'number' ? token.expires_in : 300
  const ttlMs = Math.max(expiresIn * 1000 - TOKEN_EXPIRY_BUFFER_MS, MIN_CACHE_TTL_MS)
  tokenCache.set(brandId, { accessToken: token.access_token, expiresAt: Date.now() + ttlMs })
  logger.info('Fetched TR Auth0 access token', { brand_id: brandId })
  return token.access_token
}
