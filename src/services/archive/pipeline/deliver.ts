import type { ZendeskTicket, DownloadedAttachment } from '../../../platform/types.js'
import type { DocClient } from '../types.js'

/**
 * Upload the document using an already-constructed doc client.
 * The client is built earlier (in documentTicket) so createDocClient's
 * misconfigured-endpoint throw keeps its original precedence relative
 * to validateCaseNumber's 400 (behavior-preserving).
 */
export async function postToCase(
  docClient: DocClient,
  caseNumber: string,
  ticket: ZendeskTicket,
  ticketId: number,
  pdfBuffer: Buffer,
  attachments: DownloadedAttachment[]
): Promise<void> {
  const uploadFilename = `ticket-${ticketId}.pdf`

  await docClient.uploadDocument({
    caseNumber,
    filename: uploadFilename,
    pdfBuffer,
    attachments,
    metadata: { ticketId, subject: ticket.subject }
  })
}
