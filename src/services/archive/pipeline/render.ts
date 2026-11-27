import { generateTicketPdf } from '../pdf.js'
import type { TenantConfig, ZendeskTicket, ZendeskComment, SideConversationThread } from '../../../platform/types.js'
import type { InlineImageMap } from '../types.js'

/**
 * Render the ticket PDF. Owns the generateTicketPdf call.
 */
export async function renderPdf(
  ticket: ZendeskTicket,
  comments: ZendeskComment[],
  tenantConfig: TenantConfig,
  userMap: Record<number, string>,
  sideConversations: SideConversationThread[] = [],
  inlineImages: InlineImageMap = new Map()
): Promise<Buffer> {
  return generateTicketPdf(ticket, comments, {
    // Non-null guaranteed by the entry-point archive guards (webhook/attachments/cases).
    pdfConfig: tenantConfig.services.archive!.pdf,
    userMap,
    sideConversations,
    inlineImages
  })
}
