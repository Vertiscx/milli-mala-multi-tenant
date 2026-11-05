/**
 * Zendesk API Client - fetches tickets, comments, and attachments
 *
 * Two ways to sign in, chosen per tenant (see createZendeskClient):
 *  - Basic: the admin email plus an API token (every archive tenant
 *    before Zendesk stopped issuing new API tokens).
 *  - OAuth: a Client Credentials token from a Confidential OAuth client,
 *    cached per brand and refreshed once when Zendesk answers 401.
 */

import { createLogger, capBody } from './logger.js'
import { fetchWithTimeout } from './http.js'
import type { TenantConfig, ZendeskTicket, ZendeskComment, ZendeskUser, DownloadedAttachment, AttachmentsResult, Logger } from './types.js'

const logger: Logger = createLogger('zendesk')

// Least privilege for everything the archive service does in Zendesk:
// read the ticket and comments (tickets:read), read comment authors via
// users/show_many (users:read), stamp fields and post the result note
// (tickets:write). Confirmed on d3v (2026-11-04).
export const ZENDESK_ARCHIVE_OAUTH_SCOPE = 'tickets:read tickets:write users:read'

// Refresh well before actual expiry so a cached token can't expire in
// flight; floored so a very short expires_in still caches briefly.
const TOKEN_EXPIRY_BUFFER_MS = 60_000
const MIN_CACHE_TTL_MS = 30_000

export interface ZendeskOAuthCredentials {
  /** Cache key: tokens are never shared across tenants. */
  brandId: string
  clientId: string
  clientSecret: string
}

interface CachedToken {
  accessToken: string
  expiresAt: number
}

// Platform-owned cache, keyed by brand_id. Separate from the ticketCreate,
// ticketUpdate and userUpdate caches, which hold tokens of other OAuth
// clients with other scopes.
const tokenCache = new Map<string, CachedToken>()

async function fetchAccessToken(subdomain: string, oauth: ZendeskOAuthCredentials): Promise<string> {
  const response = await fetchWithTimeout(`https://${subdomain}.zendesk.com/oauth/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret,
      scope: ZENDESK_ARCHIVE_OAUTH_SCOPE
    }).toString()
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    logger.error('Zendesk OAuth token request failed', {
      brand_id: oauth.brandId, status: response.status, body: capBody(text)
    })
    throw new Error(`Zendesk OAuth token request failed: ${response.status}`)
  }
  const token = await response.json() as { access_token?: unknown; expires_in?: unknown }
  if (typeof token.access_token !== 'string' || !token.access_token) {
    logger.error('Zendesk OAuth token response had no access_token', { brand_id: oauth.brandId })
    throw new Error('Zendesk OAuth token response had no access_token')
  }
  const expiresInMs = typeof token.expires_in === 'number' ? token.expires_in * 1000 : 0
  const ttlMs = Math.max(expiresInMs - TOKEN_EXPIRY_BUFFER_MS, MIN_CACHE_TTL_MS)
  tokenCache.set(oauth.brandId, { accessToken: token.access_token, expiresAt: Date.now() + ttlMs })
  logger.info('Fetched Zendesk OAuth access token', { brand_id: oauth.brandId })
  return token.access_token
}

async function getAccessToken(subdomain: string, oauth: ZendeskOAuthCredentials): Promise<string> {
  const cached = tokenCache.get(oauth.brandId)
  if (cached && Date.now() < cached.expiresAt) return cached.accessToken
  return fetchAccessToken(subdomain, oauth)
}

export class ZendeskClient {
  baseUrl: string
  /** Base64 Basic credential; undefined for an OAuth client. */
  auth: string | undefined
  private subdomain: string
  private oauth: ZendeskOAuthCredentials | undefined

  constructor(subdomain: string, apiToken: string, email: string)
  constructor(subdomain: string, oauth: ZendeskOAuthCredentials)
  constructor(subdomain: string, credential: string | ZendeskOAuthCredentials, email?: string) {
    this.subdomain = subdomain
    this.baseUrl = `https://${subdomain}.zendesk.com/api/v2`
    if (typeof credential === 'string') {
      this.auth = Buffer.from(`${email}/token:${credential}`).toString('base64')
    } else {
      this.oauth = credential
    }
  }

  private async authorization(fresh = false): Promise<string> {
    if (!this.oauth) return `Basic ${this.auth}`
    const token = fresh
      ? await fetchAccessToken(this.subdomain, this.oauth)
      : await getAccessToken(this.subdomain, this.oauth)
    return `Bearer ${token}`
  }

  /**
   * Send an API request. For an OAuth client a 401 means the cached token
   * was revoked or expired early: fetch a fresh one and retry once. A 401
   * is a rejection before Zendesk applied anything, so retrying a write
   * is safe.
   */
  private async send(url: string, init: { method?: string; body?: string }): Promise<Response> {
    const attempt = async (fresh: boolean) => fetchWithTimeout(url, {
      ...init,
      headers: { 'Authorization': await this.authorization(fresh), 'Content-Type': 'application/json' }
    })
    const response = await attempt(false)
    if (response.status === 401 && this.oauth) {
      logger.warn('Zendesk rejected the OAuth token; retrying with a fresh one', { brand_id: this.oauth.brandId })
      return attempt(true)
    }
    return response
  }

  /**
   * Build the thrown error for a non-ok response. statusText is empty
   * over HTTP/2, so the (truncated) response body is the only place
   * Zendesk's actual error detail (e.g. which field was invalid) lives.
   */
  private async apiError(response: Response): Promise<Error> {
    let detail = ''
    try {
      detail = (await response.text()).slice(0, 500)
    } catch { /* body unreadable — status-only message */ }
    return new Error(`Zendesk API error: ${response.status}${detail ? ` - ${detail}` : ''}`)
  }

  async request(endpoint: string): Promise<Record<string, unknown>> {
    const response = await this.send(`${this.baseUrl}${endpoint}`, {})
    if (!response.ok) {
      throw await this.apiError(response)
    }
    return response.json() as Promise<Record<string, unknown>>
  }

  async requestWrite(
    endpoint: string,
    method: 'PUT' | 'POST',
    body: unknown
  ): Promise<Record<string, unknown>> {
    const response = await this.send(`${this.baseUrl}${endpoint}`, { method, body: JSON.stringify(body) })
    if (!response.ok) {
      throw await this.apiError(response)
    }
    return response.json() as Promise<Record<string, unknown>>
  }

  async setTicketCustomField(
    ticketId: number,
    fieldId: number,
    value: string | number | boolean | null
  ): Promise<void> {
    await this.requestWrite(
      `/tickets/${ticketId}.json`,
      'PUT',
      { ticket: { custom_fields: [{ id: fieldId, value }] } }
    )
  }

  async getTicket(ticketId: number): Promise<ZendeskTicket> {
    const data = await this.request(`/tickets/${ticketId}.json`)
    return data.ticket as ZendeskTicket
  }

  async getTicketComments(ticketId: number): Promise<ZendeskComment[]> {
    const data = await this.request(`/tickets/${ticketId}/comments.json`)
    return (data.comments as ZendeskComment[]) || []
  }

  async getUser(userId: number): Promise<ZendeskUser> {
    const data = await this.request(`/users/${userId}.json`)
    return data.user as ZendeskUser
  }

  async getUsersMany(userIds: number[]): Promise<ZendeskUser[]> {
    if (!userIds.length) return []
    const data = await this.request(`/users/show_many.json?ids=${userIds.join(',')}`)
    return (data.users as ZendeskUser[]) || []
  }

  /**
   * Returns the downloaded attachments AS the array (byte-compatible with
   * the pre-G4 array contract — `.length`, indexing, `toEqual([])` all
   * unchanged). The list of attachments that were skipped/failed to
   * download is exposed via a NON-ENUMERABLE `.failed` property so
   * structural array equality in the pre-g3 test suite is unaffected,
   * while G4 callers can read `.failed` for the GW-01 post-back note.
   */
  async fetchAttachments(
    comments: ZendeskComment[],
    { maxFiles = 50, maxTotalBytes = 100 * 1024 * 1024 }: { maxFiles?: number; maxTotalBytes?: number } = {}
  ): Promise<AttachmentsResult> {
    const attachments: DownloadedAttachment[] = []
    const failed: { filename: string; reason: string }[] = []
    let totalBytes = 0
    const finalize = (): AttachmentsResult => {
      Object.defineProperty(attachments, 'failed', {
        value: failed, enumerable: false, configurable: true, writable: true
      })
      return attachments as AttachmentsResult
    }
    // Flatten so limit early-exits can record every remaining file in
    // `failed` — a skipped attachment must be visible to callers (note +
    // audit), never silently dropped.
    const all = comments.flatMap(c => c.attachments ?? [])
    for (let i = 0; i < all.length; i++) {
      const att = all[i]
      if (attachments.length >= maxFiles) {
        logger.warn('Attachment count limit reached', { maxFiles, skipped: all.length - i })
        for (const rest of all.slice(i)) {
          failed.push({ filename: rest.file_name, reason: 'file count limit reached' })
        }
        return finalize()
      }
      try {
        // SSRF protection: only allow genuine Zendesk URLs
        const attUrl = new URL(att.content_url)
        if (attUrl.protocol !== 'https:') {
          logger.warn('Skipping non-HTTPS attachment URL', { url: att.content_url })
          failed.push({ filename: att.file_name, reason: 'non-HTTPS URL' })
          continue
        }
        // Proper domain check: extract the last two labels and compare exactly.
        // This prevents bypasses like "evil-zendesk.com" matching ".zendesk.com".
        const hostParts = attUrl.hostname.split('.')
        const domain = hostParts.slice(-2).join('.')
        if (domain !== 'zendesk.com' && domain !== 'zdassets.com') {
          logger.warn('Skipping non-Zendesk attachment URL', { url: att.content_url })
          failed.push({ filename: att.file_name, reason: 'non-Zendesk URL' })
          continue
        }
        // An OAuth token gets 403 on attachment URLs, while the URL itself
        // works without any auth as long as the account's "Allow secure
        // downloads" setting is off (checked on d3v, 2026-11-04). So an
        // OAuth client sends no Authorization header here; if that
        // setting is ever turned on, downloads fail and show up in the
        // result note and the audit entry.
        const response = await fetchWithTimeout(att.content_url, this.oauth
          ? {}
          : { headers: { 'Authorization': `Basic ${this.auth}` } })
        if (!response.ok) {
          logger.warn('Attachment download returned non-OK status', {
            filename: att.file_name, status: response.status
          })
          failed.push({ filename: att.file_name, reason: `download status ${response.status}` })
          continue
        }
        const buffer = Buffer.from(await response.arrayBuffer())
        if (totalBytes + buffer.length > maxTotalBytes) {
          logger.warn('Attachment total size limit reached', {
            maxTotalBytes, currentBytes: totalBytes, skipped: all.length - i
          })
          for (const rest of all.slice(i)) {
            failed.push({ filename: rest.file_name, reason: 'total size limit reached' })
          }
          return finalize()
        }
        totalBytes += buffer.length
        attachments.push({
          filename: att.file_name,
          contentType: att.content_type,
          size: att.size,
          data: buffer
        })
        logger.debug('Downloaded attachment', { filename: att.file_name, size: att.size })
      } catch (error) {
        logger.warn('Failed to download attachment', { filename: att.file_name, error: (error as Error).message })
        failed.push({ filename: att.file_name, reason: 'download error' })
      }
    }
    return finalize()
  }
}

/**
 * Build the archive service's Zendesk client for a tenant: OAuth when the
 * tenant's zendesk block has `oauth`, otherwise Basic with email and API
 * token. validateArchiveConfig guarantees exactly one of the two is set
 * for every archive tenant.
 */
export function createZendeskClient(tenantConfig: TenantConfig): ZendeskClient {
  const z = tenantConfig.zendesk
  if (z.oauth) {
    return new ZendeskClient(z.subdomain, {
      brandId: tenantConfig.brand_id,
      clientId: z.oauth.clientId,
      clientSecret: z.oauth.clientSecret
    })
  }
  if (!z.apiToken || !z.email) {
    throw new Error('Zendesk credentials missing: need oauth, or email and apiToken')
  }
  return new ZendeskClient(z.subdomain, z.apiToken, z.email)
}
