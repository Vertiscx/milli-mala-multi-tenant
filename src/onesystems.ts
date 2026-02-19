/**
 * OneSystems API Client - handles authentication and document upload
 */

import { createLogger } from './logger.js'
import type { UploadDocumentParams, DocClient, Logger } from './types.js'

const logger: Logger = createLogger('onesystems')

export class OneSystemsClient implements DocClient {
  baseUrl: string
  appKey: string
  token: string | null
  tokenExpiry: number | null
  tokenTtlMs: number
  user: string

  constructor(baseUrl: string, appKey: string, { tokenTtlMs = 25 * 60 * 1000, user = '' }: { tokenTtlMs?: number; user?: string } = {}) {
    this.baseUrl = baseUrl
    this.appKey = appKey
    this.token = null
    this.tokenExpiry = null
    this.tokenTtlMs = tokenTtlMs
    this.user = user
  }

  async authenticate(): Promise<void> {
    logger.debug('Authenticating with OneSystems')
    const response = await fetch(`${this.baseUrl}/api/Authenticate/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey: this.appKey })
    })
    if (!response.ok) {
      throw new Error(`OneSystems auth failed: ${response.status}`)
    }
    const text = await response.text()
    let data: unknown
    try { data = JSON.parse(text) } catch { data = text }
    this.token = typeof data === 'string'
      ? data
      : ((data as Record<string, string>).token || (data as Record<string, string>).accessToken)
    this.tokenExpiry = Date.now() + this.tokenTtlMs
    logger.info('OneSystems authentication successful')
  }

  async ensureAuthenticated(): Promise<void> {
    if (!this.token || Date.now() > this.tokenExpiry!) {
      await this.authenticate()
    }
  }

  async uploadDocument({ caseNumber, filename, pdfBuffer, metadata = {} }: UploadDocumentParams): Promise<unknown> {
    await this.ensureAuthenticated()

    const boundary = `----formdata-${Date.now()}-${Math.random().toString(36).substring(2)}`
    const base64Pdf = pdfBuffer.toString('base64')

    // Sanitize text fields to prevent CRLF injection in multipart body
    const sanitize = (val: unknown): string => String(val).replace(/[\r\n]/g, '')

    // Escape XML special characters in metadata that ends up in the XML field
    const escapeXml = (val: unknown): string => String(val)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')

    const formParts: string[] = []

    formParts.push(`--${boundary}`)
    formParts.push(`Content-Disposition: form-data; name="CaseNumber"`)
    formParts.push('')
    formParts.push(sanitize(caseNumber))

    formParts.push(`--${boundary}`)
    formParts.push(`Content-Disposition: form-data; name="User"`)
    formParts.push('')
    formParts.push(sanitize(this.user || 'Zendesk'))

    formParts.push(`--${boundary}`)
    formParts.push(`Content-Disposition: form-data; name="FileName"`)
    formParts.push('')
    formParts.push(sanitize(filename))

    formParts.push(`--${boundary}`)
    formParts.push(`Content-Disposition: form-data; name="FileArray"`)
    formParts.push('')
    formParts.push(base64Pdf)

    formParts.push(`--${boundary}`)
    formParts.push(`Content-Disposition: form-data; name="Date"`)
    formParts.push('')
    formParts.push(new Date().toISOString())

    formParts.push(`--${boundary}`)
    formParts.push(`Content-Disposition: form-data; name="XML"`)
    formParts.push('')
    formParts.push((metadata as Record<string, string>).xml ? escapeXml((metadata as Record<string, string>).xml) : '')

    formParts.push(`--${boundary}--`)

    const body = formParts.join('\r\n')

    logger.info('Uploading to OneSystems', { caseNumber })

    const response = await fetch(`${this.baseUrl}/api/OneRecord/AddDocument2`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Accept': '*/*'
      },
      body
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`OneSystems upload failed: ${response.status} - ${errorText}`)
    }

    logger.info('Upload successful', { caseNumber })
    return response.json().catch(() => ({ success: true }))
  }
}
