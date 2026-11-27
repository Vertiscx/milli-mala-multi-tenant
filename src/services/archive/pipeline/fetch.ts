import { ZendeskClient, createZendeskClient } from '../../../platform/zendesk.js'
import { createLogger } from '../../../platform/logger.js'
import type {
  HandlerResult,
  TenantConfig,
  ZendeskTicket,
  ZendeskComment,
  ZendeskUser,
  SideConversationThread,
  DownloadedAttachment,
  Logger
} from '../../../platform/types.js'

import { collectImageSources, prepareInlineImages } from '../inlineImages.js'
import type { InlineImageMap } from '../types.js'

const logger: Logger = createLogger('documentTicket')

export interface TicketInfo {
  zendesk: ZendeskClient
  ticket: ZendeskTicket
  comments: ZendeskComment[]
  /** Empty unless the tenant's pdf.includeSideConversations is true. */
  sideConversations: SideConversationThread[]
  /** The ticket's attachments, plus pasted images sent as separate files. */
  attachments: DownloadedAttachment[]
  failedAttachments: { filename: string; reason: string }[]
  /** Decision per pasted image, by src, for the PDF. */
  inlineImages: InlineImageMap
  userMap: Record<number, string>
  solvingAgentEmail: string
}

/**
 * Fetch ticket + comments + (opt-in) side conversations + attachments +
 * pasted images, and resolve comment authors.
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
  const zendesk = createZendeskClient(tenantConfig)
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

  // Side conversations, only for tenants that opted in. Unlike author
  // names this is NOT best-effort: a failure throws like a failed comments
  // fetch (500, Zendesk retries, nothing minted yet), so a tenant that
  // asked for side conversations never gets a PDF silently missing them.
  const sideConversations: SideConversationThread[] = []
  if (tenantConfig.services.archive?.pdf?.includeSideConversations === true) {
    for (const sideConversation of await zendesk.getSideConversations(ticketId)) {
      const events = await zendesk.getSideConversationEvents(ticketId, sideConversation.id)
      sideConversations.push({ sideConversation, events })
    }
  }

  const downloaded = await zendesk.fetchAttachments(comments)

  // Images pasted into the text, but only from what the PDF will show:
  // internal notes only if the tenant includes them, side conversations
  // only if it includes those (the list above is empty otherwise). The
  // same body fields as pdf.ts, so every <img> drawn has a decision.
  const pdfConfig = tenantConfig.services.archive?.pdf
  const shownComments = pdfConfig?.includeInternalNotes === true
    ? comments
    : comments.filter(c => c.public !== false)
  const inline = await prepareInlineImages(
    zendesk,
    collectImageSources([
      ...shownComments.map(c => c.html_body || c.body || c.plain_body || ''),
      ...sideConversations.flatMap(t => t.events.map(e => e.message?.html_body || e.message?.body || ''))
    ]),
    downloaded,
    brandId
  )
  // Images that could not be drawn go to the archive with the attachments;
  // images with no file are reported with the failed attachments.
  const attachments: DownloadedAttachment[] = inline.separateFiles.length > 0
    ? [...downloaded, ...inline.separateFiles]
    : downloaded
  const failedAttachments = [...(downloaded.failed ?? []), ...inline.failed]

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

  return { ok: true, info: { zendesk, ticket, comments, sideConversations, attachments, failedAttachments, inlineImages: inline.images, userMap, solvingAgentEmail } }
}
