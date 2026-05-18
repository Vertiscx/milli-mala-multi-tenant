/**
 * Cases endpoint — synchronous manual documentation, called by the Malaskrá app.
 *
 * GW-06 is the authoritative wire contract (single source of truth,
 * /Users/brynjolfur/dev/malaskra_v3/.planning/GATEWAY-CHANGES.md §GW-06).
 *
 * Malaskrá sends: { ticket_id, brand_id, doc_endpoint } plus EXACTLY ONE OF
 *   - create: { onesystems: { caseTemplate, kennitala, caseName? } }  → mint a new case
 *                                                                       (backend-namespaced)
 *   - case_number: string                             → document into an existing case
 *
 * Every structured response body is the GW-06 envelope:
 *   success: { ok:true,  outcome:'documented', caseNumber }
 *   failure: { ok:false, outcome:'<code>', error }
 *   orphan:  { ok:false, outcome:'orphan_case', error, caseNumber:<created> }
 * 7-code enum (LOCKED order):
 *   documented|create_failed|orphan_case|validation|auth|brand_mismatch|gopro_create_unsupported
 *
 * Composes G1's documentTicket stage fns with G2's createCase /
 * setTicketCustomField. Mirrors src/attachments.ts (the proven sibling
 * handler) for the gate phase, then runs the LOCKED 6-step order.
 *
 * Core value: on the CREATE path a minted case number is NEVER silently
 * lost — if createCase succeeds but a later step fails, the response is
 * HTTP 207 outcome=orphan_case carrying caseNumber. On the case_number
 * path nothing is minted, so a later failure propagates to the generic
 * HTTP 500 { error:'Internal server error', duration_ms } envelope
 * (retry-safe, NOT a GW-06 outcome), exactly like the sibling handlers.
 */

import { timingSafeEqual, createHash } from 'node:crypto'
import { createLogger } from './logger.js'
import { resolveEndpoint, validateCaseNumber } from './tenant.js'
import { createDocClient } from './docClient.js'
import { fetchTicketInfo, renderPdf, postToCase } from './documentTicket.js'
import { recordOutcome } from './postResultToTicket.js'
import type { OneSystemsClient } from './onesystems.js'
import type { HandlerResult, TenantConfig, AuditStore, Logger, DocumentationOutcome, EndpointConfig } from './types.js'

const logger: Logger = createLogger('cases')

/**
 * Verify the X-Api-Key header against the tenant's malaskra API key.
 * Copied verbatim from src/attachments.ts:21-29 (do NOT import/share —
 * src/attachments.ts must stay byte-identical).
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

export interface CasesRequest {
  body: Record<string, unknown>
  headers: Record<string, string>
  tenantConfig: TenantConfig
  docEndpoint: string
  auditStore?: AuditStore
}

/**
 * Core handler for POST /v1/cases.
 * Accepts tenantConfig + docEndpoint, returns { status, body }.
 */
export async function handleCases({ body, headers, tenantConfig, docEndpoint, auditStore }: CasesRequest): Promise<HandlerResult> {
  const startTime = Date.now()
  const brandId = tenantConfig.brand_id

  // ─── Gate phase (relative order, mirroring attachments.ts) ──────────
  try {
    // Auth check
    if (!verifyApiKey(headers, tenantConfig)) {
      return { status: 401, body: { ok: false, outcome: 'auth', error: 'Invalid or missing API key' } }
    }

    // Validate ticket_id
    const ticketId = Number(body.ticket_id)
    if (!Number.isInteger(ticketId) || ticketId <= 0) {
      return { status: 400, body: { ok: false, outcome: 'validation', error: 'Invalid or missing ticket_id' } }
    }

    // Exactly-one-of: create XOR case_number
    const hasCreate = body.create != null
    const hasCase = typeof body.case_number === 'string' && (body.case_number as string).length > 0
    if (hasCreate === hasCase) {
      return { status: 400, body: { ok: false, outcome: 'validation', error: 'Provide exactly one of create or case_number' } }
    }

    // case_number path: validate the supplied number
    if (hasCase) {
      const caseNumberError = validateCaseNumber(body.case_number as string)
      if (caseNumberError) {
        return { status: 400, body: { ok: false, outcome: 'validation', error: caseNumberError } }
      }
    }

    // create path: validate the GW-06 backend-namespaced create sub-shape
    // (body.create.onesystems.caseTemplate / .kennitala — NOT flat).
    let createParams: { caseTemplate: string; kennitala: string; caseName?: string } | undefined
    if (hasCreate) {
      const c = body.create as Record<string, unknown>
      const ns = c?.onesystems as Record<string, unknown> | undefined
      const caseTemplate = typeof ns?.caseTemplate === 'string' ? ns.caseTemplate : ''
      const kennitala = typeof ns?.kennitala === 'string' ? ns.kennitala : ''
      if (!caseTemplate || !kennitala) {
        return {
          status: 400,
          body: {
            ok: false,
            outcome: 'validation',
            error: 'Missing create.onesystems.caseTemplate or create.onesystems.kennitala'
          }
        }
      }
      createParams = {
        caseTemplate,
        kennitala,
        caseName: typeof ns?.caseName === 'string' ? ns.caseName : undefined
      }
    }

    logger.info('Cases request', { brand_id: brandId, ticketId, docEndpoint, intent: hasCreate ? 'create' : 'case_number' })

    // Validate doc_endpoint against tenant config — 400 if invalid
    let ep
    try {
      ep = resolveEndpoint(tenantConfig, docEndpoint)
    } catch (err) {
      return { status: 400, body: { ok: false, outcome: 'validation', error: (err as Error).message } }
    }

    // ─── LOCKED order (post-gate) ─────────────────────────────────────
    // Latched ONLY on the create path; stays undefined on the case_number path.
    let createdCaseNumber: string | undefined
    let createdTemplate: string | undefined

    // GW-01 finalizer wrapper. Short, safe Icelandic reasons are passed
    // per terminal point; raw error detail stays in the existing
    // logger.error calls + audit/stdout only (never in the note).
    const finalize = async (o: DocumentationOutcome, epc: EndpointConfig): Promise<void> => {
      try {
        await recordOutcome(o, {
          tenantConfig, ep: epc, docEndpoint,
          ticket, comments, attachments, pdfBuffer, auditStore
        })
      } catch { /* recordOutcome never throws; stay defensive */ }
    }

    // 1. fetchTicketInfo (owns the fail-closed brand cross-check)
    const fetched = await fetchTicketInfo(tenantConfig, ticketId)
    if (!fetched.ok) {
      // GW-06: emit ONLY the clean envelope — do NOT spread fetched.result.body
      // (it carries snake_case fields that must not leak).
      const brandErr = (fetched.result.body as Record<string, unknown>)?.error
      return {
        status: fetched.result.status,
        body: {
          ok: false,
          outcome: 'brand_mismatch',
          error: typeof brandErr === 'string' ? brandErr : 'Ticket does not belong to this brand'
        }
      }
    }
    const { ticket, comments, attachments, failedAttachments, userMap, solvingAgentEmail } = fetched.info

    // 2. renderPdf
    const pdfBuffer = await renderPdf(ticket, comments, tenantConfig, userMap)

    // 3. createDocClient (the ONLY ep.type switch lives in this factory)
    const docClient = createDocClient(ep, solvingAgentEmail)

    if (hasCreate) {
      // CREATE PATH — capability check FIRST (duck-typed, NEVER ep.type)
      const canCreateCase =
        typeof (docClient as Partial<OneSystemsClient>).createCase === 'function'
      if (!canCreateCase) {
        return {
          status: 422,
          body: { ok: false, outcome: 'gopro_create_unsupported', error: 'Case creation not supported for this doc system' }
        }
      }

      try {
        const result = await (docClient as OneSystemsClient).createCase({
          caseTemplate: createParams!.caseTemplate,
          kennitala: createParams!.kennitala,
          caseName: createParams!.caseName,
          externalId: `ticket_${ticketId}`,
          currentUser: solvingAgentEmail
        })
        // LATCH — create path only, the INSTANT createCase resolves
        createdCaseNumber = result.caseNumber
        createdTemplate = result.caseTemplate
      } catch (err) {
        // SEPARATE catch — distinct from the inner steps-4-5 catch and the
        // outer 500. Nothing was minted, so NO created_case_number.
        logger.error('createCase failed', { brand_id: brandId, ticketId, error: (err as Error).message })
        await finalize(
          {
            ok: false,
            outcome: 'create_failed',
            intent: 'create',
            caseNumberSource: 'created',
            docSystem: ep.type,
            ticketId,
            durationMs: Date.now() - startTime,
            pdfFilename: `ticket-${ticketId}.pdf`,
            pdfSizeBytes: pdfBuffer.length,
            failedAttachments,
            sanitizedReason: 'Stofnun máls mistókst',
            timestamp: new Date().toISOString()
          },
          ep
        )
        return {
          status: 502,
          body: { ok: false, outcome: 'create_failed', error: 'Case creation failed' }
        }
      }
    }
    // else CASE_NUMBER PATH — createdCaseNumber stays undefined

    const caseNumber = createdCaseNumber ?? (body.case_number as string)

    // 4-5. INNER try wrapping ONLY steps 4-5 — separate from the outer 500
    //      AND from the createCase catch.
    try {
      // 4. Stamp the new case number onto the ticket (create path only)
      if (createdCaseNumber !== undefined && ep.caseNumberFieldId != null) {
        const { ZendeskClient } = await import('./zendesk.js')
        const zendesk = new ZendeskClient(
          tenantConfig.zendesk.subdomain,
          tenantConfig.zendesk.apiToken,
          tenantConfig.zendesk.email
        )
        await zendesk.setTicketCustomField(ticketId, ep.caseNumberFieldId, createdCaseNumber)
        // last_status: AUDIT/LOG ONLY — no Zendesk field, no EndpointConfig change
        logger.info('Stamped case number on ticket', {
          brand_id: brandId, ticketId, caseNumber: createdCaseNumber, last_status: 'CASE_STAMPED'
        })
      } else if (createdCaseNumber !== undefined) {
        logger.info('No caseNumberFieldId configured — skipping stamp (not an error)', {
          brand_id: brandId, ticketId, caseNumber: createdCaseNumber
        })
      }

      // 5. postToCase (upload the PDF into the case)
      await postToCase(docClient, caseNumber, ticket, ticketId, pdfBuffer, attachments)
    } catch (err) {
      if (createdCaseNumber !== undefined) {
        // CREATE PATH — a number was minted the caller does not yet have.
        // It must NEVER be silently lost: surface it via 207 orphan_case.
        logger.error('Post-create step failed — orphan case', {
          brand_id: brandId, ticketId, caseNumber: createdCaseNumber, error: (err as Error).message
        })
        await finalize(
          {
            ok: false,
            outcome: 'orphan_case',
            intent: 'create',
            caseNumber: createdCaseNumber,
            caseNumberSource: 'created',
            docSystem: ep.type,
            // orphan_case: case# is NOT re-written by the post-back
            // (the step-4 stamp already owns the field). Only the
            // status field + note are written via finalize.
            ticketId,
            durationMs: Date.now() - startTime,
            pdfFilename: `ticket-${ticketId}.pdf`,
            pdfSizeBytes: pdfBuffer.length,
            failedAttachments,
            sanitizedReason: 'Skjalfesting eftir stofnun máls mistókst',
            timestamp: new Date().toISOString()
          },
          ep
        )
        return {
          status: 207,
          body: {
            ok: false,
            outcome: 'orphan_case',
            error: (err as Error).message,
            caseNumber: createdCaseNumber
          }
        }
      }
      // CASE_NUMBER PATH — pre-existing case, nothing minted, retry safe.
      // GW-01 finalizer fires here (terminal failure) so the agent sees a
      // ❌ note + last_status. The HTTP 500 envelope from the OUTER catch
      // is UNCHANGED — finalize is a best-effort side-effect only.
      await finalize(
        {
          ok: false,
          outcome: 'failed',
          intent: 'case_number',
          caseNumber,
          caseNumberSource: 'provided',
          docSystem: ep.type,
          ticketId,
          durationMs: Date.now() - startTime,
          pdfFilename: `ticket-${ticketId}.pdf`,
          pdfSizeBytes: pdfBuffer.length,
          failedAttachments,
          sanitizedReason: 'Skjalfesting í fyrirliggjandi mál mistókst',
          timestamp: new Date().toISOString()
        },
        ep
      )
      // Rethrow to the OUTER catch → generic 500. NOT orphan_case, NO
      // created_case_number, no 8th code.
      throw err
    }

    // 6. Success
    const duration = Date.now() - startTime
    const lastExport = new Date().toISOString()
    await finalize(
      {
        ok: true,
        outcome: 'documented',
        intent: hasCreate ? 'create' : 'case_number',
        caseNumber,
        caseNumberSource: hasCreate ? 'created' : 'provided',
        docSystem: ep.type,
        // templateFieldId written ONLY on the OneSystems create path.
        template: hasCreate ? createdTemplate : undefined,
        ticketId,
        durationMs: duration,
        pdfFilename: `ticket-${ticketId}.pdf`,
        pdfSizeBytes: pdfBuffer.length,
        failedAttachments,
        timestamp: lastExport
      },
      ep
    )
    logger.info('Cases request complete', {
      brand_id: brandId, ticketId, docEndpoint, doc_system: ep.type,
      caseNumber, created: hasCreate, last_status: 'OK', last_export: lastExport
    })

    return {
      status: 200,
      body: {
        ok: true,
        outcome: 'documented',
        caseNumber
      }
    }
  } catch (error) {
    // Outer catch — the catch-all infra envelope (NOT one of the 7 codes,
    // NOT an 8th code). Mirrors attachments.ts:159-160 / webhook.ts:73-76
    // exactly. The case_number-path upload failure lands here.
    logger.error('Cases request failed', { brand_id: brandId, error: (error as Error).message })
    return { status: 500, body: { error: 'Internal server error', duration_ms: Date.now() - startTime } }
  }
}
