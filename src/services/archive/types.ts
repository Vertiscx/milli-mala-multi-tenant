import type { TenantConfig, AuditStore, DownloadedAttachment } from '../../platform/types.js'

// ─── Document System Types ───────────────────────────────────────────

export interface UploadDocumentParams {
  caseNumber: string
  filename: string
  pdfBuffer: Buffer
  attachments?: DownloadedAttachment[]
  metadata?: Record<string, unknown>
}

export interface DocClient {
  uploadDocument(params: UploadDocumentParams): Promise<unknown>
}

export interface CreateCaseParams {
  caseTemplate: string
  kennitala: string
  externalId?: string
  caseName?: string
  currentUser?: string
}

export interface CreateCaseResult {
  caseNumber: string
  caseTemplate: string
}

// ─── Documentation Outcome (GW-01 finalization seam) ─────────────────

/**
 * Explicit audit-entry enrichment, DECLARED by the code path that
 * produces the DocumentationOutcome — recordOutcome never infers it.
 * Absent (undefined) means "no enrichment": the persisted entry keeps
 * the legacy byte-identical webhook-success shape (no extra keys).
 * Key names mirror writeAudit's optional args 1:1.
 */
export interface AuditEnrichment {
  event?: string
  outcome?: string
  caseNumberSource?: string
  lastStatus?: string
  lastExport?: string
  intent?: string
}

/**
 * Typed object built by each pipeline path at its terminal point and
 * passed once to recordOutcome(). Carries everything writeAudit +
 * postResultToTicket need; no path-specific branching downstream.
 */
export interface DocumentationOutcome {
  ok: boolean
  outcome: 'documented' | 'orphan_case' | 'create_failed' | 'failed'
    // Phase 7 loud-fail webhook rejects (WHCC-05, AUDIT-01/02): the three
    // former fall-through-to-ZD- modes, each a distinct 422 audit outcome.
    | 'missing_template' | 'missing_kennitala' | 'missing_case_number_field_config'
  intent: 'create' | 'case_number' | 'webhook'
  caseNumber?: string
  caseNumberSource: string
  docSystem: string
  template?: string                       // OneSystems create path only
  ticketId: number
  durationMs: number
  pdfFilename: string
  pdfSizeBytes: number
  failedAttachments: { filename: string; reason: string }[]
  sanitizedReason?: string
  timestamp: string
  auditRef?: string
  auditEnrichment?: AuditEnrichment
}

// ─── Handler Types ───────────────────────────────────────────────────

export interface WebhookRequest {
  body: Record<string, unknown>
  rawBody: string
  headers: Record<string, string>
  tenantConfig: TenantConfig
  docEndpoint: string
  auditStore?: AuditStore
}

export interface AttachmentsRequest {
  body: Record<string, unknown>
  headers: Record<string, string>
  tenantConfig: TenantConfig
  docEndpoint: string
}

// ─── PDF Rendering Types ─────────────────────────────────────────────

export interface PdfBlock {
  type: string
  runs: PdfRun[]
  indent: number
  /** type 'image' only: the <img> src, entities decoded. */
  src?: string
}

/**
 * What the PDF does with one image pasted into a comment or a side
 * conversation message, decided before rendering (inlineImages.ts):
 *  - embed:    drawn in the PDF where it was pasted
 *  - separate: downloaded but not drawable (format, damaged, too large);
 *              a placeholder in the PDF, the file sent to the archive
 *  - failed:   no file to send (download refused or failed, or a limit
 *              was reached); a placeholder in the PDF, listed in the
 *              result note as a failed attachment
 */
export type InlineImage =
  | { kind: 'embed'; data: Uint8Array; format: 'PNG' | 'JPEG'; width: number; height: number }
  | { kind: 'separate' | 'failed'; placeholder: string }

/** Keyed by the <img> src exactly as parseHtmlToBlocks returns it. */
export type InlineImageMap = Map<string, InlineImage>

export interface PdfRun {
  text: string
  bold: boolean
  italic: boolean
}
