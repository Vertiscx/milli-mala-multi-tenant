/**
 * Zendesk API Client - fetches tickets, comments, and attachments
 */

import { createLogger } from './logger.js'
import type { ZendeskTicket, ZendeskComment, ZendeskUser, DownloadedAttachment, Logger } from './types.js'

const logger: Logger = createLogger('zendesk')

export class ZendeskClient {
  baseUrl: string
  auth: string

  constructor(subdomain: string, apiToken: string, email: string) {
    this.baseUrl = `https://${subdomain}.zendesk.com/api/v2`
    this.auth = Buffer.from(`${email}/token:${apiToken}`).toString('base64')
  }

  async request(endpoint: string): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      headers: { 'Authorization': `Basic ${this.auth}`, 'Content-Type': 'application/json' }
    })
    if (!response.ok) {
      throw new Error(`Zendesk API error: ${response.status} ${response.statusText}`)
    }
    return response.json() as Promise<Record<string, unknown>>
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

  async fetchAttachments(
    comments: ZendeskComment[],
    { maxFiles = 50, maxTotalBytes = 100 * 1024 * 1024 }: { maxFiles?: number; maxTotalBytes?: number } = {}
  ): Promise<DownloadedAttachment[]> {
    const attachments: DownloadedAttachment[] = []
    let totalBytes = 0
    for (const comment of comments) {
      if (!comment.attachments) continue
      for (const att of comment.attachments) {
        if (attachments.length >= maxFiles) {
          logger.warn('Attachment count limit reached', { maxFiles })
          return attachments
        }
        try {
          // SSRF protection: only allow genuine Zendesk URLs
          const attUrl = new URL(att.content_url)
          if (attUrl.protocol !== 'https:') {
            logger.warn('Skipping non-HTTPS attachment URL', { url: att.content_url })
            continue
          }
          // Proper domain check: extract the last two labels and compare exactly.
          // This prevents bypasses like "evil-zendesk.com" matching ".zendesk.com".
          const hostParts = attUrl.hostname.split('.')
          const domain = hostParts.slice(-2).join('.')
          if (domain !== 'zendesk.com' && domain !== 'zdassets.com') {
            logger.warn('Skipping non-Zendesk attachment URL', { url: att.content_url })
            continue
          }
          const response = await fetch(att.content_url, {
            headers: { 'Authorization': `Basic ${this.auth}` }
          })
          if (!response.ok) {
            logger.warn('Attachment download returned non-OK status', {
              filename: att.file_name, status: response.status
            })
            continue
          }
          const buffer = Buffer.from(await response.arrayBuffer())
          if (totalBytes + buffer.length > maxTotalBytes) {
            logger.warn('Attachment total size limit reached', { maxTotalBytes, currentBytes: totalBytes })
            return attachments
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
        }
      }
    }
    return attachments
  }
}
