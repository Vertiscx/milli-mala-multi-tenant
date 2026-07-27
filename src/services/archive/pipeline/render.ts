import { generateTicketPdf } from '../pdf.js'
import type { TenantConfig, ZendeskTicket, ZendeskComment } from '../../../platform/types.js'

/**
 * Render the ticket PDF. Owns the generateTicketPdf call.
 */
export async function renderPdf(
  ticket: ZendeskTicket,
  comments: ZendeskComment[],
  tenantConfig: TenantConfig,
  userMap: Record<number, string>
): Promise<Buffer> {
  return generateTicketPdf(ticket, comments, {
    // Non-null guaranteed by the entry-point archive guards (webhook/attachments/cases).
    pdfConfig: tenantConfig.services.archive!.pdf,
    userMap
  })
}
