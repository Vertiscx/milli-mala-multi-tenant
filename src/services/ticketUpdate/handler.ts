/**
 * POST /v1/tickets/update — generic Zendesk-trigger-driven ticket update,
 * authenticated to Zendesk via OAuth (Client Credentials) instead of the
 * tenant's Basic-auth API token. This service performs the actual Zendesk
 * API call itself, so the OAuth access token never has to travel back
 * through Zendesk's own trigger/webhook machinery (and its logs) — the
 * trigger only ever sees a plain success/failure response.
 *
 * Payload shape — brand_id lives INSIDE ticket, unlike every other route
 * in this repo:
 *   { "ticket": { "id": "...", "brand_id": "...", <any other fields to set> } }
 * That's also why this handler resolves the tenant and verifies the
 * webhook signature itself rather than going through the generic
 * dispatchServiceRoute in index.ts, which assumes brand_id is top-level.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createLogger, capBody } from '../../platform/logger.js'
import { fetchWithTimeout } from '../../platform/http.js'
import { resolveTenantConfig, type TenantStore } from '../../platform/tenant.js'
import { getAccessToken, refreshAccessToken } from './oauthClient.js'
import type { HandlerResult, Logger } from '../../platform/types.js'

const logger: Logger = createLogger('ticketUpdate')

const WEBHOOK_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000
const MAX_BODY_SIZE = 1024 * 1024 // 1MB — matches every other route in this repo

// Copied verbatim from services/archive/webhook.ts (do NOT import/share —
// this service stays independent of the archive service, same convention
// as cases.ts's verifyApiKey duplicating attachments.ts's).
function verifyWebhookSignature(rawBody: string, timestamp: string, signature: string, secret: string): boolean {
  if (!timestamp || !signature || !secret) return false
  const sig = createHmac('sha256', secret).update(timestamp + rawBody).digest('base64')
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(sig))
  } catch {
    return false
  }
}

function isTimestampFresh(timestamp: string, toleranceMs: number = WEBHOOK_TIMESTAMP_TOLERANCE_MS): boolean {
  const ts = Date.parse(timestamp)
  if (isNaN(ts)) return false
  return Math.abs(Date.now() - ts) <= toleranceMs
}

export interface TicketUpdateHttpRequest {
  body: Record<string, unknown>
  rawBody: string
  headers: Record<string, string>
}

async function callZendeskTicketUpdate(
  subdomain: string,
  ticketId: number,
  fields: Record<string, unknown>,
  accessToken: string
): Promise<Response> {
  // Single-ticket update (synchronous, confirms the result in the same
  // response) rather than the bulk update_many.json endpoint — this
  // service only ever touches one ticket per call, so there's no bulk
  // workload to justify trading confirmation for a fire-and-forget job.
  const url = `https://${subdomain}.zendesk.com/api/v2/tickets/${ticketId}.json`
  return fetchWithTimeout(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ ticket: fields })
  })
}

/**
 * Core handler — a pure function of (body, rawBody, headers, tenantStore),
 * no Node HTTP types involved, so it's testable the same way handleWebhook
 * is (tests/webhook.test.ts).
 */
export async function handleTicketUpdate(req: TicketUpdateHttpRequest, tenantStore: TenantStore): Promise<HandlerResult> {
  const { body, rawBody, headers } = req
  const startTime = Date.now()

  const ticket = body.ticket as Record<string, unknown> | undefined
  if (!ticket || typeof ticket !== 'object') {
    return { status: 400, body: { error: 'Missing ticket' } }
  }

  const brandId = ticket.brand_id != null ? String(ticket.brand_id) : undefined
  if (!brandId) {
    return { status: 400, body: { error: 'Missing ticket.brand_id' } }
  }

  const tenantConfig = await resolveTenantConfig(brandId, tenantStore)
  if (!tenantConfig) return { status: 400, body: { error: 'Invalid request' } }

  const ticketUpdateConfig = tenantConfig.services?.ticketUpdate
  if (!ticketUpdateConfig) return { status: 400, body: { error: 'Invalid request' } }

  const signature = headers['x-zendesk-webhook-signature']
  const timestamp = headers['x-zendesk-webhook-signature-timestamp']
  if (!verifyWebhookSignature(rawBody, timestamp, signature, ticketUpdateConfig.webhookSecret)) {
    logger.warn('Webhook signature verification failed', { brand_id: brandId })
    return { status: 401, body: { error: 'Invalid webhook signature' } }
  }
  if (!isTimestampFresh(timestamp)) {
    logger.warn('Webhook timestamp too old or invalid', { brand_id: brandId, timestamp })
    return { status: 401, body: { error: 'Webhook timestamp expired' } }
  }

  const ticketId = Number(ticket.id)
  if (!Number.isInteger(ticketId) || ticketId <= 0) {
    return { status: 400, body: { error: 'Invalid or missing ticket.id' } }
  }

  // Everything except id/brand_id is forwarded to Zendesk as-is — id only
  // addresses the URL, brand_id only resolves the tenant; neither is a
  // real Zendesk ticket field.
  const { id: _id, brand_id: _tenantBrandId, ...fields } = ticket
  if (Object.keys(fields).length === 0) {
    return { status: 400, body: { error: 'No fields to update' } }
  }

  logger.info('Ticket update request', { brand_id: brandId, ticket_id: ticketId, fields: Object.keys(fields) })

  try {
    const { subdomain } = tenantConfig.zendesk
    const { clientId, clientSecret } = ticketUpdateConfig.oauth

    let accessToken: string
    try {
      accessToken = await getAccessToken(brandId, subdomain, clientId, clientSecret)
    } catch (err) {
      logger.error('Zendesk OAuth token fetch failed', { brand_id: brandId, ticket_id: ticketId, error: (err as Error).message })
      return { status: 502, body: { error: 'Zendesk authentication failed' } }
    }

    let response = await callZendeskTicketUpdate(subdomain, ticketId, fields, accessToken)

    if (response.status === 401) {
      logger.info('Zendesk rejected cached token, retrying with a fresh one', { brand_id: brandId, ticket_id: ticketId })
      try {
        accessToken = await refreshAccessToken(brandId, subdomain, clientId, clientSecret)
      } catch (err) {
        logger.error('Zendesk OAuth token refresh failed', { brand_id: brandId, ticket_id: ticketId, error: (err as Error).message })
        return { status: 502, body: { error: 'Zendesk authentication failed' } }
      }
      response = await callZendeskTicketUpdate(subdomain, ticketId, fields, accessToken)
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      logger.error('Zendesk ticket update failed', { brand_id: brandId, ticket_id: ticketId, status: response.status, body: capBody(text) })
      return { status: 502, body: { error: 'Zendesk ticket update failed' } }
    }

    // Synchronous endpoint: response.ok here means Zendesk actually applied
    // the update, not just accepted a job. The response body is the full
    // updated ticket resource — not echoed back, to keep ticket content out
    // of this endpoint's response (same posture as the rest of the repo:
    // no ticket content in audit entries or logs).
    const duration = Date.now() - startTime
    logger.info('Ticket updated', { brand_id: brandId, ticket_id: ticketId, duration_ms: duration })

    return {
      status: 200,
      body: {
        success: true,
        ticket_id: ticketId,
        brand_id: brandId,
        duration_ms: duration
      }
    }
  } catch (error) {
    logger.error('Ticket update request failed', { brand_id: brandId, ticket_id: ticketId, error: (error as Error).message })
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

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

/**
 * Node HTTP entry point, registered directly in index.ts (the same way
 * handleHealth/handleAuditHttp are) rather than through the generic
 * dispatchServiceRoute — that machinery reads brand_id from the top level
 * of the body, which doesn't hold here (see module header).
 */
export async function handleTicketUpdateHttp(req: IncomingMessage, res: ServerResponse, tenantStore: TenantStore): Promise<void> {
  try {
    const rawBody = await readRawBody(req, MAX_BODY_SIZE)
    let body: Record<string, unknown>
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>
    } catch {
      return sendJson(res, 400, { error: 'Invalid JSON body' })
    }
    const headers = req.headers as Record<string, string>
    const result = await handleTicketUpdate({ body, rawBody, headers }, tenantStore)
    sendJson(res, result.status, result.body)
  } catch (error) {
    logger.error('HTTP handler error', { error: (error as Error).message })
    sendJson(res, 500, { error: 'Internal server error' })
  }
}
