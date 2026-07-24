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
}

export interface PdfRun {
  text: string
  bold: boolean
  italic: boolean
}
