/**
 * GW-01 — post the documentation result back onto the Zendesk ticket.
 *
 * Single responsibility, BEST-EFFORT: this module NEVER throws. Any
 * failure is logged and swallowed — it MUST NOT change the HTTP response
 * the gateway already computed (GW-01 mandate; mirrors writeAudit's
 * pattern). It performs exactly ONE atomic Zendesk PUT carrying an
 * internal note (comment.public=false) + the success/failure custom
 * field set, reusing the existing ZendeskClient.requestWrite transport.
 *
 * Note text is the verbatim GW-01 Icelandic template (þ/ð/æ/ö/á/í
 * preserved). recordOutcome() is the once-per-request finalizer that
 * calls writeAudit + postResultToTicket.
 */

import { ZendeskClient } from './zendesk.js'
import { writeAudit } from './documentTicket.js'
import { createLogger } from './logger.js'
import type {
  DocumentationOutcome,
  EndpointConfig,
  TenantConfig,
  ZendeskTicket,
  ZendeskComment,
  DownloadedAttachment,
  AuditStore,
  Logger
} from './types.js'

const logger: Logger = createLogger('postResultToTicket')

export interface RecordContext {
  tenantConfig: TenantConfig
  ep: EndpointConfig
  docEndpoint: string
  // writeAudit inputs (kept so the webhook persisted entry stays byte-identical)
  ticket: ZendeskTicket
  comments: ZendeskComment[]
  attachments: DownloadedAttachment[]
  pdfBuffer: Buffer
  auditStore?: AuditStore
}

/** Build the verbatim GW-01 Icelandic internal note. */
export function buildNote(o: DocumentationOutcome, ep: EndpointConfig): string {
  const lines: string[] = []
  if (o.outcome === 'documented') {
    // ✅ success template (GW-01)
    lines.push(`✅ Skjalfest í ${ep.type} mál ${o.caseNumber ?? ''}`)
    lines.push(`Tímastimpill: ${o.timestamp}`)
    lines.push(`Skjal: ${o.pdfFilename} (${o.pdfSizeBytes} bytes)`)
    if (o.auditRef) lines.push(`Vísun: ${o.auditRef}`)
  } else {
    // ❌ failure template (GW-01) — sanitized reason only
    lines.push(`❌ Skjalfesting mistókst`)
    lines.push(`Ástæða: ${o.sanitizedReason ?? 'Óþekkt villa'}`)
    lines.push(`Tímastimpill: ${o.timestamp}`)
    if (o.auditRef) lines.push(`Vísun: ${o.auditRef}`)
  }
  if (o.failedAttachments.length > 0) {
    lines.push('')
    lines.push('Viðhengi sem mistókst að senda:')
    for (const fa of o.failedAttachments) {
      lines.push(`- ${fa.filename} (${fa.reason})`)
    }
  }
  return lines.join('\n')
}

/**
 * Build the custom_fields array per the locked decision.
 *  - SUCCESS (documented): caseNumberFieldId (doc-system-sourced) +
 *    templateFieldId (OS create only) + lastStatusFieldId='success' +
 *    lastExportFieldId=ISO.
 *  - FAILURE: ONLY lastStatusFieldId='failed:<short reason>'.
 * Any field whose *FieldId is unset/null is skipped (graceful).
 */
export function buildCustomFields(
  o: DocumentationOutcome,
  ep: EndpointConfig
): { id: number; value: string | number | boolean | null }[] {
  const fields: { id: number; value: string | number | boolean | null }[] = []
  if (o.outcome === 'documented') {
    if (ep.caseNumberFieldId != null && o.caseNumber) {
      fields.push({ id: ep.caseNumberFieldId, value: o.caseNumber })
    }
    if (ep.templateFieldId != null && o.template) {
      fields.push({ id: ep.templateFieldId, value: o.template })
    }
    if (ep.lastStatusFieldId != null) {
      fields.push({ id: ep.lastStatusFieldId, value: 'success' })
    }
    if (ep.lastExportFieldId != null) {
      // Zendesk DATE custom field — accepts YYYY-MM-DD only. o.timestamp
      // is new Date().toISOString(); the first 10 chars are YYYY-MM-DD.
      // Full ISO precision is kept in the note + audit, not this field.
      fields.push({ id: ep.lastExportFieldId, value: o.timestamp.slice(0, 10) })
    }
  } else {
    if (ep.lastStatusFieldId != null) {
      const short = (o.sanitizedReason ?? 'error').slice(0, 80)
      fields.push({ id: ep.lastStatusFieldId, value: `failed:${short}` })
    }
  }
  return fields
}

/**
 * Post the result to the ticket. NEVER throws. No post-back for
 * auth|validation|brand_mismatch (no real ticket context) — callers
 * simply do not invoke recordOutcome for those.
 */
export async function postResultToTicket(
  o: DocumentationOutcome,
  ctx: RecordContext
): Promise<void> {
  try {
    const { tenantConfig, ep } = ctx
    const note = buildNote(o, ep)
    const customFields = buildCustomFields(o, ep)

    const ticketBody: Record<string, unknown> = {
      comment: { body: note, public: false }
    }
    if (customFields.length > 0) {
      ticketBody.custom_fields = customFields
    }

    const zendesk = new ZendeskClient(
      tenantConfig.zendesk.subdomain,
      tenantConfig.zendesk.apiToken,
      tenantConfig.zendesk.email
    )
    await zendesk.requestWrite(
      `/tickets/${o.ticketId}.json`,
      'PUT',
      { ticket: ticketBody }
    )
    logger.info('Posted result to ticket', {
      brand_id: tenantConfig.brand_id,
      ticket_id: o.ticketId,
      outcome: o.outcome,
      fields_written: customFields.length
    })
  } catch (err) {
    // Best-effort: log + swallow. MUST NOT change the HTTP response.
    logger.warn('Post-back to ticket failed (best-effort, swallowed)', {
      ticket_id: o.ticketId,
      error: (err as Error).message
    })
  }
}

/**
 * Once-per-request finalizer. Calls writeAudit (KV/stdout) +
 * postResultToTicket. Never throws.
 *
 * The webhook path passes NO enrichment args so the persisted audit
 * entry stays byte-identical to today's shape (writeAudit appends
 * enrichment keys only when present).
 */
export async function recordOutcome(
  o: DocumentationOutcome,
  ctx: RecordContext
): Promise<void> {
  try {
    const auditArgs: Parameters<typeof writeAudit>[0] = {
      brandId: ctx.tenantConfig.brand_id,
      ticketId: o.ticketId,
      ticket: ctx.ticket,
      comments: ctx.comments,
      attachments: ctx.attachments,
      tenantConfig: ctx.tenantConfig,
      docEndpoint: ctx.docEndpoint,
      ep: ctx.ep,
      caseNumber: o.caseNumber ?? `ZD-${o.ticketId}`,
      pdfBuffer: ctx.pdfBuffer,
      durationMs: o.durationMs,
      auditStore: ctx.auditStore
    }
    // Webhook path → no enrichment (byte-identical persisted entry).
    if (o.intent !== 'webhook') {
      auditArgs.event = o.outcome === 'documented' ? 'ticket_archived'
        : o.outcome === 'orphan_case' ? 'orphan_case'
        : o.outcome
      auditArgs.outcome = o.outcome
      auditArgs.caseNumberSource = o.caseNumberSource
      auditArgs.intent = o.intent
      auditArgs.lastStatus = o.outcome === 'documented' ? 'OK'
        : o.outcome === 'orphan_case' ? 'ORPHAN'
        : 'FAILED'
      if (o.outcome === 'documented') auditArgs.lastExport = o.timestamp
    }
    await writeAudit(auditArgs)
  } catch (err) {
    logger.warn('writeAudit failed in recordOutcome (swallowed)', {
      ticket_id: o.ticketId, error: (err as Error).message
    })
  }
  await postResultToTicket(o, ctx)
}
