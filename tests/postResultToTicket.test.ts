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
import { buildNote, buildCustomFields, postResultToTicket } from '../src/services/archive/postResultToTicket.js'
import type { EndpointConfig, TenantConfig } from '../src/platform/types.js'
import type { DocumentationOutcome } from '../src/services/archive/types.js'

const putMock = vi.fn()
vi.mock('../src/platform/zendesk.js', () => ({
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
    services: {
      archive: {
        endpoints: {},
        malaskra: { apiKey: 'k' },
        pdf: { companyName: 'C', locale: 'is-IS', includeInternalNotes: false }
      }
    }
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
  it('documented → ✅ Icelandic, special chars preserved; UTC human timestamp', () => {
    const o = baseOutcome()
    const n = buildNote(o, fullEp)
    expect(n).toContain('✅ Skjalfest í onesystems mál OS-9')
    expect(n).toContain('Skjal: ticket-123.pdf (4000 bytes)')
    const tsLine = n.split('\n').find(l => l.startsWith('Tímastimpill:'))!
    expect(tsLine).toMatch(/^Tímastimpill: \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}$/)
    const d = new Date(o.timestamp)
    const p = (x: number) => String(x).padStart(2, '0')
    const expected = `Tímastimpill: ${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
    expect(tsLine).toBe(expected)
    expect(tsLine).toBe('Tímastimpill: 17.05.2026 10:00:00')
  })

  it('failure → ❌ sanitized reason, Icelandic; UTC human timestamp', () => {
    const o = baseOutcome({ ok: false, outcome: 'create_failed', sanitizedReason: 'Stofnun máls mistókst' })
    const n = buildNote(o, fullEp)
    expect(n).toContain('❌ Skjalfesting mistókst')
    expect(n).toContain('Ástæða: Stofnun máls mistókst')
    const tsLine = n.split('\n').find(l => l.startsWith('Tímastimpill:'))!
    expect(tsLine).toMatch(/^Tímastimpill: \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}$/)
    expect(tsLine).toBe('Tímastimpill: 17.05.2026 10:00:00')
  })

  it('includes Vísun line when auditRef is set (documented and failure)', () => {
    const ok = buildNote(baseOutcome({ auditRef: 'AUD-123' }), fullEp)
    expect(ok).toContain('Vísun: AUD-123')
    const fail = buildNote(
      baseOutcome({ ok: false, outcome: 'create_failed', sanitizedReason: 'X', auditRef: 'AUD-456' }),
      fullEp
    )
    expect(fail).toContain('❌ Skjalfesting mistókst')
    expect(fail).toContain('Vísun: AUD-456')
  })

  it('lists failed attachments', () => {
    const n = buildNote(baseOutcome({ failedAttachments: [{ filename: 'big.png', reason: 'total size limit reached' }] }), fullEp)
    expect(n).toContain('Viðhengi sem mistókst að senda:')
    expect(n).toContain('- big.png (total size limit reached)')
  })
})

describe('buildCustomFields', () => {
  it('documented → all 4 fields; lastStatus JSON v1; lastExport date-only', () => {
    const o = baseOutcome()
    const f = buildCustomFields(o, fullEp)
    expect(f.map(x => x.id)).toEqual([11, 22, 33, 44])
    expect(f.find(x => x.id === 11)!.value).toBe('OS-9')
    expect(f.find(x => x.id === 22)!.value).toBe('TPL')

    const lsRaw = f.find(x => x.id === 33)!.value as string
    expect(() => JSON.parse(lsRaw)).not.toThrow()
    const ls = JSON.parse(lsRaw)
    expect(ls).toEqual({
      v: 1,
      status: 'success',
      outcome: 'documented',
      timestamp: o.timestamp,
      caseNumber: 'OS-9',
      docSystem: 'onesystems',
      template: 'TPL'
    })
    expect('reason' in ls).toBe(false)
    expect(ls.timestamp).toBe(o.timestamp) // full ISO precision retained

    const lastExport = f.find(x => x.id === 44)!
    expect(lastExport.value).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(lastExport.value).toBe(o.timestamp.slice(0, 10))
  })

  it('documented WITHOUT template → template key OMITTED (not null)', () => {
    const o = baseOutcome({ template: undefined })
    const ls = JSON.parse(buildCustomFields(o, fullEp).find(x => x.id === 33)!.value as string)
    expect('template' in ls).toBe(false)
    expect(ls.caseNumber).toBe('OS-9')
  })

  it('create_failed → ONLY lastStatus JSON; no caseNumber/template keys', () => {
    const f = buildCustomFields(baseOutcome({ ok: false, outcome: 'create_failed', caseNumber: undefined, template: undefined, sanitizedReason: 'Stofnun máls mistókst' }), fullEp)
    expect(f.map(x => x.id)).toEqual([33])
    const ls = JSON.parse(f[0].value as string)
    expect(ls).toEqual({
      v: 1,
      status: 'failed',
      outcome: 'create_failed',
      timestamp: '2026-05-17T10:00:00.000Z',
      docSystem: 'onesystems',
      reason: 'Stofnun máls mistókst'
    })
    expect('caseNumber' in ls).toBe(false)
    expect('template' in ls).toBe(false)
  })

  it('orphan_case → ONLY lastStatus JSON carrying caseNumber + reason', () => {
    const f = buildCustomFields(baseOutcome({ ok: false, outcome: 'orphan_case', caseNumber: 'OS-1', template: undefined, sanitizedReason: 'x' }), fullEp)
    expect(f.map(x => x.id)).toEqual([33])
    const ls = JSON.parse(f[0].value as string)
    expect(ls).toEqual({
      v: 1,
      status: 'failed',
      outcome: 'orphan_case',
      timestamp: '2026-05-17T10:00:00.000Z',
      caseNumber: 'OS-1',
      docSystem: 'onesystems',
      reason: 'x'
    })
    expect('template' in ls).toBe(false)
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

  it('create_failed → one PUT, ❌ note + ONLY status JSON field', async () => {
    await postResultToTicket(baseOutcome({ ok: false, outcome: 'create_failed', caseNumber: undefined, template: undefined, sanitizedReason: 'Stofnun máls mistókst' }), ctx())
    const t = (putMock.mock.calls[0][2] as any).ticket
    expect(t.comment.body).toContain('❌')
    expect(t.custom_fields.map((x: any) => x.id)).toEqual([33])
    expect(JSON.parse(t.custom_fields[0].value)).toEqual({
      v: 1, status: 'failed', outcome: 'create_failed',
      timestamp: '2026-05-17T10:00:00.000Z', docSystem: 'onesystems',
      reason: 'Stofnun máls mistókst'
    })
  })

  it('orphan_case → note + ONLY status JSON (carries caseNumber), case# field not re-written', async () => {
    await postResultToTicket(baseOutcome({ ok: false, outcome: 'orphan_case', caseNumber: 'OS-1', template: undefined, sanitizedReason: 'x' }), ctx())
    const t = (putMock.mock.calls[0][2] as any).ticket
    expect(t.custom_fields.map((x: any) => x.id)).toEqual([33])
    expect(JSON.parse(t.custom_fields[0].value)).toEqual({
      v: 1, status: 'failed', outcome: 'orphan_case',
      timestamp: '2026-05-17T10:00:00.000Z', caseNumber: 'OS-1',
      docSystem: 'onesystems', reason: 'x'
    })
  })

  it('NEVER throws when requestWrite rejects', async () => {
    putMock.mockRejectedValue(new Error('Zendesk API error: 500'))
    await expect(postResultToTicket(baseOutcome(), ctx())).resolves.toBeUndefined()
  })
})
