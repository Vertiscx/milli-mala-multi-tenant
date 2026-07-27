import { createLogger } from '../../../platform/logger.js'
import { validateCaseNumber } from '../../../platform/tenant.js'
import { ZendeskClient } from '../../../platform/zendesk.js'
import { recordOutcome } from '../postResultToTicket.js'
import { readCaseNumberField, resolveCreateInputs } from './caseNumber.js'
import { postToCase } from './deliver.js'
import type { OneSystemsClient } from '../onesystems.js'
import type {
  HandlerResult,
  TenantConfig,
  EndpointConfig,
  ZendeskTicket,
  ZendeskComment,
  DownloadedAttachment,
  AuditStore,
  Logger
} from '../../../platform/types.js'
import type { DocClient } from '../types.js'

const logger: Logger = createLogger('documentTicket')

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
        timestamp: new Date().toISOString(),
        auditEnrichment: {
          event: 'webhook_create_rejected',
          outcome: mode,
          caseNumberSource: 'none'
        }
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

export interface CreateFlowLatch {
  resolvedCaseNumber?: string
  mintedByCreate: boolean
}

/**
 * Webhook create branch (Phase 6 WHCC-01..04, Phase 7 WHCC-05). When the
 * case-number field is EMPTY and the doc client can create (duck-typed —
 * NEVER ep.type), the ONLY exits are the Phase 6 create path (all three
 * prerequisites present) or one of the three loud 422 rejects: an
 * OneSystems-empty ticket NEVER reaches resolveCaseNumber's ZD- fallback
 * anymore (WHCC-05). GoPro (no createCase) and populated-field tickets
 * fall through to today's resolveCaseNumber → postToCase flow untouched —
 * this function returns `undefined` in that case so the caller falls
 * through to the classic path.
 *
 * `latch` is mutated the INSTANT createCase resolves (before validate/
 * stamp/upload) so the orchestrator's outer catch can see the minted
 * number even when this function throws.
 */
export async function runWebhookCreateFlow(args: {
  tenantConfig: TenantConfig
  ep: EndpointConfig
  docEndpoint: string
  ticketId: number
  startTime: number
  ticket: ZendeskTicket
  comments: ZendeskComment[]
  attachments: DownloadedAttachment[]
  failedAttachments: { filename: string; reason: string }[]
  pdfBuffer: Buffer
  zendesk: ZendeskClient
  docClient: DocClient
  clientCanCreate: boolean
  solvingAgentEmail: string
  auditStore?: AuditStore
  latch: CreateFlowLatch
}): Promise<HandlerResult | undefined> {
  const {
    tenantConfig, ep, docEndpoint, ticketId, startTime, ticket, comments,
    attachments, failedAttachments, pdfBuffer, zendesk, docClient,
    clientCanCreate, solvingAgentEmail, auditStore, latch
  } = args
  const brandId = tenantConfig.brand_id

  const rawCaseNumberField = readCaseNumberField(ep, ticket)
  const createInputs = resolveCreateInputs(ep, ticket)
  if (rawCaseNumberField !== undefined || !clientCanCreate) return undefined

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
  latch.resolvedCaseNumber = mintedNumber
  latch.mintedByCreate = true

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
          timestamp: new Date().toISOString(),
          auditEnrichment: {
            caseNumberSource: 'created',
            outcome: 'orphan_case'
          }
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
      timestamp: new Date().toISOString(),
      auditEnrichment: { caseNumberSource: 'created' }
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
