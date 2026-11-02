/**
 * GoPro (gopro.net) API Client - handles authentication and document upload
 *
 * Targets GoPro's "Tickets v1" integration API (the vendor's universal
 * ticket-system connection; requires the "GoPro Ticket System Integration
 * Module" licence; GoPro Foris 22.1.4+). baseUrl is the services root, e.g.
 * https://<host>/<instance>/services
 *
 * Contract per the vendor's "How to Set Up Zendesk Integration in GoPro
 * Foris" guide: WebKey → Authenticate → X-GoProToken (60 min default);
 * Documents/Create with Token + Gopro-Origin headers returns the new
 * document ID as a JSON string. Swagger omits `subject`; the guide has it.
 */

import { createLogger, capBody } from '../../platform/logger.js'
import type { Logger } from '../../platform/types.js'
import { fetchWithTimeout } from '../../platform/http.js'
import type { UploadDocumentParams, DocClient } from './types.js'

const logger: Logger = createLogger('gopro')

const DEFAULT_ORIGIN = 'Zendesk'

export class GoProClient implements DocClient {
  baseUrl: string
  apiKey: string
  origin: string
  tokenTtlMs: number
  token: string | null
  tokenExpiry: number | null

  constructor(baseUrl: string, apiKey: string, { tokenTtlMs = 25 * 60 * 1000, origin = DEFAULT_ORIGIN }: { tokenTtlMs?: number, origin?: string } = {}) {
    this.baseUrl = baseUrl
    this.apiKey = apiKey
    this.origin = origin
    this.tokenTtlMs = tokenTtlMs
    this.token = null
    this.tokenExpiry = null
  }

  async authenticate(): Promise<void> {
    logger.debug('Authenticating with GoPro')
    const response = await fetchWithTimeout(`${this.baseUrl}/Tickets/v1/Authenticate`, {
      method: 'POST',
      headers: { 'X-Api-Key': this.apiKey }
    })
    if (!response.ok) {
      throw new Error(`GoPro auth failed: ${response.status}`)
    }
    // Token is returned in the X-GoProToken response header; the body
    // (CurrentContextObject) also carries it as `token` — use as fallback.
    let token = response.headers?.get('X-GoProToken') || null
    if (!token) {
      try {
        const body = await response.json() as { token?: unknown }
        if (typeof body?.token === 'string' && body.token) token = body.token
      } catch {
        // non-JSON body — fall through to the missing-token error
      }
    }
    if (!token) {
      throw new Error('GoPro auth failed: no token in response')
    }
    this.token = token
    this.tokenExpiry = Date.now() + this.tokenTtlMs
    logger.info('GoPro authentication successful')
  }

  async ensureAuthenticated(): Promise<void> {
    if (!this.token || Date.now() > this.tokenExpiry!) {
      await this.authenticate()
    }
  }

  private postDocument(body: Record<string, string>): Promise<Response> {
    return fetchWithTimeout(`${this.baseUrl}/Tickets/v1/Documents/Create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Token': this.token!,
        'Gopro-Origin': 'foris'
      },
      body: JSON.stringify(body)
    })
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

    const results: unknown[] = []
    for (const file of allFiles) {
      const body = {
        caseNumber,
        subject: (metadata as Record<string, string>).subject || file.fileName,
        origin: this.origin,
        fileName: file.fileName,
        content: file.content
      }

      let response = await this.postDocument(body)

      // Token may expire server-side before our TTL — re-auth once and retry
      if (response.status === 401) {
        logger.info('GoPro token rejected, re-authenticating', { caseNumber })
        await this.authenticate()
        response = await this.postDocument(body)
      }

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`GoPro upload failed: ${response.status} - ${capBody(errorText)}`)
      }

      // Success body is the new document ID as a JSON string
      const text = await response.text()
      let result: unknown = text
      try {
        result = JSON.parse(text)
      } catch {
        // plain-string response
      }

      logger.info('Upload successful', { caseNumber, fileName: file.fileName, documentId: capBody(result) })
      results.push(result)
    }

    return results.length === 1 ? results[0] : results
  }
}
