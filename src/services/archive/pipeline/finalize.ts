/**
 * Webhook failure-finalize — extracted verbatim from documentTicket.ts's
 * outer catch body.
 *
 * GW-01 webhook FAILURE post-back. Best-effort: defensively guards every
 * field that may be undefined if the throw happened early (before
 * ticket/pdfBuffer exist). recordOutcome/postResultToTicket never throw,
 * but a throw here must not blow up the caller's rethrow — so the whole
 * failure-finalize is itself wrapped and NEVER throws.
 */

import { createLogger } from '../../../platform/logger.js'
import { createDocClient } from '../docClient.js'
import { recordOutcome } from '../postResultToTicket.js'
import { standardEnrichment } from './audit.js'
import type { OneSystemsClient } from '../onesystems.js'
import type {
  TenantConfig,
  EndpointConfig,
  ZendeskTicket,
  ZendeskComment,
  DownloadedAttachment,
  AuditStore,
  Logger
} from '../../../platform/types.js'
import type { DocumentationOutcome } from '../types.js'

const logger: Logger = createLogger('documentTicket')

export async function finalizeWebhookFailure(args: {
  tenantConfig: TenantConfig
  ep: EndpointConfig
  docEndpoint: string
  ticketId: number
  startTime: number
  ticket?: ZendeskTicket
  comments?: ZendeskComment[]
  attachments?: DownloadedAttachment[]
  failedAttachments?: { filename: string; reason: string }[]
  pdfBuffer?: Buffer
  resolvedCaseNumber?: string
  mintedByCreate: boolean
  clientCanCreate?: boolean
  auditStore?: AuditStore
}): Promise<void> {
  const {
    tenantConfig, ep, docEndpoint, ticketId, startTime,
    ticket, comments, attachments, failedAttachments, pdfBuffer,
    resolvedCaseNumber, mintedByCreate, auditStore
  } = args
  let clientCanCreate = args.clientCanCreate
  const brandId = tenantConfig.brand_id

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
    const o: DocumentationOutcome = {
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
    }
    o.auditEnrichment = mintedByCreate
      ? { caseNumberSource: 'created' }
      : standardEnrichment(o)
    await recordOutcome(
      o,
      {
        tenantConfig,
        ep,
        docEndpoint,
        // ticket/comments/attachments may be undefined if the throw
        // happened before fetchTicketInfo resolved — fall back to
        // minimal stand-ins so writeAudit/postResultToTicket can still
        // emit the ❌ note + last_status=failed.
        ticket: ticket ?? ({ id: ticketId, subject: '', status: '', created_at: '' } as ZendeskTicket),
        comments: comments ?? [],
        attachments: attachments ?? [],
        pdfBuffer: pdfBuffer ?? Buffer.alloc(0),
        auditStore
      }
    )
  } catch (finalizeErr) {
    // Never let the failure-finalize itself break the caller's rethrow.
    logger.warn('Failure-finalize failed (swallowed)', {
      brand_id: brandId, ticket_id: ticketId, error: (finalizeErr as Error).message
    })
  }
}
