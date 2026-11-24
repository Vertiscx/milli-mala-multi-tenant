/**
 * GoPro (gopro.net) API Client - authentication, cases and document upload
 *
 * Targets GoPro's "Tickets v1" integration API (the vendor's universal
 * ticket-system connection; requires the "GoPro Ticket System Integration
 * Module" licence; GoPro Foris 22.1.4+). baseUrl is the services root, e.g.
 * https://<host>/<instance>/services
 *
 * Contract per the vendor's Swagger and integration notes (Nov 2026):
 *  - WebKey → POST Tickets/v1/Authenticate → token in the X-GoProToken
 *    response header (60 min default); every other call sends `Token`.
 *  - Cases: LookupTemplates, Create (from a template GUID), FindByIdNumber,
 *    FindByCaseNumber. Cases are created as the WebKey user.
 *  - Documents/Create returns the new document ID as a JSON string. There
 *    is no subject field: fileName is the subject, GoPro appends the origin.
 *  - 401 means the token expired: re-authenticate once and retry.
 *
 * Because this client has createCase(), the archive pipeline treats GoPro
 * tenants as create-capable (same duck-typed check as OneSystems).
 */

import { createLogger, capBody } from '../../platform/logger.js'
import type { Logger } from '../../platform/types.js'
import { fetchWithTimeout } from '../../platform/http.js'
import type { UploadDocumentParams, DocClient, CreateCaseParams, CreateCaseResult } from './types.js'

const logger: Logger = createLogger('gopro')

const DEFAULT_ORIGIN = 'Zendesk'

export interface GoProCaseTemplate {
  id: string
  type?: string
  category: string
  name: string
}

export interface GoProCase {
  id: string
  caseNumber: string
  name: string
  url: string | null
}

/** Kennitala as GoPro expects it: digits only. */
function normalizeKennitala(raw: string): string {
  return raw.replace(/\D+/g, '')
}

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
    // Token is returned in the X-GoProToken response header; fall back to
    // a `token` field in the body if a server ever returns it there.
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

  /**
   * Authenticated call to a Tickets/v1 endpoint. Re-authenticates once and
   * retries when GoPro rejects the token with 401. Throws on any non-2xx
   * with GoPro's (capped) error body, which names the problem.
   */
  private async request(method: 'GET' | 'POST', path: string, label: string, body?: unknown): Promise<unknown> {
    await this.ensureAuthenticated()
    const send = () => fetchWithTimeout(`${this.baseUrl}/Tickets/v1/${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        'Token': this.token!,
        'Gopro-Origin': 'foris'
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })

    let response = await send()
    // Token may expire server-side before our TTL — re-auth once and retry
    if (response.status === 401) {
      logger.info('GoPro token rejected, re-authenticating', { path })
      await this.authenticate()
      response = await send()
    }

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`GoPro ${label} failed: ${response.status} - ${capBody(errorText)}`)
    }

    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch {
      return text // plain-string response
    }
  }

  /** Case templates (type General) that cases can be created from. */
  async listTemplates(): Promise<GoProCaseTemplate[]> {
    const result = await this.request('GET', 'Cases/LookupTemplates', 'template lookup')
    return Array.isArray(result) ? result as GoProCaseTemplate[] : []
  }

  /** One case by case number (or case record GUID). Throws if not found. */
  async findCaseByNumber(caseNumber: string): Promise<GoProCase> {
    return await this.request('POST', 'Cases/FindByCaseNumber', 'case lookup', { caseNumber }) as GoProCase
  }

  /**
   * Cases linked to a client by kennitala. Only a full 10-digit kennitala
   * is accepted: GoPro falls back to "begins with" matching when there is
   * no exact match, so a partial value could return other clients' cases.
   */
  async findCasesByKennitala(kennitala: string): Promise<GoProCase[]> {
    const idNumber = normalizeKennitala(kennitala)
    if (idNumber.length !== 10) {
      throw new Error('GoPro case search needs a full 10-digit kennitala')
    }
    const result = await this.request('POST', 'Cases/FindByIdNumber', 'case search', { idNumber })
    return Array.isArray(result) ? result as GoProCase[] : []
  }

  /**
   * Name a new case after its template. Falls back to the caller's name
   * (the ticket subject) when the template list can't be read or doesn't
   * contain the template — GoPro then rejects an unknown template anyway.
   */
  private async caseNameFor(caseTemplate: string, fallback: string): Promise<string> {
    try {
      const template = (await this.listTemplates()).find(t => t.id.toLowerCase() === caseTemplate.toLowerCase())
      if (template?.name?.trim()) return template.name.trim()
      logger.warn('GoPro template not in template list, using fallback case name', { caseTemplate })
    } catch (err) {
      logger.warn('GoPro template lookup failed, using fallback case name', { caseTemplate, error: (err as Error).message })
    }
    return fallback
  }

  /**
   * Create a case from a template. `caseTemplate` is the GoPro template
   * GUID (from listTemplates); the case is named after that template. The
   * kennitala links the client as involved party when GoPro finds an exact
   * active match; otherwise GoPro ignores it and still creates the case.
   */
  async createCase({ caseTemplate, kennitala, caseName, externalId }: CreateCaseParams): Promise<CreateCaseResult> {
    const idNumber = normalizeKennitala(kennitala ?? '')
    const fallbackName = (caseName ?? '').trim() || `Zendesk ${externalId ?? 'case'}`
    const body = {
      templateId: caseTemplate,
      name: await this.caseNameFor(caseTemplate, fallbackName),
      ...(idNumber ? { idNumber } : {})
    }

    logger.info('Creating GoPro case', { caseTemplate })
    const created = await this.request('POST', 'Cases/Create', 'createCase', body) as Partial<GoProCase>
    if (!created?.caseNumber) {
      throw new Error('GoPro createCase: missing case number in response')
    }

    logger.info('GoPro case created', { caseNumber: created.caseNumber, url: created.url ?? null })
    return { caseNumber: created.caseNumber, caseTemplate }
  }

  async uploadDocument({ caseNumber, filename, pdfBuffer, attachments = [] }: UploadDocumentParams): Promise<unknown> {
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
      const documentId = await this.request('POST', 'Documents/Create', 'upload', {
        caseNumber,
        origin: this.origin,
        fileName: file.fileName,
        content: file.content
      })
      logger.info('Upload successful', { caseNumber, fileName: file.fileName, documentId: capBody(documentId) })
      results.push(documentId)
    }

    return results.length === 1 ? results[0] : results
  }
}
