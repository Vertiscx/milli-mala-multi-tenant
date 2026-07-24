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

import { ZendeskClient } from '../../platform/zendesk.js'
import { generateTicketPdf } from './pdf.js'
import { createLogger } from '../../platform/logger.js'
import { resolveEndpoint, validateCaseNumber } from '../../platform/tenant.js'
import { createDocClient } from './docClient.js'
import type { OneSystemsClient } from './onesystems.js'
import type {
  HandlerResult,
  TenantConfig,
  EndpointConfig,
  ZendeskTicket,
  ZendeskComment,
  ZendeskUser,
  DownloadedAttachment,
  AuditStore,
  Logger
} from '../../platform/types.js'
import type {
  WebhookRequest,
  DocClient
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
 * Webhook-create input extractor (CONF-01/CONF-02) — consumed by Phase 6.
 * Reads the case template from the trigger-stamped `malaskra_snidmat`
 * custom field (ep.templateFieldId) and the kennitala from
 * ep.kennitalaFieldId. Pure: never throws, never invents values. Values
 * are trimmed; whitespace-only or missing fields yield an absent property.
 * Both values pass through raw — the OneSystems client normalizes the
 * kennitala downstream.
 */
export function resolveCreateInputs(
  ep: EndpointConfig,
  ticket: ZendeskTicket
): { template?: string; kennitala?: string } {
  const lookup = (fieldId: number | null | undefined): string | undefined => {
    if (!fieldId) return undefined
    const field = ticket.custom_fields?.find(f => f.id === fieldId)
    if (field?.value === undefined || field?.value === null) return undefined
    const trimmed = String(field.value).trim()
    return trimmed === '' ? undefined : trimmed
  }

  const template = lookup(ep.templateFieldId)
  const kennitala = lookup(ep.kennitalaFieldId)
  return {
    ...(template !== undefined ? { template } : {}),
    ...(kennitala !== undefined ? { kennitala } : {})
  }
}

/**
 * Read the RAW case-number custom-field value — the same 4-line lookup
 * resolveCaseNumber performs, WITHOUT the ZD- fallback. Used by the
 * webhook create-engage gate (Phase 6) to detect an EMPTY field.
 * resolveCaseNumber itself is deliberately left NOT using this helper
 * (regression constraint: its behavior stays byte-identical).
 */
function readCaseNumberField(
  ep: EndpointConfig,
  ticket: ZendeskTicket
): string | undefined {
  // `!= null` (not truthiness) so the configured-check matches the stamp
  // guard in the create branch — a single predicate for "configured"
  // (LO-05; a theoretical fieldId of 0 counts as configured in BOTH).
  if (ep.caseNumberFieldId != null && ticket.custom_fields) {
    const field = ticket.custom_fields.find(f => f.id === ep.caseNumberFieldId)
    // WR-02: TRIM before returning (mirrors resolveCreateInputs) — a
    // whitespace-only field is ABSENT, so it engages the loud-fail gate /
    // create path instead of silently archiving the documentation under a
    // whitespace "case reference". The outer truthiness check is kept so
    // falsy values (0/false/'') stay "absent" exactly as before — widening
    // it would let resolveCaseNumber's truthiness re-open a ZD- hole.
    // GoPro is unaffected: the gate only consumes this value when the
    // client is createCase-capable.
    if (field?.value) {
      const trimmed = String(field.value).trim()
      if (trimmed !== '') return trimmed
    }
  }
  return undefined
}

// ─── Phase 7: loud-fail webhook create rejects (WHCC-05, AUDIT-01/02) ──

type WebhookCreateRejectMode =
  | 'missing_template'
  | 'missing_kennitala'
  | 'missing_case_number_field_config'

// Icelandic sanitized reasons for the GW-01 ❌ note (þ/ð/æ/ö preserved).
const REJECT_SANITIZED_REASONS: Record<WebhookCreateRejectMode, string> = {
  missing_template: 'Sniðmát vantar á miðann — kveikja (trigger) er rangt stillt',
  missing_kennitala: 'Kennitölu vantar á miðann — skjalfesting hafnað',
  missing_case_number_field_config: 'Málsnúmerssvæði er ekki stillt fyrir þennan tenant'
}

// Fixed sanitized English strings for the HTTP body — never raw internals
// (matches the existing 207/500 discipline).
const REJECT_ERROR_STRINGS: Record<WebhookCreateRejectMode, string> = {
  missing_template: 'Case template missing on ticket — trigger misconfigured',
  missing_kennitala: 'Kennitala missing on ticket — documentation rejected',
  missing_case_number_field_config: 'Case number field not configured for this tenant'
}

/**
 * Loud 422 reject for an empty-field webhook on a createCase-capable
 * tenant (WHCC-05): the gateway never invents a case reference, so a
 * missing template (AUDIT-01), missing kennitala (AUDIT-02) or unset
 * caseNumberFieldId fails loudly — nothing minted, nothing stamped,
 * nothing archived. 422 is non-retryable by design (07-CONTEXT locked):
 * a 5xx would make Zendesk retry a request that can never succeed until
 * the trigger/config is fixed. The GW-01 ❌ post-back + audit entry
 * (event 'webhook_create_rejected', per-mode outcome) fire best-effort.
 */
async function rejectWebhookCreate(args: {
  mode: WebhookCreateRejectMode
  tenantConfig: TenantConfig
  ep: EndpointConfig
  docEndpoint: string
  ticket: ZendeskTicket
  comments: ZendeskComment[]
  attachments: DownloadedAttachment[]
  failedAttachments: { filename: string; reason: string }[]
  pdfBuffer: Buffer
  auditStore?: AuditStore
  ticketId: number
  startTime: number
}): Promise<HandlerResult> {
  const {
    mode, tenantConfig, ep, docEndpoint, ticket, comments, attachments,
    failedAttachments, pdfBuffer, auditStore, ticketId, startTime
  } = args
  const brandId = tenantConfig.brand_id

  logger.error('Webhook create rejected — loud failure, nothing archived', {
    brand_id: brandId, ticket_id: ticketId, doc_endpoint: docEndpoint, mode
  })

  // Best-effort finalize, wrapped like the orphan path (07-CONTEXT: loud
  // failures still fire the GW-01 ❌ post-back so agents see it on the
  // ticket). caseNumber is deliberately OMITTED — source 'none', never a
  // fabricated ZD- value.
  try {
    const { recordOutcome } = await import('./postResultToTicket.js')
    await recordOutcome(
      {
        ok: false,
        outcome: mode,
        intent: 'webhook',
        caseNumberSource: 'none',
        docSystem: ep.type,
        ticketId,
        durationMs: Date.now() - startTime,
        pdfFilename: `ticket-${ticketId}.pdf`,
        pdfSizeBytes: pdfBuffer.length,
        failedAttachments,
        sanitizedReason: REJECT_SANITIZED_REASONS[mode],
        timestamp: new Date().toISOString()
      },
      { tenantConfig, ep, docEndpoint, ticket, comments, attachments, pdfBuffer, auditStore }
    )
  } catch (finalizeErr) {
    logger.warn('Reject finalize failed (swallowed)', {
      brand_id: brandId, ticket_id: ticketId, error: (finalizeErr as Error).message
    })
  }

  return {
    status: 422,
    body: {
      error: REJECT_ERROR_STRINGS[mode],
      outcome: mode,
      ticket_id: ticketId,
      brand_id: brandId,
      doc_endpoint: docEndpoint
    }
  }
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
  // Phase 7 (WHCC-05): absent when the entry has NO case reference (loud
  // webhook rejects, createCase-capable failure finalize) — persisted as
  // JSON null with source 'none', never a fabricated ZD- value.
  caseNumber: string | undefined
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
      case_number: caseNumber ?? null,
      case_number_source: args.caseNumberSource ?? (
        caseNumber === undefined ? 'none'
          : caseNumber.startsWith('ZD-') ? 'fallback' : 'custom_field'
      ),
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
  let ticket: import('../../platform/types.js').ZendeskTicket | undefined
  let comments: ZendeskComment[] | undefined
  let attachments: DownloadedAttachment[] | undefined
  let failedAttachments: { filename: string; reason: string }[] | undefined
  let pdfBuffer: Buffer | undefined
  let resolvedCaseNumber: string | undefined
  // True once createCase has minted (LO-01): the outer failure-finalize
  // must report caseNumberSource 'created' for a latched minted number,
  // never derive 'custom_field' from its shape.
  let mintedByCreate = false
  // Duck-typed create capability (WHCC-05) — set the instant the doc
  // client is constructed, reused by the engage gate AND the outer
  // failure-finalize catch: a createCase-capable client must NEVER get a
  // fabricated ZD- reference, not even in a failure audit.
  let clientCanCreate: boolean | undefined

  try {
    const fetched = await fetchTicketInfo(tenantConfig, ticketId)
    if (!fetched.ok) return fetched.result
    ;({ ticket, comments, attachments, failedAttachments } = fetched.info)
    const { userMap, solvingAgentEmail, zendesk } = fetched.info

    // 3. Generate PDF
    pdfBuffer = await renderPdf(ticket, comments, tenantConfig, userMap)

    // 4. Upload to document system
    // createDocClient is constructed here (original line-134 position) so a
    // misconfigured-endpoint throw keeps its precedence BEFORE the
    // validateCaseNumber 400 — preserving byte-identical error ordering.
    const docClient = createDocClient(ep, solvingAgentEmail)

    // ─── Webhook create branch (Phase 6 WHCC-01..04, Phase 7 WHCC-05) ──
    // When the case-number field is EMPTY and the doc client can create
    // (duck-typed — NEVER ep.type), the ONLY exits are the Phase 6 create
    // path (all three prerequisites present) or one of the three loud 422
    // rejects: an OneSystems-empty ticket NEVER reaches resolveCaseNumber's
    // ZD- fallback anymore (WHCC-05). GoPro (no createCase) and
    // populated-field tickets fall through to today's resolveCaseNumber →
    // postToCase flow untouched.
    const rawCaseNumberField = readCaseNumberField(ep, ticket)
    const createInputs = resolveCreateInputs(ep, ticket)
    clientCanCreate =
      typeof (docClient as Partial<OneSystemsClient>).createCase === 'function'
    if (rawCaseNumberField === undefined && clientCanCreate) {
      const rejectCtx = {
        tenantConfig, ep, docEndpoint, ticket, comments, attachments,
        failedAttachments, pdfBuffer, auditStore, ticketId, startTime
      }
      // Check precedence template → kennitala → config (locked in 07-01):
      // template presence is what defines "create intent staged" (AUDIT-01),
      // then the never-invent-a-kennitala guard (AUDIT-02), then MD-02 —
      // the stamp on ep.caseNumberFieldId is the ONLY re-mint guard, so a
      // mint without a stampable field must fail loudly, never keep ZD-.
      if (createInputs.template === undefined) {
        return rejectWebhookCreate({ mode: 'missing_template', ...rejectCtx })
      }
      if (createInputs.kennitala === undefined) {
        return rejectWebhookCreate({ mode: 'missing_kennitala', ...rejectCtx })
      }
      const stampFieldId = ep.caseNumberFieldId
      if (stampFieldId == null) {
        return rejectWebhookCreate({ mode: 'missing_case_number_field_config', ...rejectCtx })
      }
      // Mirrors cases.ts LOCKED steps 3→6 by COMPOSING the same stage
      // functions (createCase → stamp → postToCase → recordOutcome).
      // A createCase throw propagates to the OUTER catch: nothing was
      // minted, so handleWebhook's 500 makes Zendesk retry — retry is
      // safe pre-mint. Kennitala passes through raw (the client
      // normalizes digits-only downstream).
      const created = await (docClient as OneSystemsClient).createCase({
        caseTemplate: createInputs.template,
        kennitala: createInputs.kennitala,
        caseName: ticket.subject,
        externalId: `ticket_${ticketId}`,
        currentUser: solvingAgentEmail
      })
      // LATCH the minted number the instant createCase resolves — the
      // outer failure-finalize catch reports it via resolvedCaseNumber.
      const mintedNumber = created.caseNumber
      resolvedCaseNumber = mintedNumber
      mintedByCreate = true

      // INNER try wrapping stamp + upload (mirror cases.ts steps 4-5).
      try {
        // LO-04 (SYN-MUT-28-3 parity): run the same sanitizer the
        // field-sourced path applies before the minted number flows into
        // the stamp, upload, audit, and response. An invalid minted number
        // is a POST-mint failure → the inner catch's 207 orphan path
        // (never a retryable 5xx, which would mint a second case).
        const mintedNumberError = validateCaseNumber(mintedNumber)
        if (mintedNumberError) throw new Error(mintedNumberError)

        // Stamp BEFORE upload (WHCC-02): a Zendesk retry after the stamp
        // lands on the populated-field add path, never a second mint. The
        // engage gate guarantees caseNumberFieldId is configured (MD-02).
        await zendesk.setTicketCustomField(ticketId, stampFieldId, mintedNumber)
        logger.info('Stamped case number on ticket', {
          brand_id: brandId, ticket_id: ticketId, caseNumber: mintedNumber
        })

        await postToCase(docClient, mintedNumber, ticket, ticketId, pdfBuffer, attachments)
      } catch (err) {
        // MINTED-BUT-FAILED → 207, never 5xx: a 5xx would make Zendesk
        // retry the webhook and mint a SECOND case. The minted number is
        // never silently lost — it rides in the body + audit
        // (case_number_source 'created'). Best-effort finalize, wrapped
        // defensively like the outer failure-finalize.
        logger.error('Post-create step failed — orphan case', {
          brand_id: brandId, ticket_id: ticketId, caseNumber: mintedNumber,
          error: (err as Error).message
        })
        try {
          const { recordOutcome } = await import('./postResultToTicket.js')
          await recordOutcome(
            {
              ok: false,
              outcome: 'orphan_case',
              intent: 'webhook',
              caseNumber: mintedNumber,
              caseNumberSource: 'created',
              docSystem: ep.type,
              ticketId,
              durationMs: Date.now() - startTime,
              pdfFilename: `ticket-${ticketId}.pdf`,
              pdfSizeBytes: pdfBuffer.length,
              failedAttachments,
              sanitizedReason: 'Skjalfesting eftir stofnun máls mistókst',
              timestamp: new Date().toISOString()
            },
            { tenantConfig, ep, docEndpoint, ticket, comments, attachments, pdfBuffer, auditStore }
          )
        } catch (finalizeErr) {
          logger.warn('Orphan-case finalize failed (swallowed)', {
            brand_id: brandId, ticket_id: ticketId, error: (finalizeErr as Error).message
          })
        }
        // Sanitized fixed string — never the raw err.message (the webhook
        // response must not leak upstream internals).
        return {
          status: 207,
          body: {
            error: 'Documentation after case creation failed',
            ticket_id: ticketId,
            brand_id: brandId,
            case_number: mintedNumber,
            doc_endpoint: docEndpoint
          }
        }
      }

      // Success — same post-upload duration point as the existing path.
      const duration = Date.now() - startTime
      const { recordOutcome } = await import('./postResultToTicket.js')
      await recordOutcome(
        {
          ok: true,
          outcome: 'documented',
          intent: 'webhook',
          caseNumber: mintedNumber,
          caseNumberSource: 'created',
          docSystem: ep.type,
          template: created.caseTemplate,
          ticketId,
          durationMs: duration,
          pdfFilename: `ticket-${ticketId}.pdf`,
          pdfSizeBytes: pdfBuffer.length,
          failedAttachments,
          timestamp: new Date().toISOString()
        },
        { tenantConfig, ep, docEndpoint, ticket, comments, attachments, pdfBuffer, auditStore }
      )

      // EXISTING webhook 200 body shape, case_number = the minted number.
      return {
        status: 200,
        body: {
          success: true,
          ticket_id: ticketId,
          brand_id: brandId,
          case_number: mintedNumber,
          doc_endpoint: docEndpoint,
          doc_system: ep.type,
          duration_ms: duration
        }
      }
    }

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
      // WHCC-05: never fabricate ZD- for a createCase-capable client. If
      // the throw happened BEFORE the doc client was constructed, re-derive
      // the capability with a guarded, IO-free construction (onesystems.ts
      // and gopro.ts constructors are verified IO-free).
      // GoPro failure-finalize keeps today's ZD- + 'fallback' byte-identical.
      if (clientCanCreate === undefined) {
        try {
          clientCanCreate =
            typeof (createDocClient(ep, '') as Partial<OneSystemsClient>).createCase === 'function'
        } catch {
          // Construction threw (missing credentials — WR-03). Re-derive by
          // padding dummy credentials into a CLONE so the factory still
          // picks the class and the check stays duck-typed (never ep.type):
          // a credential-less GoPro endpoint keeps today's ZD- + 'fallback'
          // failure audit byte-identical, and a credential-less OneSystems
          // endpoint is never fabricated for. Only if even the padded
          // construction throws (truly unknown client) does the
          // never-fabricate invariant win with TRUE.
          try {
            clientCanCreate = typeof (createDocClient(
              {
                ...ep,
                username: ep.username || 'unused',
                password: ep.password || 'unused',
                appKey: ep.appKey || 'unused'
              },
              ''
            ) as Partial<OneSystemsClient>).createCase === 'function'
          } catch {
            clientCanCreate = true
          }
        }
      }
      const caseNumber = resolvedCaseNumber ?? (clientCanCreate ? undefined : `ZD-${ticketId}`)
      const { recordOutcome } = await import('./postResultToTicket.js')
      await recordOutcome(
        {
          ok: false,
          outcome: 'failed',
          intent: 'webhook',
          caseNumber,
          caseNumberSource: mintedByCreate
            ? 'created'
            : resolvedCaseNumber
              ? (resolvedCaseNumber.startsWith('ZD-') ? 'fallback' : 'custom_field')
              : (clientCanCreate ? 'none' : 'fallback'),
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
          ticket: ticket ?? ({ id: ticketId, subject: '', status: '', created_at: '' } as import('../../platform/types.js').ZendeskTicket),
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
