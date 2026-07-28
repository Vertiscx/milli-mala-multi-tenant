import { ZendeskClient } from '../../../platform/zendesk.js'
import { createLogger } from '../../../platform/logger.js'
import type {
  HandlerResult,
  TenantConfig,
  ZendeskTicket,
  ZendeskComment,
  ZendeskUser,
  DownloadedAttachment,
  Logger
} from '../../../platform/types.js'

const logger: Logger = createLogger('documentTicket')

export interface TicketInfo {
  zendesk: ZendeskClient
  ticket: ZendeskTicket
  comments: ZendeskComment[]
  attachments: DownloadedAttachment[]
  failedAttachments: { filename: string; reason: string }[]
  userMap: Record<number, string>
  solvingAgentEmail: string
}

/**
 * Fetch ticket + comments + attachments and resolve comment authors.
 * Owns the fail-closed brand cross-check (returns the exact 403
 * HandlerResult, never throws) and the best-effort author-resolution
 * inner try/catch (a getUsersMany rejection does NOT propagate).
 */
export async function fetchTicketInfo(
  tenantConfig: TenantConfig,
  ticketId: number
): Promise<{ ok: true; info: TicketInfo } | { ok: false; result: HandlerResult }> {
  const brandId = tenantConfig.brand_id

  // 1. Fetch ticket from Zendesk
  const zendesk = new ZendeskClient(
    tenantConfig.zendesk.subdomain,
    tenantConfig.zendesk.apiToken,
    tenantConfig.zendesk.email
  )
  const ticket = await zendesk.getTicket(ticketId)

  // Brand cross-check: verify the ticket belongs to this tenant's brand (fail-closed)
  if (ticket.brand_id === undefined || ticket.brand_id === null) {
    logger.error('Ticket missing brand_id — cannot verify tenant ownership', {
      brand_id: brandId, ticket_id: ticketId
    })
    return { ok: false, result: { status: 403, body: { error: 'Ticket brand_id unavailable' } } }
  }
  if (String(ticket.brand_id) !== brandId) {
    logger.warn('Brand mismatch: ticket belongs to different brand', {
      brand_id: brandId, ticket_brand_id: ticket.brand_id, ticket_id: ticketId
    })
    return { ok: false, result: { status: 403, body: { error: 'Ticket does not belong to this brand' } } }
  }

  const comments = await zendesk.getTicketComments(ticketId)
  const attachments = await zendesk.fetchAttachments(comments)
  const failedAttachments = attachments.failed ?? []

  // 2. Resolve all comment author names in one batch
  const authorIds = [...new Set(comments.map(c => c.author_id).filter(Boolean))]
  let authors: ZendeskUser[] = []
  try {
    authors = authorIds.length > 0 ? await zendesk.getUsersMany(authorIds) : []
  } catch (err) {
    logger.warn('Could not resolve author names', { brand_id: brandId, error: (err as Error).message })
  }
  const userMap: Record<number, string> = Object.fromEntries(authors.map(u => [u.id, u.name || u.email || `User ${u.id}`]))

  // Resolve the solving agent's email from the last comment
  let solvingAgentEmail = 'Zendesk'
  if (comments.length > 0) {
    const lastComment = comments[comments.length - 1]
    if (lastComment.author_id) {
      const user = authors.find(u => u.id === lastComment.author_id)
      if (user?.email) solvingAgentEmail = user.email
    }
  }

  return { ok: true, info: { zendesk, ticket, comments, attachments, failedAttachments, userMap, solvingAgentEmail } }
}
