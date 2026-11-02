/**
 * POST /v1/users/update — update an end user in Zendesk on behalf of a
 * system outside Zendesk, authenticated to Zendesk via the tenant's
 * userUpdate OAuth client (Client Credentials grant).
 *
 * Payload: { "user": { "brand_id": ..., "id" | "email": ..., <fields> } }.
 * brand_id selects the tenant. Exactly one of id (the Zendesk user ID) or
 * email identifies the user; neither is sent to Zendesk as a change. By id
 * the user is read directly; by email Zendesk's user search is used and
 * only exact matches (ignoring case) count, since a search can return
 * near-matches. Exactly one user must match.
 *
 * The user must be an end user. The OAuth client acts as an admin, so
 * Zendesk itself would let an agent or admin be changed; this check is
 * what stops it. A user that doesn't exist and one that isn't an end user
 * get the same 404, so the endpoint never reveals that an email or ID
 * belongs to an agent.
 *
 * Users belong to the Zendesk account, not to a brand, and the tenants
 * share one account. Any tenant with a key can therefore update any end
 * user on that account — a deliberate decision (ARCHITECTURE.md §9).
 *
 * Every other field in `user` is passed to Zendesk as sent, except those
 * that change who the user is or what they can do, which are always
 * dropped (ALWAYS_DROPPED_FIELDS) and listed in the response.
 *
 * Like ticketCreate, this route resolves the tenant itself because
 * brand_id sits inside `user`, not at the top level of the body.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createLogger } from '../../platform/logger.js'
import { fetchWithTimeout } from '../../platform/http.js'
import { resolveTenantConfig, type TenantStore } from '../../platform/tenant.js'
import { getAccessToken, refreshAccessToken } from './oauthClient.js'
import type { Logger } from '../../platform/types.js'
import type { UserUpdateHttpRequest, UserUpdateResult, ZendeskUserRecord } from './types.js'

const logger: Logger = createLogger('userUpdate')

const MAX_BODY_SIZE = 1024 * 1024 // 1MB — matches every other JSON route in this repo
const MAX_EMAIL_LENGTH = 254

// Fields that change who the user is or what they can do. The tenants
// share one Zendesk account, so none of them may come from a caller.
const ALWAYS_DROPPED_FIELDS = [
  'role', 'custom_role_id', 'organization_id', 'organization', 'suspended', 'verified',
  'external_id', 'identities', 'moderator', 'ticket_restriction', 'agent_brand_ids',
  'default_group_id', 'only_private_comments', 'signature', 'shared_phone_number'
] as const

const NOT_FOUND: UserUpdateResult = { status: 404, body: { error: 'User not found' } }

class TokenFetchError extends Error {}

// Same check as ticketCreate's API key (SHA-256, then a constant-time
// compare), duplicated rather than imported: services don't import each other.
function verifyApiKey(provided: string | undefined, expected: string): boolean {
  if (!provided) return false
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A Zendesk user ID from the request (number or digit string), or null. */
function parseUserId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  if (typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)) return value
  return null
}

function isValidEmail(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length <= MAX_EMAIL_LENGTH &&
    /^[^\s@]+@[^\s@]+$/.test(value)
}

/**
 * Build the user fields sent to Zendesk: remove what only addresses the
 * request (brand_id, id, email) and drop the restricted fields. Returns
 * the names of the fields that were dropped.
 */
function prepareFields(user: Record<string, unknown>): { fields: Record<string, unknown>; dropped: string[] } {
  const { brand_id: _brandId, id: _id, email: _email, ...fields } = user
  const dropped: string[] = []
  for (const name of ALWAYS_DROPPED_FIELDS) {
    if (name in fields) {
      delete fields[name]
      dropped.push(name)
    }
  }
  return { fields, dropped }
}

// Zendesk's validation messages can echo submitted values (a name, a
// phone number), so only the error code and the names of the offending
// fields are logged — never the descriptions.
function summarizeZendeskError(text: string): { zendesk_error?: string; zendesk_error_fields?: string[] } {
  try {
    const parsed = JSON.parse(text) as { error?: unknown; details?: unknown }
    return {
      zendesk_error: typeof parsed.error === 'string' ? parsed.error : undefined,
      zendesk_error_fields: isPlainObject(parsed.details) ? Object.keys(parsed.details) : undefined
    }
  } catch {
    return {}
  }
}

// Zendesk's Retry-After is a number of seconds; anything else is not passed on.
function retryAfterHeader(response: Response): Record<string, string> | undefined {
  const value = response.headers.get('retry-after')
  return value && /^\d{1,6}$/.test(value) ? { 'Retry-After': value } : undefined
}

/**
 * Handle one request. A pure function of (body, headers, tenantStore), no
 * Node HTTP types involved, so it is testable like handleTicketCreate.
 */
export async function handleUserUpdate(req: UserUpdateHttpRequest, tenantStore: TenantStore): Promise<UserUpdateResult> {
  const { body, headers } = req
  const startTime = Date.now()

  // The body is parsed JSON, so it may be null, an array or a scalar.
  const user = isPlainObject(body) ? body.user : undefined
  if (!isPlainObject(user)) {
    return { status: 400, body: { error: 'Missing user' } }
  }

  const brandId = user.brand_id != null ? String(user.brand_id) : undefined
  if (!brandId) {
    return { status: 400, body: { error: 'Missing user.brand_id' } }
  }

  const tenantConfig = await resolveTenantConfig(brandId, tenantStore)
  if (!tenantConfig) return { status: 400, body: { error: 'Invalid request' } }

  const userUpdateConfig = tenantConfig.services?.userUpdate
  if (!userUpdateConfig) return { status: 400, body: { error: 'Invalid request' } }

  if (!verifyApiKey(headers['x-api-key'], userUpdateConfig.apiKey)) {
    logger.warn('User update API key verification failed', { brand_id: brandId })
    return { status: 401, body: { error: 'Invalid or missing API key' } }
  }

  const hasId = user.id != null
  const hasEmail = user.email != null
  if (hasId === hasEmail) {
    return { status: 400, body: { error: 'Provide exactly one of user.id or user.email' } }
  }

  const userId = hasId ? parseUserId(user.id) : null
  if (hasId && !userId) return { status: 400, body: { error: 'Invalid user.id' } }
  if (hasEmail && !isValidEmail(user.email)) return { status: 400, body: { error: 'Invalid user.email' } }
  const email = hasEmail ? (user.email as string) : null

  const { fields, dropped } = prepareFields(user)
  if (Object.keys(fields).length === 0) {
    return { status: 400, body: { error: 'No fields to update', dropped_fields: dropped } }
  }

  const lookup = hasId ? 'id' : 'email'
  logger.info('User update request', { brand_id: brandId, lookup, fields: Object.keys(fields), dropped_fields: dropped })

  try {
    const { subdomain } = tenantConfig.zendesk
    const { clientId, clientSecret } = userUpdateConfig.oauth

    let accessToken: string
    try {
      accessToken = await getAccessToken(brandId, subdomain, clientId, clientSecret)
    } catch (err) {
      logger.error('Zendesk OAuth token fetch failed', { brand_id: brandId, error: (err as Error).message })
      return { status: 502, body: { error: 'Zendesk authentication failed' } }
    }

    // Every Zendesk call gets one retry with a fresh token after a 401:
    // the token was rejected, so nothing was read or changed.
    const callZendesk = async (path: string, init: RequestInit = {}): Promise<Response> => {
      const send = (token: string) => fetchWithTimeout(`https://${subdomain}.zendesk.com/api/v2${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      })
      const response = await send(accessToken)
      if (response.status !== 401) return response
      logger.info('Zendesk rejected cached token, retrying with a fresh one', { brand_id: brandId })
      try {
        accessToken = await refreshAccessToken(brandId, subdomain, clientId, clientSecret)
      } catch (err) {
        logger.error('Zendesk OAuth token refresh failed', { brand_id: brandId, error: (err as Error).message })
        throw new TokenFetchError()
      }
      return send(accessToken)
    }

    // ─── Find the user ────────────────────────────────────────────────
    let lookupResponse: Response
    try {
      lookupResponse = userId
        ? await callZendesk(`/users/${userId}.json`)
        : await callZendesk(`/users/search.json?${new URLSearchParams({ query: `email:${email}` })}`)
    } catch (err) {
      if (err instanceof TokenFetchError) return { status: 502, body: { error: 'Zendesk authentication failed' } }
      throw err
    }

    if (!lookupResponse.ok) {
      if (userId && lookupResponse.status === 404) return NOT_FOUND
      const text = await lookupResponse.text().catch(() => '')
      logger.error('Zendesk user lookup failed', {
        brand_id: brandId, lookup, status: lookupResponse.status, ...summarizeZendeskError(text)
      })
      if (lookupResponse.status === 429) {
        return { status: 429, body: { error: 'Too many requests' }, headers: retryAfterHeader(lookupResponse) }
      }
      return { status: 502, body: { error: 'Zendesk user lookup failed' } }
    }

    const lookupBody = (await lookupResponse.json().catch(() => ({}))) as { user?: unknown; users?: unknown }
    let target: ZendeskUserRecord | undefined
    if (userId) {
      target = isPlainObject(lookupBody.user) ? (lookupBody.user as unknown as ZendeskUserRecord) : undefined
    } else {
      // A search can return near-matches; only an exact address counts.
      const wanted = email!.toLowerCase()
      const matches = (Array.isArray(lookupBody.users) ? lookupBody.users : [])
        .filter((u): u is ZendeskUserRecord =>
          isPlainObject(u) && typeof u.email === 'string' && u.email.toLowerCase() === wanted)
      if (matches.length > 1) {
        logger.warn('Email matches more than one user', { brand_id: brandId, matches: matches.length })
        return { status: 409, body: { error: 'Email matches more than one user' } }
      }
      target = matches[0]
    }

    if (!target || typeof target.id !== 'number') return NOT_FOUND
    if (target.role !== 'end-user') {
      // Same answer as "not found", so the endpoint never reveals agents.
      logger.warn('User update refused: not an end user', { brand_id: brandId, user_id: target.id })
      return NOT_FOUND
    }

    // ─── Update the user ──────────────────────────────────────────────
    let updateResponse: Response
    try {
      updateResponse = await callZendesk(`/users/${target.id}.json`, {
        method: 'PUT',
        body: JSON.stringify({ user: fields })
      })
    } catch (err) {
      if (err instanceof TokenFetchError) return { status: 502, body: { error: 'Zendesk authentication failed' } }
      throw err
    }

    if (!updateResponse.ok) {
      const text = await updateResponse.text().catch(() => '')
      logger.error('Zendesk user update failed', {
        brand_id: brandId, user_id: target.id, status: updateResponse.status, ...summarizeZendeskError(text)
      })
      // Zendesk allows 5 updates of one user per minute.
      if (updateResponse.status === 429) {
        return { status: 429, body: { error: 'Too many updates for this user' }, headers: retryAfterHeader(updateResponse) }
      }
      // Zendesk refusing the change itself can never succeed unchanged,
      // so it must not look like the retryable 502 below.
      if (updateResponse.status === 422) {
        return { status: 422, body: { error: 'User rejected by Zendesk validation' } }
      }
      return { status: 502, body: { error: 'Zendesk user update failed' } }
    }

    const duration = Date.now() - startTime
    logger.info('User updated', { brand_id: brandId, user_id: target.id, duration_ms: duration })

    // Only the user's ID goes back — never its details.
    return {
      status: 200,
      body: {
        success: true,
        user_id: target.id,
        brand_id: tenantConfig.brand_id,
        dropped_fields: dropped
      }
    }
  } catch (error) {
    // e.g. a network error or timeout. An update of the same fields is
    // safe to repeat, so the caller can retry.
    logger.error('User update request failed', { brand_id: brandId, error: (error as Error).message })
    return { status: 500, body: { error: 'Internal server error', duration_ms: Date.now() - startTime } }
  }
}

// ─── Node HTTP adapter ────────────────────────────────────────────────

function readRawBody(req: IncomingMessage, maxSize: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxSize) {
        req.destroy()
        reject(new Error('Request body too large'))
        return
      }
      body += chunk
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json', ...extraHeaders })
  res.end(JSON.stringify(data))
}

/**
 * Node HTTP entry point, registered directly in index.ts (like
 * /v1/tickets/create) because brand_id is nested inside `user`.
 */
export async function handleUserUpdateHttp(req: IncomingMessage, res: ServerResponse, tenantStore: TenantStore): Promise<void> {
  let brandId: string | undefined
  try {
    const rawBody = await readRawBody(req, MAX_BODY_SIZE)
    let body: Record<string, unknown>
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>
    } catch {
      return sendJson(res, 400, { error: 'Invalid JSON body' })
    }
    // Kept so even the catch-all log line below carries brand_id.
    const user = isPlainObject(body) ? body.user : undefined
    if (isPlainObject(user) && user.brand_id != null) brandId = String(user.brand_id)
    const headers = req.headers as Record<string, string>
    const result = await handleUserUpdate({ body, headers }, tenantStore)
    sendJson(res, result.status, result.body, result.headers)
  } catch (error) {
    logger.error('HTTP handler error', { brand_id: brandId, error: (error as Error).message })
    sendJson(res, 500, { error: 'Internal server error' })
  }
}
