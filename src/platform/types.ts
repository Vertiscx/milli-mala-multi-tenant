/**
 * Shared type definitions for milli-mala multi-tenant.
 */

// ─── Tenant Configuration ────────────────────────────────────────────

export interface TenantConfig {
  brand_id: string
  name: string
  zendesk: ZendeskConfig
  services: {
    archive?: ArchiveServiceConfig
    ticketUpdate?: TicketUpdateServiceConfig
    ticketCreate?: TicketCreateServiceConfig
  }
}

// Config for the ticketCreate service (src/services/ticketCreate/), called
// by a system outside Zendesk (e.g. a web form's backend), so it is
// authenticated by a per-tenant API key rather than a Zendesk webhook
// signature. Its OAuth client is separate from ticketUpdate's.
//
// The ID lists bound what a caller can choose on the shared Zendesk
// account: a group_id or ticket_form_id not listed here is dropped from
// the ticket rather than sent, so one institution's form can't route
// tickets into another institution's groups or forms.
export interface TicketCreateServiceConfig {
  apiKey: string
  oauth: {
    clientId: string
    clientSecret: string
  }
  allowedGroupIds: number[]
  allowedFormIds: number[]
}

// Credentials for the ticketUpdate service (src/services/ticketUpdate/):
// a Zendesk OAuth client (Client Credentials grant) this service uses to
// call the Zendesk API on Zendesk's own behalf, in place of the tenant's
// Basic-auth apiToken. Scoped under services (not the shared zendesk
// block above) because it belongs to one specific service, the same way
// ArchiveServiceConfig's endpoint credentials do.
//
// webhookSecret is deliberately separate from zendesk.webhookSecret above:
// Zendesk generates one independent signing secret per webhook target and
// never lets it be set to a chosen value (confirmed against Zendesk's own
// webhook API docs), so the webhook target that calls this service's
// endpoint has its own secret, distinct from the one signing the archive
// webhook.
export interface TicketUpdateServiceConfig {
  webhookSecret: string
  oauth: {
    clientId: string
    clientSecret: string
  }
}

// The archive section groups what used to sit at the top level.
// It stays defined in platform/types.ts for now, because the folder rule says
// platform code may not import from services — moving it fully into the
// service needs per-service config loading, which is future work.
export interface ArchiveServiceConfig {
  endpoints: Record<string, EndpointConfig>
  malaskra: MalaskraConfig
  pdf: PdfConfig
}

// email, apiToken and webhookSecret are used only by the archive service
// (Basic-auth Zendesk client, archive webhook signature), so they are
// required only for tenants with services.archive — see validateArchiveConfig.
export interface ZendeskConfig {
  subdomain: string
  email?: string
  apiToken?: string
  webhookSecret?: string
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

// ─── Handler Types ───────────────────────────────────────────────────

export interface HandlerResult {
  status: number
  body: Record<string, unknown>
}

// ─── Audit Store ─────────────────────────────────────────────────────

export interface AuditStore {
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
  get(key: string, format?: string): Promise<unknown>
  list(options?: { prefix?: string; limit?: number }): Promise<{ keys: { name: string }[] }>
}

// ─── Logger ──────────────────────────────────────────────────────────

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
}
