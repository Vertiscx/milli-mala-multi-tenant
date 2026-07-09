/**
 * OneSystems API Client - handles authentication and document upload
 */

import { createLogger, capBody } from '../../platform/logger.js'
import type { Logger } from '../../platform/types.js'
import type { UploadDocumentParams, DocClient, CreateCaseParams, CreateCaseResult } from './types.js'

const logger: Logger = createLogger('onesystems')

// Ported verbatim from app malaskra_v3/src/clients/onesystems/cases.ts:104
const DEFAULT_EXTERNAL_USER = 'Zendesk'

// Ported verbatim from cases.ts:151-153 — strip every non-digit. No length assertion.
function normalizeKennitala(raw: string): string {
  return raw.replace(/\D+/g, '')
}

/**
 * Re-derived (no zod) from cases.ts:171-198 — exact 7-branch waterfall,
 * first-match-wins, matched-but-empty-string yields '' and does NOT fall
 * through. Only string|number accepted at a key (StringOrNumber union);
 * anything else at a matched key → treated as missing ('').
 */
function extractCaseNumber(res: unknown): string {
  if (typeof res === 'string') return res
  if (typeof res === 'number') return String(res)
  if (typeof res !== 'object' || res === null) return ''

  const obj = res as Record<string, unknown>
  const coerce = (v: unknown): string => {
    if (typeof v !== 'string' && typeof v !== 'number') return ''
    return v === '' ? '' : String(v)
  }

  if ('caseNumber' in obj) return coerce(obj.caseNumber)
  if ('CaseNumber' in obj) return coerce(obj.CaseNumber)
  if ('id' in obj) return coerce(obj.id)
  if ('Id' in obj) return coerce(obj.Id)
  if (typeof obj.result === 'object' && obj.result !== null && 'id' in (obj.result as Record<string, unknown>)) {
    return coerce((obj.result as Record<string, unknown>).id)
  }
  return ''
}

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

  async uploadDocument({ caseNumber, filename, pdfBuffer, attachments = [], metadata = {} }: UploadDocumentParams): Promise<unknown> {
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
      throw new Error(`OneSystems upload failed: ${response.status} - ${capBody(errorText)}`)
    }

    logger.info('Upload successful', { caseNumber })
    const pdfResult = await response.json().catch(() => ({ success: true }))
    logger.info('OneSystems PDF response', { caseNumber, response: capBody(pdfResult) })

    // Upload each attachment as a separate call (API accepts one document per request)
    for (const att of attachments) {
      const attBoundary = `----formdata-${Date.now()}-${Math.random().toString(36).substring(2)}`
      const attParts: string[] = []

      attParts.push(`--${attBoundary}`)
      attParts.push(`Content-Disposition: form-data; name="CaseNumber"`)
      attParts.push('')
      attParts.push(sanitize(caseNumber))

      attParts.push(`--${attBoundary}`)
      attParts.push(`Content-Disposition: form-data; name="User"`)
      attParts.push('')
      attParts.push(sanitize(this.user || 'Zendesk'))

      attParts.push(`--${attBoundary}`)
      attParts.push(`Content-Disposition: form-data; name="FileName"`)
      attParts.push('')
      attParts.push(sanitize(att.filename))

      attParts.push(`--${attBoundary}`)
      attParts.push(`Content-Disposition: form-data; name="FileArray"`)
      attParts.push('')
      attParts.push(att.data.toString('base64'))

      attParts.push(`--${attBoundary}`)
      attParts.push(`Content-Disposition: form-data; name="Date"`)
      attParts.push('')
      attParts.push(new Date().toISOString())

      attParts.push(`--${attBoundary}`)
      attParts.push(`Content-Disposition: form-data; name="XML"`)
      attParts.push('')
      attParts.push('')

      attParts.push(`--${attBoundary}--`)

      logger.info('Uploading attachment to OneSystems', { caseNumber, filename: att.filename })

      const attResponse = await fetch(`${this.baseUrl}/api/OneRecord/AddDocument2`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': `multipart/form-data; boundary=${attBoundary}`,
          'Accept': '*/*'
        },
        body: attParts.join('\r\n')
      })

      if (!attResponse.ok) {
        const errorText = await attResponse.text()
        throw new Error(`OneSystems attachment upload failed (${att.filename}): ${attResponse.status} - ${capBody(errorText)}`)
      }

      const attResult = await attResponse.json().catch(() => ({ success: true }))
      logger.info('Attachment upload successful', { caseNumber, filename: att.filename })
      logger.info('OneSystems attachment response', { caseNumber, filename: att.filename, response: capBody(attResult) })
    }

    return pdfResult
  }

  /**
   * Create a case in OneSystems. Wire contract ported byte-faithfully from
   * app cases.ts (endpoint, 5-field body, kennitala digits-only, 7-branch
   * caseNumber waterfall). App returns a Result and never throws; the gateway
   * has no Result type so both failure exits become thrown Error (mirrors
   * uploadDocument). PII guard: the bearer token NEVER appears in a message.
   */
  async createCase(params: CreateCaseParams): Promise<CreateCaseResult> {
    await this.ensureAuthenticated()

    const { caseTemplate, kennitala, externalId, caseName, currentUser } = params
    const timestamp = Date.now()

    // cases.ts:228-234 — EXACTLY these 5 fields, this order.
    const payload = {
      idNumber: normalizeKennitala(kennitala),
      caseTemplate,
      caseName: caseName ?? `ZendeskCase_${String(timestamp)}`,
      externalId: String(externalId ?? `ticket_${String(timestamp)}`),
      currentUser: currentUser ?? DEFAULT_EXTERNAL_USER
    }

    logger.info('Creating OneSystems case', { caseTemplate })

    const response = await fetch(`${this.baseUrl}/api/OneRecord/CreateCaseUid`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload)
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`OneSystems createCase failed: ${response.status} - ${text}`)
    }

    const res = await response.json().catch(() => null)
    const caseNumber = extractCaseNumber(res)
    if (!caseNumber) {
      throw new Error('OneSystems createCase: missing case number in response')
    }

    logger.info('Case created', { caseNumber })
    logger.info('OneSystems createCase response', { response: capBody(res) })
    return { caseNumber, caseTemplate }
  }
}
