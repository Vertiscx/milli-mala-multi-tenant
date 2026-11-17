/**
 * WorkPoint API Client — talks to Spektra's "Zendesk to WorkPoint API",
 * which fronts WorkPoint 365 (SharePoint Online) for one institution.
 *
 * Every path ends in the institution's client ID (`/api/<call>/<clientId>`).
 * Login exchanges the app key for a bearer token that expires after 25
 * minutes; uploads are JSON with base64 content, one document per request.
 */

import { createLogger, capBody } from '../../platform/logger.js'
import type { Logger } from '../../platform/types.js'
import { fetchWithTimeout } from '../../platform/http.js'
import type { UploadDocumentParams, DocClient, CreateCaseParams, CreateCaseResult } from './types.js'

const logger: Logger = createLogger('workpoint')

const DEFAULT_USER = 'Zendesk'

// Spektra tokens expire after exactly 25 minutes. Re-login well before that
// so a token never expires between the TTL check and the request landing.
export const WORKPOINT_DEFAULT_TOKEN_TTL_MS = 20 * 60 * 1000

function normalizeKennitala(raw: string): string {
  return raw.replace(/\D+/g, '')
}

export class WorkpointClient implements DocClient {
  baseUrl: string
  appKey: string
  clientId: string
  token: string | null
  tokenExpiry: number | null
  tokenTtlMs: number
  user: string

  constructor(
    baseUrl: string,
    appKey: string,
    clientId: string,
    { tokenTtlMs = WORKPOINT_DEFAULT_TOKEN_TTL_MS, user = '' }: { tokenTtlMs?: number; user?: string } = {}
  ) {
    this.baseUrl = baseUrl
    this.appKey = appKey
    this.clientId = clientId
    this.token = null
    this.tokenExpiry = null
    this.tokenTtlMs = tokenTtlMs
    this.user = user
  }

  private url(call: string): string {
    return `${this.baseUrl}/api/${call}/${encodeURIComponent(this.clientId)}`
  }

  async authenticate(): Promise<void> {
    logger.debug('Authenticating with WorkPoint')
    const response = await fetchWithTimeout(this.url('login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ key: this.appKey })
    })
    if (!response.ok) {
      throw new Error(`WorkPoint auth failed: ${response.status}`)
    }
    const data = await response.json().catch(() => null) as Record<string, unknown> | null
    const token = data && typeof data.token === 'string' ? data.token : ''
    if (!token) {
      // A 200 without a token must not mark the client authenticated.
      throw new Error('WorkPoint auth response contained no token')
    }
    this.token = token
    this.tokenExpiry = Date.now() + this.tokenTtlMs
    logger.info('WorkPoint authentication successful')
  }

  async ensureAuthenticated(): Promise<void> {
    if (!this.token || Date.now() > this.tokenExpiry!) {
      await this.authenticate()
    }
  }

  private async postJson(call: string, payload: Record<string, unknown>): Promise<Response> {
    return fetchWithTimeout(this.url(call), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload)
    })
  }

  /**
   * Upload the ticket PDF, then each attachment — one request per document
   * (the API takes one file per call). Throws on the first failure; the
   * message carries the attachment filename so the failure note can name it.
   */
  async uploadDocument({ caseNumber, filename, pdfBuffer, attachments = [] }: UploadDocumentParams): Promise<unknown> {
    await this.ensureAuthenticated()
    const user = this.user || DEFAULT_USER

    logger.info('Uploading to WorkPoint', { caseNumber, fileCount: 1 + attachments.length })

    const pdfResponse = await this.postJson('adddocument', {
      caseNumber,
      user,
      fileName: filename,
      base64: pdfBuffer.toString('base64'),
      date: new Date().toISOString()
    })
    if (!pdfResponse.ok) {
      const errorText = await pdfResponse.text()
      throw new Error(`WorkPoint upload failed: ${pdfResponse.status} - ${capBody(errorText)}`)
    }
    const pdfResult = await pdfResponse.json().catch(() => ({ success: true }))
    logger.info('Upload successful', { caseNumber })

    for (const att of attachments) {
      logger.info('Uploading attachment to WorkPoint', { caseNumber, filename: att.filename })
      const attResponse = await this.postJson('adddocument', {
        caseNumber,
        user,
        fileName: att.filename,
        base64: att.data.toString('base64'),
        date: new Date().toISOString()
      })
      if (!attResponse.ok) {
        const errorText = await attResponse.text()
        throw new Error(`WorkPoint attachment upload failed (${att.filename}): ${attResponse.status} - ${capBody(errorText)}`)
      }
      logger.info('Attachment upload successful', { caseNumber, filename: att.filename })
    }

    return pdfResult
  }

  /**
   * Create a WorkPoint case. `clientName` is the ticket requester's name;
   * `clientIdentifier` is their kennitala, digits only. The bearer token
   * never appears in a thrown message.
   */
  async createCase(params: CreateCaseParams): Promise<CreateCaseResult> {
    await this.ensureAuthenticated()

    const { caseTemplate, kennitala, externalId, caseName, currentUser, clientName } = params
    const timestamp = Date.now()

    const payload = {
      clientIdentifier: normalizeKennitala(kennitala),
      clientName: clientName ?? '',
      caseTemplate,
      caseName: caseName ?? `ZendeskCase_${String(timestamp)}`,
      externalId: String(externalId ?? `ticket_${String(timestamp)}`),
      user: currentUser ?? DEFAULT_USER
    }

    logger.info('Creating WorkPoint case', { caseTemplate })

    const response = await this.postJson('createcase', payload)
    if (!response.ok) {
      const text = await response.text()
      throw new Error(`WorkPoint createCase failed: ${response.status} - ${capBody(text)}`)
    }

    const res = await response.json().catch(() => null) as Record<string, unknown> | null
    const raw = res?.caseNumber
    const caseNumber = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : ''
    if (!caseNumber) {
      throw new Error('WorkPoint createCase: missing case number in response')
    }

    logger.info('Case created', { caseNumber })
    return { caseNumber, caseTemplate }
  }
}
