/**
 * Zendesk API Client - fetches tickets, comments, and attachments
 */

import { createLogger } from './logger.js'
import { fetchWithTimeout } from './http.js'
import type { ZendeskTicket, ZendeskComment, ZendeskUser, DownloadedAttachment, AttachmentsResult, Logger } from './types.js'

const logger: Logger = createLogger('zendesk')

export class ZendeskClient {
  baseUrl: string
  auth: string

  constructor(subdomain: string, apiToken: string, email: string) {
    this.baseUrl = `https://${subdomain}.zendesk.com/api/v2`
    this.auth = Buffer.from(`${email}/token:${apiToken}`).toString('base64')
  }

  async request(endpoint: string): Promise<Record<string, unknown>> {
    const response = await fetchWithTimeout(`${this.baseUrl}${endpoint}`, {
      headers: { 'Authorization': `Basic ${this.auth}`, 'Content-Type': 'application/json' }
    })
    if (!response.ok) {
      throw new Error(`Zendesk API error: ${response.status} ${response.statusText}`)
    }
    return response.json() as Promise<Record<string, unknown>>
  }

  async requestWrite(
    endpoint: string,
    method: 'PUT' | 'POST',
    body: unknown
  ): Promise<Record<string, unknown>> {
    const response = await fetchWithTimeout(`${this.baseUrl}${endpoint}`, {
      method,
      headers: { 'Authorization': `Basic ${this.auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!response.ok) {
      throw new Error(`Zendesk API error: ${response.status} ${response.statusText}`)
    }
    return response.json() as Promise<Record<string, unknown>>
  }

  async setTicketCustomField(
    ticketId: number,
    fieldId: number,
    value: string | number | boolean | null
  ): Promise<void> {
    await this.requestWrite(
      `/tickets/${ticketId}.json`,
      'PUT',
      { ticket: { custom_fields: [{ id: fieldId, value }] } }
    )
  }

  async getTicket(ticketId: number): Promise<ZendeskTicket> {
    const data = await this.request(`/tickets/${ticketId}.json`)
    return data.ticket as ZendeskTicket
  }

  async getTicketComments(ticketId: number): Promise<ZendeskComment[]> {
    const data = await this.request(`/tickets/${ticketId}/comments.json`)
    return (data.comments as ZendeskComment[]) || []
  }

  async getUser(userId: number): Promise<ZendeskUser> {
    const data = await this.request(`/users/${userId}.json`)
    return data.user as ZendeskUser
  }

  async getUsersMany(userIds: number[]): Promise<ZendeskUser[]> {
    if (!userIds.length) return []
    const data = await this.request(`/users/show_many.json?ids=${userIds.join(',')}`)
    return (data.users as ZendeskUser[]) || []
  }

  /**
   * Returns the downloaded attachments AS the array (byte-compatible with
   * the pre-G4 array contract — `.length`, indexing, `toEqual([])` all
   * unchanged). The list of attachments that were skipped/failed to
   * download is exposed via a NON-ENUMERABLE `.failed` property so
   * structural array equality in the pre-g3 test suite is unaffected,
   * while G4 callers can read `.failed` for the GW-01 post-back note.
   */
  async fetchAttachments(
    comments: ZendeskComment[],
    { maxFiles = 50, maxTotalBytes = 100 * 1024 * 1024 }: { maxFiles?: number; maxTotalBytes?: number } = {}
  ): Promise<AttachmentsResult> {
    const attachments: DownloadedAttachment[] = []
    const failed: { filename: string; reason: string }[] = []
    let totalBytes = 0
    const finalize = (): AttachmentsResult => {
      Object.defineProperty(attachments, 'failed', {
        value: failed, enumerable: false, configurable: true, writable: true
      })
      return attachments as AttachmentsResult
    }
    for (const comment of comments) {
      if (!comment.attachments) continue
      for (const att of comment.attachments) {
        if (attachments.length >= maxFiles) {
          logger.warn('Attachment count limit reached', { maxFiles })
          return finalize()
        }
        try {
          // SSRF protection: only allow genuine Zendesk URLs
          const attUrl = new URL(att.content_url)
          if (attUrl.protocol !== 'https:') {
            logger.warn('Skipping non-HTTPS attachment URL', { url: att.content_url })
            failed.push({ filename: att.file_name, reason: 'non-HTTPS URL' })
            continue
          }
          // Proper domain check: extract the last two labels and compare exactly.
          // This prevents bypasses like "evil-zendesk.com" matching ".zendesk.com".
          const hostParts = attUrl.hostname.split('.')
          const domain = hostParts.slice(-2).join('.')
          if (domain !== 'zendesk.com' && domain !== 'zdassets.com') {
            logger.warn('Skipping non-Zendesk attachment URL', { url: att.content_url })
            failed.push({ filename: att.file_name, reason: 'non-Zendesk URL' })
            continue
          }
          const response = await fetchWithTimeout(att.content_url, {
            headers: { 'Authorization': `Basic ${this.auth}` }
          })
          if (!response.ok) {
            logger.warn('Attachment download returned non-OK status', {
              filename: att.file_name, status: response.status
            })
            failed.push({ filename: att.file_name, reason: `download status ${response.status}` })
            continue
          }
          const buffer = Buffer.from(await response.arrayBuffer())
          if (totalBytes + buffer.length > maxTotalBytes) {
            logger.warn('Attachment total size limit reached', { maxTotalBytes, currentBytes: totalBytes })
            failed.push({ filename: att.file_name, reason: 'total size limit reached' })
            return finalize()
          }
          totalBytes += buffer.length
          attachments.push({
            filename: att.file_name,
            contentType: att.content_type,
            size: att.size,
            data: buffer
          })
          logger.debug('Downloaded attachment', { filename: att.file_name, size: att.size })
        } catch (error) {
          logger.warn('Failed to download attachment', { filename: att.file_name, error: (error as Error).message })
          failed.push({ filename: att.file_name, reason: 'download error' })
        }
      }
    }
    return finalize()
  }
}
