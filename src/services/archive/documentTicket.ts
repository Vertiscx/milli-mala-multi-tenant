/**
 * Documentation pipeline extracted from handleWebhook (PR-G1).
 *
 * Behavior-preserving extraction: every stage, ordering, error string,
 * best-effort inner try/catch, and the single post-upload duration_ms
 * computation are reproduced exactly as they were inlined in
 * src/services/archive/webhook.ts. handleWebhook keeps the auth/freshness/ticket_id gate,
 * the outer try/catch, startTime, and delegates here.
 *
 * The documentTicket() orchestrator is the reuse seam G3 will compose
 * with G2's createCase — but G1 wires nothing new.
 */

import { resolveEndpoint } from '../../platform/tenant.js'
import { createDocClient } from './docClient.js'
import { recordOutcome } from './postResultToTicket.js'
import { fetchTicketInfo } from './pipeline/fetch.js'
import { renderPdf } from './pipeline/render.js'
import { resolveCaseNumber } from './pipeline/caseNumber.js'
import { postToCase } from './pipeline/deliver.js'
import { runWebhookCreateFlow } from './pipeline/createFlow.js'
import type { CreateFlowLatch } from './pipeline/createFlow.js'
import { finalizeWebhookFailure } from './pipeline/finalize.js'
import type { OneSystemsClient } from './onesystems.js'
import type {
  HandlerResult,
  ZendeskComment,
  DownloadedAttachment
} from '../../platform/types.js'
import type {
  WebhookRequest
} from './types.js'

export { postToCase } from './pipeline/deliver.js'

export { writeAudit } from './pipeline/audit.js'

// Public pipeline seam — stages live in ./pipeline/, re-exported here so
// external importers (cases.ts, tests) keep one stable entry point.
export { fetchTicketInfo } from './pipeline/fetch.js'
export { renderPdf } from './pipeline/render.js'
export { resolveCaseNumber, resolveCreateInputs } from './pipeline/caseNumber.js'

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
  // src/services/archive/webhook.ts stay byte-identical — the catch RETHROWS.
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
  // Latch shared with runWebhookCreateFlow — mutated the instant createCase
  // resolves so the outer catch (declared here, before the try, so it's in
  // scope) can sync resolvedCaseNumber/mintedByCreate even when the flow
  // throws after minting.
  const latch: CreateFlowLatch = { mintedByCreate: false }

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
    // postToCase flow untouched. runWebhookCreateFlow returns undefined
    // when it does not engage, so we fall through below.
    clientCanCreate =
      typeof (docClient as Partial<OneSystemsClient>).createCase === 'function'
    const createResult = await runWebhookCreateFlow({
      tenantConfig, ep, docEndpoint, ticketId, startTime,
      ticket, comments, attachments, failedAttachments, pdfBuffer,
      zendesk, docClient, clientCanCreate, solvingAgentEmail, auditStore, latch
    })
    // Keep the outer-catch state in sync with the latch regardless of
    // whether the flow returned or threw.
    resolvedCaseNumber = latch.resolvedCaseNumber ?? resolvedCaseNumber
    mintedByCreate = latch.mintedByCreate
    if (createResult !== undefined) return createResult

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
    // NO auditEnrichment: webhook success keeps the byte-identical
    // legacy entry (event ticket_archived, no extra keys).
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
    // Sync the outer-catch state with the latch FIRST — if the create flow
    // threw (createCase's own throw, or anything after it), the normal
    // sync lines after the call never ran, so this is the only place the
    // outer catch learns the minted number.
    resolvedCaseNumber = latch.resolvedCaseNumber ?? resolvedCaseNumber
    mintedByCreate = latch.mintedByCreate
    await finalizeWebhookFailure({
      tenantConfig, ep, docEndpoint, ticketId, startTime,
      ticket, comments, attachments, failedAttachments, pdfBuffer,
      resolvedCaseNumber, mintedByCreate, clientCanCreate, auditStore
    })
    // Rethrow EXACTLY as before → handleWebhook's outer catch → 500.
    throw err
  }
}
