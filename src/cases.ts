/**
 * Cases endpoint — synchronous manual documentation, called by the Malaskrá app.
 *
 * Malaskrá sends: { ticket_id, brand_id, doc_endpoint } plus EXACTLY ONE OF
 *   - create: { caseTemplate, kennitala, caseName? }  → mint a new case
 *   - case_number: string                             → document into an existing case
 *
 * Composes G1's documentTicket stage fns with G2's createCase /
 * setTicketCustomField. Mirrors src/attachments.ts (the proven sibling
 * handler) for the gate phase, then runs the LOCKED 6-step order.
 *
 * Core value: on the CREATE path a minted case number is NEVER silently
 * lost — if createCase succeeds but a later step fails, the response is
 * HTTP 207 outcome=orphan_case carrying created_case_number. On the
 * case_number path nothing is minted, so a later failure propagates to the
 * generic 500 envelope (retry-safe), exactly like the sibling handlers.
 */

import { timingSafeEqual, createHash } from 'node:crypto'
import { createLogger } from './logger.js'
import { resolveEndpoint, validateCaseNumber } from './tenant.js'
import { createDocClient } from './docClient.js'
import { fetchTicketInfo, renderPdf, postToCase, writeAudit } from './documentTicket.js'
import type { OneSystemsClient } from './onesystems.js'
import type { HandlerResult, TenantConfig, AuditStore, Logger } from './types.js'

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
      return { status: 401, body: { error: 'Invalid or missing API key', outcome: 'auth' } }
    }

    // Validate ticket_id
    const ticketId = Number(body.ticket_id)
    if (!Number.isInteger(ticketId) || ticketId <= 0) {
      return { status: 400, body: { error: 'Invalid or missing ticket_id', outcome: 'validation' } }
    }

    // Exactly-one-of: create XOR case_number
    const hasCreate = body.create != null
    const hasCase = typeof body.case_number === 'string' && (body.case_number as string).length > 0
    if (hasCreate === hasCase) {
      return { status: 400, body: { error: 'Provide exactly one of create or case_number', outcome: 'validation' } }
    }

    // case_number path: validate the supplied number
    if (hasCase) {
      const caseNumberError = validateCaseNumber(body.case_number as string)
      if (caseNumberError) {
        return { status: 400, body: { error: caseNumberError, outcome: 'validation' } }
      }
    }

    // create path: validate the create sub-shape
    let createParams: { caseTemplate: string; kennitala: string; caseName?: string } | undefined
    if (hasCreate) {
      const c = body.create as Record<string, unknown>
      const caseTemplate = typeof c?.caseTemplate === 'string' ? c.caseTemplate : ''
      const kennitala = typeof c?.kennitala === 'string' ? c.kennitala : ''
      if (!caseTemplate || !kennitala) {
        return { status: 400, body: { error: 'Missing caseTemplate or kennitala', outcome: 'validation' } }
      }
      createParams = {
        caseTemplate,
        kennitala,
        caseName: typeof c?.caseName === 'string' ? c.caseName : undefined
      }
    }

    logger.info('Cases request', { brand_id: brandId, ticketId, docEndpoint, intent: hasCreate ? 'create' : 'case_number' })

    // Validate doc_endpoint against tenant config — 400 if invalid
    let ep
    try {
      ep = resolveEndpoint(tenantConfig, docEndpoint)
    } catch (err) {
      return { status: 400, body: { error: (err as Error).message, outcome: 'validation' } }
    }

    // ─── LOCKED order (post-gate) ─────────────────────────────────────
    // Latched ONLY on the create path; stays undefined on the case_number path.
    let createdCaseNumber: string | undefined

    // 1. fetchTicketInfo (owns the fail-closed brand cross-check)
    const fetched = await fetchTicketInfo(tenantConfig, ticketId)
    if (!fetched.ok) {
      return {
        status: fetched.result.status,
        body: { ...fetched.result.body, outcome: 'brand_mismatch' }
      }
    }
    const { ticket, comments, attachments, userMap, solvingAgentEmail } = fetched.info

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
          body: { error: 'Case creation not supported for this doc system', outcome: 'gopro_create_unsupported' }
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
      } catch (err) {
        // SEPARATE catch — distinct from the inner steps-4-5 catch and the
        // outer 500. Nothing was minted, so NO created_case_number.
        logger.error('createCase failed', { brand_id: brandId, ticketId, error: (err as Error).message })
        return {
          status: 502,
          body: { error: 'Case creation failed', outcome: 'create_failed' }
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
        try {
          await writeAudit({
            brandId, ticketId, ticket, comments, attachments, tenantConfig,
            docEndpoint, ep, caseNumber: createdCaseNumber, pdfBuffer,
            durationMs: Date.now() - startTime, auditStore
          })
        } catch {
          // writeAudit never rejects, but stay defensive — the 207 is what matters.
        }
        return {
          status: 207,
          body: {
            error: (err as Error).message,
            outcome: 'orphan_case',
            created_case_number: createdCaseNumber,
            case_number: createdCaseNumber,
            ticket_id: ticketId,
            brand_id: brandId,
            doc_endpoint: docEndpoint,
            doc_system: ep.type,
            created: true,
            duration_ms: Date.now() - startTime
          }
        }
      }
      // CASE_NUMBER PATH — pre-existing case, nothing minted, retry safe.
      // Rethrow to the OUTER catch → generic 500. NOT orphan_case, NO
      // created_case_number, no 8th code.
      throw err
    }

    // 6. Success
    const duration = Date.now() - startTime
    await writeAudit({
      brandId, ticketId, ticket, comments, attachments, tenantConfig,
      docEndpoint, ep, caseNumber, pdfBuffer, durationMs: duration, auditStore
    })
    logger.info('Cases request complete', {
      brand_id: brandId, ticketId, docEndpoint, doc_system: ep.type,
      caseNumber, created: hasCreate, last_status: 'OK', last_export: new Date().toISOString()
    })

    return {
      status: 200,
      body: {
        success: true,
        ticket_id: ticketId,
        brand_id: brandId,
        case_number: caseNumber,
        doc_endpoint: docEndpoint,
        doc_system: ep.type,
        created: hasCreate,
        outcome: 'documented',
        duration_ms: duration
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
