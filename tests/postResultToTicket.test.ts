/**
 * G4 — GW-01 post-back to the Zendesk ticket.
 *
 * NEW file. Mocks the ZendeskClient.requestWrite transport and asserts
 * the SINGLE PUT body per outcome:
 *  - documented        → comment(public:false, ✅ Icelandic) + all 4 fields
 *  - create_failed     → comment(❌ sanitized) + ONLY lastStatusFieldId
 *  - orphan_case       → note + ONLY lastStatusFieldId (case# NOT re-written)
 *  - failed attachments listed in the note
 *  - unset *FieldId skipped
 *  - postResultToTicket NEVER throws even if requestWrite rejects
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildNote, buildCustomFields, postResultToTicket } from '../src/postResultToTicket.js'
import type { DocumentationOutcome, EndpointConfig, TenantConfig } from '../src/types.js'

const putMock = vi.fn()
vi.mock('../src/zendesk.js', () => ({
  ZendeskClient: class {
    constructor(..._a: unknown[]) {}
    requestWrite(...args: unknown[]) {
      return putMock(...args)
    }
  }
}))

function tenant(): TenantConfig {
  return {
    brand_id: 'B1',
    name: 'T',
    zendesk: { subdomain: 's', email: 'e@x.is', apiToken: 't', webhookSecret: 'w' },
    endpoints: {},
    malaskra: { apiKey: 'k' },
    pdf: { companyName: 'C', locale: 'is-IS', includeInternalNotes: false }
  }
}

const fullEp: EndpointConfig = {
  type: 'onesystems',
  baseUrl: 'https://a.test',
  appKey: 'k',
  caseNumberFieldId: 11,
  templateFieldId: 22,
  lastStatusFieldId: 33,
  lastExportFieldId: 44
}

function baseOutcome(over: Partial<DocumentationOutcome> = {}): DocumentationOutcome {
  return {
    ok: true,
    outcome: 'documented',
    intent: 'create',
    caseNumber: 'OS-9',
    caseNumberSource: 'created',
    docSystem: 'onesystems',
    template: 'TPL',
    ticketId: 123,
    durationMs: 5,
    pdfFilename: 'ticket-123.pdf',
    pdfSizeBytes: 4000,
    failedAttachments: [],
    timestamp: '2026-05-17T10:00:00.000Z',
    ...over
  }
}

const ctx = () => ({
  tenantConfig: tenant(),
  ep: fullEp,
  docEndpoint: 'onesystems',
  ticket: { id: 123, subject: 'S', status: 'open', created_at: 'x' },
  comments: [],
  attachments: [],
  pdfBuffer: Buffer.from('p')
})

describe('buildNote', () => {
  it('documented → ✅ Icelandic, special chars preserved', () => {
    const n = buildNote(baseOutcome(), fullEp)
    expect(n).toContain('✅ Skjalfest í onesystems mál OS-9')
    expect(n).toContain('Tímastimpill: 2026-05-17T10:00:00.000Z')
    expect(n).toContain('Skjal: ticket-123.pdf (4000 bytes)')
  })

  it('failure → ❌ sanitized reason, Icelandic', () => {
    const n = buildNote(baseOutcome({ ok: false, outcome: 'create_failed', sanitizedReason: 'Stofnun máls mistókst' }), fullEp)
    expect(n).toContain('❌ Skjalfesting mistókst')
    expect(n).toContain('Ástæða: Stofnun máls mistókst')
  })

  it('lists failed attachments', () => {
    const n = buildNote(baseOutcome({ failedAttachments: [{ filename: 'big.png', reason: 'total size limit reached' }] }), fullEp)
    expect(n).toContain('Viðhengi sem mistókst að senda:')
    expect(n).toContain('- big.png (total size limit reached)')
  })
})

describe('buildCustomFields', () => {
  it('documented → all 4 fields', () => {
    const f = buildCustomFields(baseOutcome(), fullEp)
    expect(f).toEqual([
      { id: 11, value: 'OS-9' },
      { id: 22, value: 'TPL' },
      { id: 33, value: 'success' },
      { id: 44, value: '2026-05-17T10:00:00.000Z' }
    ])
  })

  it('failure → ONLY lastStatusFieldId failed:<reason>', () => {
    const f = buildCustomFields(baseOutcome({ ok: false, outcome: 'create_failed', sanitizedReason: 'Stofnun máls mistókst' }), fullEp)
    expect(f).toEqual([{ id: 33, value: 'failed:Stofnun máls mistókst' }])
  })

  it('orphan_case → ONLY lastStatusFieldId (case# NOT re-written)', () => {
    const f = buildCustomFields(baseOutcome({ ok: false, outcome: 'orphan_case', caseNumber: 'OS-1', sanitizedReason: 'x' }), fullEp)
    expect(f).toEqual([{ id: 33, value: 'failed:x' }])
    expect(f.some(x => x.id === 11)).toBe(false)
  })

  it('unset *FieldId skipped (graceful)', () => {
    const bareEp: EndpointConfig = { type: 'onesystems', baseUrl: 'https://a.test', appKey: 'k' }
    expect(buildCustomFields(baseOutcome(), bareEp)).toEqual([])
    expect(buildCustomFields(baseOutcome({ ok: false, outcome: 'create_failed' }), bareEp)).toEqual([])
  })
})

describe('postResultToTicket — single atomic PUT', () => {
  beforeEach(() => {
    putMock.mockReset()
    putMock.mockResolvedValue({})
  })

  it('documented → one PUT, comment public:false + 4 fields', async () => {
    await postResultToTicket(baseOutcome(), ctx())
    expect(putMock).toHaveBeenCalledTimes(1)
    const [endpoint, method, body] = putMock.mock.calls[0]
    expect(endpoint).toBe('/tickets/123.json')
    expect(method).toBe('PUT')
    const t = (body as any).ticket
    expect(t.comment.public).toBe(false)
    expect(t.comment.body).toContain('✅')
    expect(t.custom_fields).toHaveLength(4)
  })

  it('create_failed → one PUT, ❌ note + ONLY status field', async () => {
    await postResultToTicket(baseOutcome({ ok: false, outcome: 'create_failed', sanitizedReason: 'Stofnun máls mistókst' }), ctx())
    const t = (putMock.mock.calls[0][2] as any).ticket
    expect(t.comment.body).toContain('❌')
    expect(t.custom_fields).toEqual([{ id: 33, value: 'failed:Stofnun máls mistókst' }])
  })

  it('orphan_case → note + ONLY status field, case# not re-written', async () => {
    await postResultToTicket(baseOutcome({ ok: false, outcome: 'orphan_case', caseNumber: 'OS-1', sanitizedReason: 'x' }), ctx())
    const t = (putMock.mock.calls[0][2] as any).ticket
    expect(t.custom_fields).toEqual([{ id: 33, value: 'failed:x' }])
  })

  it('NEVER throws when requestWrite rejects', async () => {
    putMock.mockRejectedValue(new Error('Zendesk API error: 500'))
    await expect(postResultToTicket(baseOutcome(), ctx())).resolves.toBeUndefined()
  })
})
