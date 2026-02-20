/**
 * Core webhook handler - shared between Node.js server and CF Worker.
 * Requires nodejs_compat flag on Cloudflare Workers for node:crypto.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { ZendeskClient } from './zendesk.js'
import { generateTicketPdf } from './pdf.js'
import { createLogger } from './logger.js'
import { resolveEndpoint } from './tenant.js'
import { createDocClient } from './docClient.js'
import type { HandlerResult, WebhookRequest, ZendeskUser, Logger } from './types.js'

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
export async function handleWebhook({ body, rawBody, headers, tenantConfig, docEndpoint, auditStore }: WebhookRequest): Promise<HandlerResult> {
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

    // Validate doc_endpoint against tenant config — 400 if invalid
    let ep
    try {
      ep = resolveEndpoint(tenantConfig, docEndpoint)
    } catch (err) {
      return { status: 400, body: { error: (err as Error).message } }
    }

    // 1. Fetch ticket from Zendesk
    const zendesk = new ZendeskClient(
      tenantConfig.zendesk.subdomain,
      tenantConfig.zendesk.apiToken,
      tenantConfig.zendesk.email
    )
    const ticket = await zendesk.getTicket(ticket_id)

    // Brand cross-check: verify the ticket belongs to this tenant's brand (fail-closed)
    if (ticket.brand_id === undefined || ticket.brand_id === null) {
      logger.error('Ticket missing brand_id — cannot verify tenant ownership', {
        brand_id: brandId, ticket_id
      })
      return { status: 403, body: { error: 'Ticket brand_id unavailable' } }
    }
    if (String(ticket.brand_id) !== brandId) {
      logger.warn('Brand mismatch: ticket belongs to different brand', {
        brand_id: brandId, ticket_brand_id: ticket.brand_id, ticket_id
      })
      return { status: 403, body: { error: 'Ticket does not belong to this brand' } }
    }

    const comments = await zendesk.getTicketComments(ticket_id)
    const attachments = await zendesk.fetchAttachments(comments)

    // 2. Resolve all comment author names in one batch
    const authorIds = [...new Set(comments.map(c => c.author_id).filter(Boolean))]
    let authors: ZendeskUser[] = []
    try {
      authors = authorIds.length > 0 ? await zendesk.getUsersMany(authorIds) : []
    } catch (err) {
      logger.warn('Could not resolve author names', { brand_id: brandId, error: (err as Error).message })
    }
    const userMap: Record<number, string> = Object.fromEntries(authors.map(u => [u.id, u.name || u.email || `User ${u.id}`]))

    // Resolve the solving agent's email from the last comment
    let solvingAgentEmail = 'Zendesk'
    if (comments.length > 0) {
      const lastComment = comments[comments.length - 1]
      if (lastComment.author_id) {
        const user = authors.find(u => u.id === lastComment.author_id)
        if (user?.email) solvingAgentEmail = user.email
      }
    }

    // 3. Generate PDF
    const pdfBuffer = await generateTicketPdf(ticket, comments, {
      pdfConfig: tenantConfig.pdf,
      userMap
    })

    // 4. Upload to document system
    const docClient = createDocClient(ep, solvingAgentEmail)

    let caseNumber: string | undefined
    if (ep.caseNumberFieldId && ticket.custom_fields) {
      const field = ticket.custom_fields.find(f => f.id === ep.caseNumberFieldId)
      if (field?.value) caseNumber = String(field.value)
    }
    if (!caseNumber) caseNumber = `ZD-${ticket_id}`

    const uploadFilename = `ticket-${ticket_id}.pdf`

    await docClient.uploadDocument({
      caseNumber,
      filename: uploadFilename,
      pdfBuffer,
      attachments,
      metadata: { ticketId: ticket_id, subject: ticket.subject }
    })

    const duration = Date.now() - startTime

    // Audit log — operational data only, no PII stored in KV
    const auditEntry = {
      event: 'ticket_archived',
      timestamp: new Date().toISOString(),
      duration_ms: duration,
      brand_id: brandId,
      source: {
        ticket_id,
        ticket_status: ticket.status,
        total_comments: comments.length,
        public_comments: comments.filter(c => c.public !== false).length,
        internal_notes: comments.filter(c => c.public === false).length,
        internal_notes_included: tenantConfig.pdf.includeInternalNotes,
        total_attachments: attachments.length
      },
      destination: {
        doc_endpoint: docEndpoint,
        doc_system: ep.type,
        case_number: caseNumber,
        case_number_source: caseNumber.startsWith('ZD-') ? 'fallback' : 'custom_field',
        pdf_filename: uploadFilename,
        pdf_size_bytes: pdfBuffer.length
      }
    }
    logger.info('AUDIT', auditEntry)

    // Persist audit entry to KV if available
    if (auditStore) {
      try {
        const ts = auditEntry.timestamp.replace(/[:.]/g, '-')
        await auditStore.put(
          `audit:${brandId}:${ts}:${ticket_id}`,
          JSON.stringify(auditEntry),
          { expirationTtl: 90 * 24 * 60 * 60 }
        )
        await auditStore.put(
          `ticket:${brandId}:${ticket_id}:${ts}`,
          JSON.stringify(auditEntry),
          { expirationTtl: 90 * 24 * 60 * 60 }
        )
      } catch (err) {
        logger.warn('Failed to persist audit entry', { brand_id: brandId, error: (err as Error).message })
      }
    }

    return {
      status: 200,
      body: {
        success: true,
        ticket_id,
        brand_id: brandId,
        case_number: caseNumber,
        doc_endpoint: docEndpoint,
        doc_system: ep.type,
        duration_ms: duration
      }
    }
  } catch (error) {
    logger.error('Process failed', { brand_id: brandId, error: (error as Error).message })
    return { status: 500, body: { error: 'Internal server error', duration_ms: Date.now() - startTime } }
  }
}
