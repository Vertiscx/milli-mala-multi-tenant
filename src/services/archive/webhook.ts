/**
 * Core webhook handler - shared between Node.js server and CF Worker.
 * Requires nodejs_compat flag on Cloudflare Workers for node:crypto.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { createLogger } from '../../platform/logger.js'
import { documentTicket } from './documentTicket.js'
import type { HandlerResult, Logger } from '../../platform/types.js'
import type { WebhookRequest } from './types.js'

const logger: Logger = createLogger('webhook')

const WEBHOOK_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Verify Zendesk webhook HMAC-SHA256 signature.
 * Zendesk signs: timestamp + body with the shared secret.
 */
export function verifyWebhookSignature(rawBody: string, timestamp: string, signature: string, secret: string): boolean {
  if (!timestamp || !signature || !secret) return false
  const sig = createHmac('sha256', secret)
    .update(timestamp + rawBody)
    .digest('base64')
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(sig))
  } catch {
    return false
  }
}

/**
 * Check that the webhook timestamp is within an acceptable window.
 * Prevents replay attacks using captured valid webhooks.
 */
export function isTimestampFresh(timestamp: string, toleranceMs: number = WEBHOOK_TIMESTAMP_TOLERANCE_MS): boolean {
  const ts = Date.parse(timestamp)
  if (isNaN(ts)) return false
  return Math.abs(Date.now() - ts) <= toleranceMs
}

/**
 * Core webhook handler. Accepts tenantConfig + docEndpoint, returns { status, body }.
 * HTTP adaptation and tenant resolution are handled by the caller.
 */
export async function handleWebhook(req: WebhookRequest): Promise<HandlerResult> {
  const { body, rawBody, headers, tenantConfig, docEndpoint } = req
  const startTime = Date.now()
  const brandId = tenantConfig.brand_id

  try {
    // Verify Zendesk webhook signature
    const signature = headers['x-zendesk-webhook-signature']
    const timestamp = headers['x-zendesk-webhook-signature-timestamp']
    if (!verifyWebhookSignature(rawBody, timestamp, signature, tenantConfig.zendesk.webhookSecret)) {
      logger.warn('Webhook signature verification failed', { brand_id: brandId })
      return { status: 401, body: { error: 'Invalid webhook signature' } }
    }

    if (!isTimestampFresh(timestamp)) {
      logger.warn('Webhook timestamp too old or invalid', { brand_id: brandId, timestamp })
      return { status: 401, body: { error: 'Webhook timestamp expired' } }
    }

    // Validate ticket_id as a positive integer
    const ticket_id = Number(body.ticket_id)
    if (!Number.isInteger(ticket_id) || ticket_id <= 0) {
      return { status: 400, body: { error: 'Invalid or missing ticket_id' } }
    }

    logger.info('Received webhook', { brand_id: brandId, ticket_id, doc_endpoint: docEndpoint })

    return await documentTicket(req, ticket_id, startTime)
  } catch (error) {
    logger.error('Process failed', { brand_id: brandId, error: (error as Error).message })
    return { status: 500, body: { error: 'Internal server error', duration_ms: Date.now() - startTime } }
  }
}
