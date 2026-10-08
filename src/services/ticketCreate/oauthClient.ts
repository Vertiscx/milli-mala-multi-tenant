/**
 * Zendesk OAuth (Client Credentials grant) token fetch + in-memory cache
 * for the ticketCreate service.
 *
 * Same flow as services/ticketUpdate/oauthClient.ts, deliberately a
 * separate copy: services don't import each other, and this service uses
 * its own OAuth client, so its tokens must not share a cache with
 * ticketUpdate's (both are keyed by brand_id and would overwrite each other).
 */

import { createLogger, capBody } from '../../platform/logger.js'
import { fetchWithTimeout } from '../../platform/http.js'
import type { Logger } from '../../platform/types.js'
import type { ZendeskOAuthTokenResponse } from './types.js'

const logger: Logger = createLogger('ticketCreate.oauth')

// Least-privilege: creating a ticket needs tickets:write and nothing more.
const ZENDESK_OAUTH_SCOPE = 'tickets:write'

// Refresh well before actual expiry so a cached token can't expire in
// flight; floored so a very short expires_in still caches briefly.
const TOKEN_EXPIRY_BUFFER_MS = 60_000
const MIN_CACHE_TTL_MS = 30_000

interface CachedToken {
  accessToken: string
  expiresAt: number
}

// Keyed by brand_id — tokens are never shared across tenants.
const tokenCache = new Map<string, CachedToken>()

async function requestAccessToken(subdomain: string, clientId: string, clientSecret: string): Promise<ZendeskOAuthTokenResponse> {
  const url = `https://${subdomain}.zendesk.com/oauth/tokens`
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: ZENDESK_OAUTH_SCOPE
  })

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    logger.error('Zendesk OAuth token request failed', { status: response.status, body: capBody(text) })
    throw new Error(`Zendesk OAuth token request failed: ${response.status}`)
  }

  return response.json() as Promise<ZendeskOAuthTokenResponse>
}

/**
 * Fetch a fresh access token and replace whatever is cached for this
 * tenant. Used for the initial fetch and for the one retry after Zendesk
 * rejects a cached token with 401.
 */
export async function refreshAccessToken(
  brandId: string,
  subdomain: string,
  clientId: string,
  clientSecret: string
): Promise<string> {
  const token = await requestAccessToken(subdomain, clientId, clientSecret)
  const ttlMs = Math.max(token.expires_in * 1000 - TOKEN_EXPIRY_BUFFER_MS, MIN_CACHE_TTL_MS)
  tokenCache.set(brandId, { accessToken: token.access_token, expiresAt: Date.now() + ttlMs })
  logger.info('Fetched Zendesk OAuth access token', { brand_id: brandId })
  return token.access_token
}

/**
 * Return a cached, still-valid access token, or fetch a fresh one.
 */
export async function getAccessToken(
  brandId: string,
  subdomain: string,
  clientId: string,
  clientSecret: string
): Promise<string> {
  const cached = tokenCache.get(brandId)
  if (cached && Date.now() < cached.expiresAt) return cached.accessToken
  return refreshAccessToken(brandId, subdomain, clientId, clientSecret)
}
