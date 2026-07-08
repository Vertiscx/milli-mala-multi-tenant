/**
 * Documentation pipeline extracted from handleWebhook (PR-G1).
 *
 * Behavior-preserving extraction: every stage, ordering, error string,
 * best-effort inner try/catch, and the single post-upload duration_ms
 * computation are reproduced exactly as they were inlined in
 * src/webhook.ts. handleWebhook keeps the auth/freshness/ticket_id gate,
 * the outer try/catch, startTime, and delegates here.
 *
 * The documentTicket() orchestrator is the reuse seam G3 will compose
 * with G2's createCase — but G1 wires nothing new.
 */

import { ZendeskClient } from './zendesk.js'
import { generateTicketPdf } from './pdf.js'
import { createLogger } from './logger.js'
import { resolveEndpoint, validateCaseNumber } from './tenant.js'
import { createDocClient } from './docClient.js'
import type {
  HandlerResult,
  WebhookRequest,
  TenantConfig,
  EndpointConfig,
  ZendeskTicket,
  ZendeskComment,
  ZendeskUser,
  DocClient,
  DownloadedAttachment,
  AuditStore,
  Logger
} from './types.js'

const logger: Logger = createLogger('documentTicket')

interface TicketInfo {
  zendesk: ZendeskClient
  ticket: ZendeskTicket
  comments: ZendeskComment[]
  attachments: DownloadedAttachment[]
  failedAttachments: { filename: string; reason: string }[]
  userMap: Record<number, string>
  solvingAgentEmail: string
}

/**
 * Fetch ticket + comments + attachments and resolve comment authors.
 * Owns the fail-closed brand cross-check (returns the exact 403
 * HandlerResult, never throws) and the best-effort author-resolution
 * inner try/catch (a getUsersMany rejection does NOT propagate).
 */
export async function fetchTicketInfo(
  tenantConfig: TenantConfig,
  ticketId: number
): Promise<{ ok: true; info: TicketInfo } | { ok: false; result: HandlerResult }> {
  const brandId = tenantConfig.brand_id

  // 1. Fetch ticket from Zendesk
  const zendesk = new ZendeskClient(
    tenantConfig.zendesk.subdomain,
    tenantConfig.zendesk.apiToken,
    tenantConfig.zendesk.email
  )
  const ticket = await zendesk.getTicket(ticketId)

  // Brand cross-check: verify the ticket belongs to this tenant's brand (fail-closed)
  if (ticket.brand_id === undefined || ticket.brand_id === null) {
    logger.error('Ticket missing brand_id — cannot verify tenant ownership', {
      brand_id: brandId, ticket_id: ticketId
    })
    return { ok: false, result: { status: 403, body: { error: 'Ticket brand_id unavailable' } } }
  }
  if (String(ticket.brand_id) !== brandId) {
    logger.warn('Brand mismatch: ticket belongs to different brand', {
      brand_id: brandId, ticket_brand_id: ticket.brand_id, ticket_id: ticketId
    })
    return { ok: false, result: { status: 403, body: { error: 'Ticket does not belong to this brand' } } }
  }

  const comments = await zendesk.getTicketComments(ticketId)
  const attachments = await zendesk.fetchAttachments(comments)
  const failedAttachments = attachments.failed ?? []

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

  return { ok: true, info: { zendesk, ticket, comments, attachments, failedAttachments, userMap, solvingAgentEmail } }
}

/**
 * Render the ticket PDF. Owns the generateTicketPdf call.
 */
export async function renderPdf(
  ticket: ZendeskTicket,
  comments: ZendeskComment[],
  tenantConfig: TenantConfig,
  userMap: Record<number, string>
): Promise<Buffer> {
  return generateTicketPdf(ticket, comments, {
    pdfConfig: tenantConfig.pdf,
    userMap
  })
}

/**
 * Resolve the case number: custom-field lookup via ep.caseNumberFieldId,
 * else ZD-${ticketId} fallback. Returns the exact 400 HandlerResult on
 * an invalid case_number — NEVER throws.
 */
export function resolveCaseNumber(
  ep: EndpointConfig,
  ticket: ZendeskTicket,
  ticketId: number
): { ok: true; caseNumber: string } | { ok: false; result: HandlerResult } {
  let caseNumber: string | undefined
  if (ep.caseNumberFieldId && ticket.custom_fields) {
    const field = ticket.custom_fields.find(f => f.id === ep.caseNumberFieldId)
    if (field?.value) caseNumber = String(field.value)
  }
  if (!caseNumber) caseNumber = `ZD-${ticketId}`

  // Sanitize case_number (SYN-MUT-28-3)
  const caseNumberError = validateCaseNumber(caseNumber)
  if (caseNumberError) {
    return { ok: false, result: { status: 400, body: { error: caseNumberError } } }
  }

  return { ok: true, caseNumber }
}

/**
 * Upload the document using an already-constructed doc client.
 * The client is built earlier (in documentTicket) so createDocClient's
 * misconfigured-endpoint throw keeps its original precedence relative
 * to validateCaseNumber's 400 (behavior-preserving).
 */
export async function postToCase(
  docClient: DocClient,
  caseNumber: string,
  ticket: ZendeskTicket,
  ticketId: number,
  pdfBuffer: Buffer,
  attachments: DownloadedAttachment[]
): Promise<void> {
  const uploadFilename = `ticket-${ticketId}.pdf`

  await docClient.uploadDocument({
    caseNumber,
    filename: uploadFilename,
    pdfBuffer,
    attachments,
    metadata: { ticketId, subject: ticket.subject }
  })
}

/**
 * Best-effort audit persistence. Builds the auditEntry, logs it, and
 * persists ×2 to the KV store if available. Swallows auditStore.put
 * errors (logs warn) — NEVER rejects.
 */
export async function writeAudit(args: {
  brandId: string
  ticketId: number
  ticket: ZendeskTicket
  comments: ZendeskComment[]
  attachments: DownloadedAttachment[]
  tenantConfig: TenantConfig
  docEndpoint: string
  ep: EndpointConfig
  caseNumber: string
  pdfBuffer: Buffer
  durationMs: number
  auditStore?: AuditStore
  attachmentsForwarded?: number
  // Optional enrichment — default to reproduce TODAY'S EXACT entry.
  // When omitted (webhook path) the persisted entry is byte-identical:
  // same keys, same order, NO new keys present.
  event?: string
  outcome?: string
  caseNumberSource?: string
  lastStatus?: string
  lastExport?: string
  intent?: string
}): Promise<void> {
  const {
    brandId, ticketId, ticket, comments, attachments,
    tenantConfig, docEndpoint, ep, caseNumber, pdfBuffer,
    durationMs, auditStore
  } = args

  const uploadFilename = `ticket-${ticketId}.pdf`

  // Audit log — operational data only, no PII stored in KV
  const auditEntry = {
    event: args.event ?? 'ticket_archived',
    timestamp: new Date().toISOString(),
    duration_ms: durationMs,
    brand_id: brandId,
    source: {
      ticket_id: ticketId,
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
      case_number_source: args.caseNumberSource ?? (caseNumber.startsWith('ZD-') ? 'fallback' : 'custom_field'),
      pdf_filename: uploadFilename,
      pdf_size_bytes: pdfBuffer.length,
      attachments_forwarded: args.attachmentsForwarded ?? attachments.length
    },
    // Enrichment keys appended AFTER existing keys — present ONLY when the
    // caller passes them, so the no-arg (webhook) entry gains NO new keys
    // and stays byte-identical to the current persisted shape.
    ...(args.outcome !== undefined ? { outcome: args.outcome } : {}),
    ...(args.intent !== undefined ? { intent: args.intent } : {}),
    ...(args.lastStatus !== undefined ? { last_status: args.lastStatus } : {}),
    ...(args.lastExport !== undefined ? { last_export: args.lastExport } : {})
  }
  logger.info('AUDIT', auditEntry)

  // Persist audit entry to KV if available
  if (auditStore) {
    try {
      const ts = auditEntry.timestamp.replace(/[:.]/g, '-')
      await auditStore.put(
        `audit:${brandId}:${ts}:${ticketId}`,
        JSON.stringify(auditEntry),
        { expirationTtl: 90 * 24 * 60 * 60 }
      )
      await auditStore.put(
        `ticket:${brandId}:${ticketId}:${ts}`,
        JSON.stringify(auditEntry),
        { expirationTtl: 90 * 24 * 60 * 60 }
      )
    } catch (err) {
      logger.warn('Failed to persist audit entry', { brand_id: brandId, error: (err as Error).message })
    }
  }
}

/**
 * Orchestrator. Owns endpoint resolution through audit write, composing
 * the stages in the SAME order as the original inline pipeline. Takes
 * startTime so duration_ms is computed at the SAME point (post-upload,
 * pre-audit) and reused for both the audit entry and the success body.
 *
 * Returns either an early-exit HandlerResult or the 200 success body.
 * Wraps the orchestration in an outer try/catch ONLY to fire the
 * best-effort GW-01 failure post-back (recordOutcome) and then RETHROW
 * the original error unchanged — so the 500 envelope still effectively
 * stays in handleWebhook (this catch produces no response). The
 * preserved inner best-effort try/catch blocks are unaffected.
 */
export async function documentTicket(
  req: WebhookRequest,
  ticketId: number,
  startTime: number
): Promise<HandlerResult> {
  const { tenantConfig, docEndpoint, auditStore } = req
  const brandId = tenantConfig.brand_id

  // Validate doc_endpoint against tenant config — 400 if invalid
  let ep
  try {
    ep = resolveEndpoint(tenantConfig, docEndpoint)
  } catch (err) {
    return { status: 400, body: { error: (err as Error).message } }
  }

  // Context captured progressively so the failure-finalize catch can
  // build the richest DocumentationOutcome possible regardless of how
  // far the pipeline got before throwing. The webhook 500 envelope and
  // src/webhook.ts stay byte-identical — the catch RETHROWS.
  let ticket: import('./types.js').ZendeskTicket | undefined
  let comments: ZendeskComment[] | undefined
  let attachments: DownloadedAttachment[] | undefined
  let failedAttachments: { filename: string; reason: string }[] | undefined
  let pdfBuffer: Buffer | undefined
  let resolvedCaseNumber: string | undefined

  try {
    const fetched = await fetchTicketInfo(tenantConfig, ticketId)
    if (!fetched.ok) return fetched.result
    ;({ ticket, comments, attachments, failedAttachments } = fetched.info)
    const { userMap, solvingAgentEmail } = fetched.info

    // 3. Generate PDF
    pdfBuffer = await renderPdf(ticket, comments, tenantConfig, userMap)

    // 4. Upload to document system
    // createDocClient is constructed here (original line-134 position) so a
    // misconfigured-endpoint throw keeps its precedence BEFORE the
    // validateCaseNumber 400 — preserving byte-identical error ordering.
    const docClient = createDocClient(ep, solvingAgentEmail)

    const resolved = resolveCaseNumber(ep, ticket, ticketId)
    if (!resolved.ok) return resolved.result
    const { caseNumber } = resolved
    resolvedCaseNumber = caseNumber

    await postToCase(docClient, caseNumber, ticket, ticketId, pdfBuffer, attachments)

    const duration = Date.now() - startTime

    // GW-01 finalizer — once per request. The webhook path passes
    // intent:'webhook' so the persisted audit entry stays byte-identical
    // (recordOutcome → writeAudit with NO enrichment args). The post-back
    // note + (configured) custom fields are the net-new GW-01 behavior;
    // a post-back failure is swallowed and does NOT change this response.
    const { recordOutcome } = await import('./postResultToTicket.js')
    await recordOutcome(
      {
        ok: true,
        outcome: 'documented',
        intent: 'webhook',
        caseNumber,
        caseNumberSource: caseNumber.startsWith('ZD-') ? 'fallback' : 'custom_field',
        docSystem: ep.type,
        ticketId,
        durationMs: duration,
        pdfFilename: `ticket-${ticketId}.pdf`,
        pdfSizeBytes: pdfBuffer.length,
        failedAttachments,
        timestamp: new Date().toISOString()
      },
      { tenantConfig, ep, docEndpoint, ticket, comments, attachments, pdfBuffer, auditStore }
    )

    return {
      status: 200,
      body: {
        success: true,
        ticket_id: ticketId,
        brand_id: brandId,
        case_number: caseNumber,
        doc_endpoint: docEndpoint,
        doc_system: ep.type,
        duration_ms: duration
      }
    }
  } catch (err) {
    // GW-01 webhook FAILURE post-back. Best-effort: defensively guard
    // every field that may be undefined if the throw happened early
    // (before ticket/pdfBuffer exist). recordOutcome/postResultToTicket
    // never throw, but a throw here must not blow up the catch — so the
    // whole failure-finalize is itself wrapped. The original error is
    // RETHROWN so handleWebhook's 500 envelope + src/webhook.ts stay
    // byte-identical and control flow is unchanged for existing tests.
    try {
      const caseNumber = resolvedCaseNumber ?? `ZD-${ticketId}`
      const { recordOutcome } = await import('./postResultToTicket.js')
      await recordOutcome(
        {
          ok: false,
          outcome: 'failed',
          intent: 'webhook',
          caseNumber,
          caseNumberSource: resolvedCaseNumber
            ? (caseNumber.startsWith('ZD-') ? 'fallback' : 'custom_field')
            : 'fallback',
          docSystem: ep.type,
          ticketId,
          durationMs: Date.now() - startTime,
          pdfFilename: `ticket-${ticketId}.pdf`,
          pdfSizeBytes: pdfBuffer?.length ?? 0,
          failedAttachments: failedAttachments ?? [],
          sanitizedReason: 'Sjálfvirk skjalfesting mistókst',
          timestamp: new Date().toISOString()
        },
        {
          tenantConfig,
          ep,
          docEndpoint,
          // ticket/comments/attachments may be undefined if the throw
          // happened before fetchTicketInfo resolved — fall back to
          // minimal stand-ins so writeAudit/postResultToTicket can still
          // emit the ❌ note + last_status=failed.
          ticket: ticket ?? ({ id: ticketId, subject: '', status: '', created_at: '' } as import('./types.js').ZendeskTicket),
          comments: comments ?? [],
          attachments: attachments ?? [],
          pdfBuffer: pdfBuffer ?? Buffer.alloc(0),
          auditStore
        }
      )
    } catch (finalizeErr) {
      // Never let the failure-finalize itself break the rethrow.
      logger.warn('Failure-finalize failed (swallowed)', {
        brand_id: brandId, ticket_id: ticketId, error: (finalizeErr as Error).message
      })
    }
    // Rethrow EXACTLY as before → handleWebhook's outer catch → 500.
    throw err
  }
}
