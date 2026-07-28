import { createLogger } from '../../../platform/logger.js'
import type {
  TenantConfig,
  EndpointConfig,
  ZendeskTicket,
  ZendeskComment,
  DownloadedAttachment,
  AuditStore,
  Logger
} from '../../../platform/types.js'
import type { DocumentationOutcome, AuditEnrichment } from '../types.js'

const logger: Logger = createLogger('documentTicket')

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
      // Non-null guaranteed by the entry-point archive guards (webhook/attachments/cases).
      internal_notes_included: tenantConfig.services.archive!.pdf.includeInternalNotes,
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
 * The standard full-enrichment set — reproduces the exact key values the
 * old recordOutcome inference ladder computed for non-webhook intents:
 * event mapping, WR-01 absent-caseNumber normalization, last_status
 * mapping, last_export only on success. Producers that want the standard
 * treatment call this; special paths (created-latch, loud-fail rejects)
 * declare their keys inline instead.
 */
export function standardEnrichment(o: DocumentationOutcome): AuditEnrichment {
  return {
    event: o.outcome === 'documented' ? 'ticket_archived'
      : o.outcome === 'orphan_case' ? 'orphan_case'
      : o.outcome,
    outcome: o.outcome,
    // WR-01: never persist a source claim for an ABSENT case number.
    caseNumberSource: o.caseNumber === undefined ? 'none' : o.caseNumberSource,
    intent: o.intent,
    lastStatus: o.outcome === 'documented' ? 'OK'
      : o.outcome === 'orphan_case' ? 'ORPHAN'
      : 'FAILED',
    ...(o.outcome === 'documented' ? { lastExport: o.timestamp } : {})
  }
}
