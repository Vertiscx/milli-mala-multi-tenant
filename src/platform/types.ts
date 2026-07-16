/**
 * Shared type definitions for milli-mala multi-tenant.
 */

// ─── Tenant Configuration ────────────────────────────────────────────

export interface TenantConfig {
  brand_id: string
  name: string
  zendesk: ZendeskConfig
  endpoints: Record<string, EndpointConfig>
  malaskra: MalaskraConfig
  pdf: PdfConfig
}

export interface ZendeskConfig {
  subdomain: string
  email: string
  apiToken: string
  webhookSecret: string
}

export interface EndpointConfig {
  type: 'onesystems' | 'gopro'
  baseUrl: string
  appKey?: string           // OneSystems
  username?: string         // GoPro
  password?: string         // GoPro
  caseNumberFieldId?: number | null
  lastStatusFieldId?: number | null   // GW-01/GW-02 — status custom field
  lastExportFieldId?: number | null   // GW-01/GW-02 — last-export timestamp
  templateFieldId?: number | null     // NET-NEW — OneSystems caseTemplate
  kennitalaFieldId?: number | null    // NET-NEW — webhook create kennitala source
  tokenTtlMs?: number
}

export interface MalaskraConfig {
  apiKey: string
}

export interface PdfConfig {
  companyName: string
  locale: string
  includeInternalNotes: boolean
}

// ─── Zendesk API Types ───────────────────────────────────────────────

export interface ZendeskTicket {
  id: number
  subject: string
  status: string
  created_at: string
  updated_at?: string
  custom_fields?: ZendeskCustomField[]
  brand_id?: number
}

export interface ZendeskCustomField {
  id: number
  value: string | number | boolean | null
}

export interface ZendeskComment {
  id: number
  body?: string
  html_body?: string
  plain_body?: string
  public: boolean
  author_id: number
  created_at: string
  attachments?: ZendeskAttachment[]
}

export interface ZendeskAttachment {
  id: number
  file_name: string
  content_url: string
  content_type: string
  size: number
}

export interface ZendeskUser {
  id: number
  name: string
  email: string
}

// ─── Document System Types ───────────────────────────────────────────

export interface DownloadedAttachment {
  filename: string
  contentType: string
  size: number
  data: Buffer
}

/**
 * fetchAttachments result: the downloaded attachments AS a plain array
 * (byte-compatible with the pre-G4 contract) plus a non-enumerable
 * `failed` list of skipped/errored downloads for the GW-01 post-back.
 */
export type AttachmentsResult = DownloadedAttachment[] & {
  failed: { filename: string; reason: string }[]
}

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

export interface HandlerResult {
  status: number
  body: Record<string, unknown>
}

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

// ─── Audit Store ─────────────────────────────────────────────────────

export interface AuditStore {
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
  get(key: string, format?: string): Promise<unknown>
  list(options?: { prefix?: string; limit?: number }): Promise<{ keys: { name: string }[] }>
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

// ─── Logger ──────────────────────────────────────────────────────────

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
}
