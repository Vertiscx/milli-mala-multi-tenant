/**
 * Attachments endpoint — called by Malaskra client-side app.
 *
 * Malaskra sends: { ticket_id, brand_id, doc_endpoint, case_number }
 * This handler fetches the ticket's attachments from Zendesk server-side,
 * then forwards them to the resolved archive endpoint.
 */

import { timingSafeEqual, createHash } from 'node:crypto'
import { ZendeskClient } from './zendesk.js'
import { createLogger } from './logger.js'
import { resolveEndpoint } from './tenant.js'
import { createDocClient } from './docClient.js'
import type { HandlerResult, AttachmentsRequest, TenantConfig, Logger } from './types.js'

const logger: Logger = createLogger('attachments')

/**
 * Verify the X-Api-Key header against the tenant's malaskra API key.
 */
function verifyApiKey(headers: Record<string, string>, tenantConfig: TenantConfig): boolean {
  const key = tenantConfig.malaskra.apiKey
  if (!key) return false
  const provided = headers['x-api-key']
  if (!provided) return false
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(key).digest()
  return timingSafeEqual(a, b)
}

/**
 * Core handler for POST /v1/attachments.
 * Accepts tenantConfig + docEndpoint, returns { status, body }.
 */
export async function handleAttachments({ body, headers, tenantConfig, docEndpoint }: AttachmentsRequest): Promise<HandlerResult> {
  const startTime = Date.now()
  const brandId = tenantConfig.brand_id

  try {
    // Auth check
    if (!verifyApiKey(headers, tenantConfig)) {
      return { status: 401, body: { error: 'Invalid or missing API key' } }
    }

    // Validate input
    const ticketId = Number(body.ticket_id)
    if (!Number.isInteger(ticketId) || ticketId <= 0) {
      return { status: 400, body: { error: 'Invalid or missing ticket_id' } }
    }

    const caseNumber = body.case_number
    if (!caseNumber || typeof caseNumber !== 'string') {
      return { status: 400, body: { error: 'Invalid or missing case_number' } }
    }

    logger.info('Attachment forwarding request', { brand_id: brandId, ticketId, caseNumber, docEndpoint })

    // Validate doc_endpoint against tenant config — 400 if invalid
    let ep
    try {
      ep = resolveEndpoint(tenantConfig, docEndpoint)
    } catch (err) {
      return { status: 400, body: { error: (err as Error).message } }
    }

    // 1. Fetch ticket and verify brand ownership
    const zendesk = new ZendeskClient(
      tenantConfig.zendesk.subdomain,
      tenantConfig.zendesk.apiToken,
      tenantConfig.zendesk.email
    )

    const ticket = await zendesk.getTicket(ticketId)
    if (ticket.brand_id !== undefined && String(ticket.brand_id) !== brandId) {
      logger.warn('Brand mismatch: ticket belongs to different brand', {
        brand_id: brandId, ticket_brand_id: ticket.brand_id, ticket_id: ticketId
      })
      return { status: 403, body: { error: 'Ticket does not belong to this brand' } }
    }

    // 2. Fetch attachments from Zendesk
    const comments = await zendesk.getTicketComments(ticketId)
    const attachments = await zendesk.fetchAttachments(comments)

    if (attachments.length === 0) {
      logger.info('No attachments found on ticket', { brand_id: brandId, ticketId })
      return {
        status: 200,
        body: {
          success: true,
          ticket_id: ticketId,
          brand_id: brandId,
          case_number: caseNumber,
          attachments_forwarded: 0,
          duration_ms: Date.now() - startTime
        }
      }
    }

    // 2. Upload to doc system
    const docClient = createDocClient(ep)

    let forwarded = 0
    const errors: { filename: string; error: string }[] = []

    for (const att of attachments) {
      try {
        await docClient.uploadDocument({
          caseNumber,
          filename: att.filename,
          pdfBuffer: att.data,
          metadata: { ticketId, source: 'malaskra-attachment' }
        })
        forwarded++
        logger.debug('Forwarded attachment', { brand_id: brandId, filename: att.filename, caseNumber })
      } catch (err) {
        logger.warn('Failed to forward attachment', { brand_id: brandId, filename: att.filename, error: (err as Error).message })
        errors.push({ filename: att.filename, error: (err as Error).message })
      }
    }

    const duration = Date.now() - startTime
    logger.info('Attachment forwarding complete', {
      brand_id: brandId, ticketId, caseNumber, docEndpoint,
      doc_system: ep.type,
      total: attachments.length, forwarded, failed: errors.length, duration_ms: duration
    })

    return {
      status: 200,
      body: {
        success: errors.length === 0,
        ticket_id: ticketId,
        brand_id: brandId,
        case_number: caseNumber,
        doc_endpoint: docEndpoint,
        doc_system: ep.type,
        attachments_total: attachments.length,
        attachments_forwarded: forwarded,
        errors: errors.length > 0 ? errors : undefined,
        duration_ms: duration
      }
    }
  } catch (error) {
    logger.error('Attachment forwarding failed', { brand_id: brandId, error: (error as Error).message })
    return { status: 500, body: { error: 'Internal server error', duration_ms: Date.now() - startTime } }
  }
}
