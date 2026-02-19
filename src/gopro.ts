/**
 * GoPro (gopro.net) API Client - handles authentication and document upload
 */

import { createLogger } from './logger.js'
import type { UploadDocumentParams, DocClient, Logger } from './types.js'

const logger: Logger = createLogger('gopro')

export class GoProClient implements DocClient {
  baseUrl: string
  username: string
  password: string
  tokenTtlMs: number
  token: string | null
  tokenExpiry: number | null

  constructor(baseUrl: string, username: string, password: string, { tokenTtlMs = 25 * 60 * 1000 }: { tokenTtlMs?: number } = {}) {
    this.baseUrl = baseUrl
    this.username = username
    this.password = password
    this.tokenTtlMs = tokenTtlMs
    this.token = null
    this.tokenExpiry = null
  }

  async authenticate(): Promise<void> {
    logger.debug('Authenticating with GoPro')
    const response = await fetch(`${this.baseUrl}/v2/Authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.username, password: this.password })
    })
    if (!response.ok) {
      throw new Error(`GoPro auth failed: ${response.status}`)
    }
    const token = await response.text()
    // Response is a plain string token, strip any surrounding quotes
    this.token = token.replace(/^"|"$/g, '')
    this.tokenExpiry = Date.now() + this.tokenTtlMs
    logger.info('GoPro authentication successful')
  }

  async ensureAuthenticated(): Promise<void> {
    if (!this.token || Date.now() > this.tokenExpiry!) {
      await this.authenticate()
    }
  }

  async uploadDocument({ caseNumber, filename, pdfBuffer, attachments = [], metadata = {} }: UploadDocumentParams): Promise<unknown> {
    await this.ensureAuthenticated()

    // GoPro API accepts one file per call, so upload each separately
    const allFiles = [
      { fileName: filename, content: pdfBuffer.toString('base64') },
      ...attachments.map(att => ({
        fileName: att.filename,
        content: att.data.toString('base64')
      }))
    ]

    logger.info('Uploading to GoPro', { caseNumber, fileCount: allFiles.length })

    const results: Record<string, unknown>[] = []
    for (const file of allFiles) {
      const body = {
        caseNumber,
        subject: (metadata as Record<string, string>).subject || file.fileName,
        fileName: file.fileName,
        content: file.content
      }

      const response = await fetch(`${this.baseUrl}/v2/Documents/Create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify(body)
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`GoPro upload failed: ${response.status} - ${errorText}`)
      }

      const result = await response.json() as Record<string, unknown>
      if (!result.succeeded) {
        throw new Error(`GoPro upload rejected: ${result.message || 'succeeded=false'}`)
      }

      logger.info('Upload successful', { caseNumber, fileName: file.fileName, identifier: result.identifier })
      results.push(result)
    }

    return results.length === 1 ? results[0] : results
  }
}
