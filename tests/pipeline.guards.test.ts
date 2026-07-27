/**
 * Defensive guards in the webhook pipeline: the best-effort finalize
 * paths must NEVER throw, because each one runs while an earlier failure
 * is already being handled. A throw here would replace the caller's
 * rethrow (or its 207/422 response) with an unrelated 500 — and for the
 * orphan-case path, a 500 makes Zendesk retry and mint a SECOND case.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const recordOutcome = vi.fn()
const createDocClient = vi.fn()

vi.mock('../src/services/archive/postResultToTicket.js', () => ({
  recordOutcome: (...args: unknown[]) => recordOutcome(...args)
}))

vi.mock('../src/services/archive/docClient.js', () => ({
  createDocClient: (...args: unknown[]) => createDocClient(...args)
}))

const { finalizeWebhookFailure } = await import('../src/services/archive/pipeline/finalize.js')
const { runWebhookCreateFlow } = await import('../src/services/archive/pipeline/createFlow.js')

const tenantConfig = { brand_id: '360001234567' } as any
const ep = { type: 'onesystems', baseUrl: 'https://api.test' } as any
const ticket = { id: 123, subject: 'Subject', status: 'closed', created_at: '2026-01-01' } as any

beforeEach(() => {
  vi.clearAllMocks()
  recordOutcome.mockResolvedValue(undefined)
  createDocClient.mockReturnValue({ createCase: () => {} })
})

describe('finalizeWebhookFailure never throws', () => {
  it('swallows a recordOutcome throw instead of breaking the caller rethrow', async () => {
    recordOutcome.mockRejectedValueOnce(new Error('audit store exploded'))

    await expect(finalizeWebhookFailure({
      tenantConfig, ep, docEndpoint: 'onesystems', ticketId: 123,
      startTime: Date.now(), ticket, mintedByCreate: false, clientCanCreate: true
    })).resolves.toBeUndefined()

    expect(recordOutcome).toHaveBeenCalledTimes(1)
  })

  it('assumes create-capable when even the padded client construction throws', async () => {
    // Both attempts throw → the never-fabricate invariant wins with TRUE,
    // so no ZD- number is invented for a client we cannot identify.
    createDocClient.mockImplementation(() => { throw new Error('unknown client') })

    await finalizeWebhookFailure({
      tenantConfig, ep, docEndpoint: 'onesystems', ticketId: 123,
      startTime: Date.now(), ticket, mintedByCreate: false
      // clientCanCreate omitted → forces the re-derivation branch
    })

    expect(createDocClient).toHaveBeenCalledTimes(2)
    const outcome = recordOutcome.mock.calls[0][0] as any
    expect(outcome.caseNumber).toBeUndefined()
    expect(outcome.caseNumberSource).toBe('none')
  })
})

describe('runWebhookCreateFlow finalize guards never throw', () => {
  const baseArgs = {
    tenantConfig, ep, docEndpoint: 'onesystems', ticketId: 123,
    startTime: Date.now(), ticket, comments: [], attachments: [],
    failedAttachments: [], pdfBuffer: Buffer.alloc(0),
    clientCanCreate: true, solvingAgentEmail: 'a@b.c',
    latch: { resolvedCaseNumber: undefined, mintedByCreate: false }
  } as any

  it('still returns 422 when the reject finalize throws', async () => {
    recordOutcome.mockRejectedValueOnce(new Error('audit store exploded'))

    // No create template staged → the missing_template reject path.
    const result = await runWebhookCreateFlow({
      ...baseArgs,
      zendesk: {} as any,
      docClient: { createCase: vi.fn() } as any
    })

    expect(result?.status).toBe(422)
  })

  it('still returns 207 when the orphan-case finalize throws', async () => {
    recordOutcome.mockRejectedValueOnce(new Error('audit store exploded'))

    const epWithCreate = {
      ...ep,
      caseNumberFieldId: 42,
      templateFieldId: 8,
      kennitalaFieldId: 7
    } as any
    const ticketWithInputs = {
      ...ticket,
      custom_fields: [
        { id: 8, value: 'TEMPLATE' },
        { id: 7, value: '0101801234' }
      ]
    } as any

    const result = await runWebhookCreateFlow({
      ...baseArgs,
      ep: epWithCreate,
      ticket: ticketWithInputs,
      // Stamp fails AFTER the mint → the orphan-case path.
      zendesk: { setTicketCustomField: vi.fn().mockRejectedValue(new Error('stamp failed')) } as any,
      docClient: { createCase: vi.fn().mockResolvedValue({ caseNumber: 'OS-2026-0001' }) } as any
    })

    expect(result?.status).toBe(207)
    // The minted number is never silently lost, even when the finalize died.
    expect(result?.body).toMatchObject({ case_number: 'OS-2026-0001' })
  })
})
