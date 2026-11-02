/**
 * e-auth's own Zendesk access: the ticket brand check before a push, and
 * the internal note when an attempt ends.
 *
 * Client Credentials grant with e-auth's own OAuth settings and its own
 * token cache — same flow as ticketUpdate/ticketCreate, deliberately a
 * separate copy: services don't import each other. The note is therefore
 * authored by the integration user, with the verified agent named in the
 * text.
 */

import { createLogger, capBody } from '../../../platform/logger.js'
import { fetchWithTimeout } from '../../../platform/http.js'
import type { Logger, TrEauthConfig } from '../../../platform/types.js'

const logger: Logger = createLogger('tr.eauth.zendesk')

// Least-privilege: read the ticket's brand, write the note.
const ZENDESK_OAUTH_SCOPE = 'tickets:read tickets:write'
const TOKEN_EXPIRY_BUFFER_MS = 60_000
const MIN_CACHE_TTL_MS = 30_000

interface CachedToken {
  accessToken: string
  expiresAt: number
}

// Keyed by brand_id — tokens are never shared across tenants.
const tokenCache = new Map<string, CachedToken>()

/** Test seam. */
export function clearEauthZendeskTokens(): void {
  tokenCache.clear()
}

async function fetchToken(brandId: string, subdomain: string, oauth: TrEauthConfig['zendeskOAuth']): Promise<string> {
  const response = await fetchWithTimeout(`https://${subdomain}.zendesk.com/oauth/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret,
      scope: ZENDESK_OAUTH_SCOPE
    }).toString()
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    logger.error('Zendesk OAuth token request failed', { brand_id: brandId, status: response.status, body: capBody(text) })
    throw new Error(`Zendesk OAuth token request failed: ${response.status}`)
  }
  const token = await response.json() as { access_token?: unknown; expires_in?: unknown }
  if (typeof token.access_token !== 'string' || !token.access_token) {
    throw new Error('Zendesk OAuth token response had no access_token')
  }
  const expiresIn = typeof token.expires_in === 'number' ? token.expires_in : 0
  const ttlMs = Math.max(expiresIn * 1000 - TOKEN_EXPIRY_BUFFER_MS, MIN_CACHE_TTL_MS)
  tokenCache.set(brandId, { accessToken: token.access_token, expiresAt: Date.now() + ttlMs })
  return token.access_token
}

async function zendeskFetch(
  brandId: string,
  subdomain: string,
  oauth: TrEauthConfig['zendeskOAuth'],
  path: string,
  init: RequestInit
): Promise<Response> {
  const cached = tokenCache.get(brandId)
  let token = cached && Date.now() < cached.expiresAt ? cached.accessToken : await fetchToken(brandId, subdomain, oauth)
  const call = (t: string) => fetchWithTimeout(`https://${subdomain}.zendesk.com${path}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }
  })
  let response = await call(token)
  if (response.status === 401) {
    // A cached token can be revoked early; one fresh-token retry.
    token = await fetchToken(brandId, subdomain, oauth)
    response = await call(token)
  }
  return response
}

export type TicketCheck = 'ok' | 'brand_mismatch' | 'error'

/**
 * Fail-closed brand cross-check, like the archive service's: the ticket
 * must exist and belong to this tenant's brand. A missing ticket reads as
 * brand_mismatch so the answer never confirms another brand's ticket IDs.
 */
export async function checkTicketBrand(
  brandId: string,
  subdomain: string,
  oauth: TrEauthConfig['zendeskOAuth'],
  ticketId: string
): Promise<TicketCheck> {
  try {
    const response = await zendeskFetch(brandId, subdomain, oauth, `/api/v2/tickets/${ticketId}.json`, { method: 'GET' })
    if (response.status === 404) return 'brand_mismatch'
    if (!response.ok) {
      logger.warn('Ticket lookup failed', { brand_id: brandId, ticket_id: ticketId, status: response.status })
      return 'error'
    }
    const body = await response.json() as { ticket?: { brand_id?: unknown } }
    return String(body.ticket?.brand_id ?? '') === brandId ? 'ok' : 'brand_mismatch'
  } catch (err) {
    logger.warn('Ticket lookup failed', { brand_id: brandId, ticket_id: ticketId, error: (err as Error).message })
    return 'error'
  }
}

/** Writes a private comment. Returns true on success; never throws. */
export async function writeInternalNote(
  brandId: string,
  subdomain: string,
  oauth: TrEauthConfig['zendeskOAuth'],
  ticketId: string,
  body: string
): Promise<boolean> {
  try {
    const response = await zendeskFetch(brandId, subdomain, oauth, `/api/v2/tickets/${ticketId}.json`, {
      method: 'PUT',
      body: JSON.stringify({ ticket: { comment: { body, public: false } } })
    })
    if (!response.ok) {
      logger.warn('Internal note write failed', { brand_id: brandId, ticket_id: ticketId, status: response.status })
      return false
    }
    return true
  } catch (err) {
    logger.warn('Internal note write failed', { brand_id: brandId, ticket_id: ticketId, error: (err as Error).message })
    return false
  }
}
