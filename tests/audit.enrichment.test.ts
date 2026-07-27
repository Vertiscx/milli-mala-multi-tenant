import { describe, it, expect } from 'vitest'
import { standardEnrichment } from '../src/services/archive/pipeline/audit.js'
import type { DocumentationOutcome } from '../src/services/archive/types.js'

function makeOutcome(over: Partial<DocumentationOutcome> = {}): DocumentationOutcome {
  return {
    ok: true, outcome: 'documented', intent: 'create',
    caseNumber: 'C-100', caseNumberSource: 'created', docSystem: 'onesystems',
    ticketId: 123, durationMs: 5, pdfFilename: 'ticket-123.pdf',
    pdfSizeBytes: 100, failedAttachments: [],
    timestamp: '2026-07-24T12:00:00.000Z',
    ...over
  }
}

describe('standardEnrichment', () => {
  it('documented → ticket_archived / OK / last_export = timestamp', () => {
    expect(standardEnrichment(makeOutcome())).toEqual({
      event: 'ticket_archived', outcome: 'documented',
      caseNumberSource: 'created', intent: 'create',
      lastStatus: 'OK', lastExport: '2026-07-24T12:00:00.000Z'
    })
  })

  it('orphan_case → orphan_case / ORPHAN, no last_export', () => {
    const e = standardEnrichment(makeOutcome({ ok: false, outcome: 'orphan_case' }))
    expect(e.event).toBe('orphan_case')
    expect(e.lastStatus).toBe('ORPHAN')
    expect(e).not.toHaveProperty('lastExport')
  })

  it('other outcomes → event = outcome / FAILED', () => {
    const e = standardEnrichment(makeOutcome({ ok: false, outcome: 'failed', intent: 'webhook' }))
    expect(e).toEqual({
      event: 'failed', outcome: 'failed', caseNumberSource: 'created',
      intent: 'webhook', lastStatus: 'FAILED'
    })
  })

  it('WR-01: absent caseNumber forces caseNumberSource none', () => {
    const e = standardEnrichment(makeOutcome({
      ok: false, outcome: 'create_failed', caseNumber: undefined, caseNumberSource: 'created'
    }))
    expect(e.caseNumberSource).toBe('none')
  })
})
