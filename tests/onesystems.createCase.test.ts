import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OneSystemsClient } from '../src/services/archive/onesystems.js'

// Mock fetch globally
global.fetch = vi.fn() as unknown as typeof fetch

describe('OneSystemsClient.createCase', () => {
  let client: OneSystemsClient

  beforeEach(() => {
    vi.clearAllMocks()
    client = new OneSystemsClient('https://api.onesystems.test', 'test-app-key', {
      user: 'test-user@example.com'
    })
    // Pre-authenticate to avoid auth fetch in createCase tests
    client.token = 'valid-token'
    client.tokenExpiry = Date.now() + 60 * 1000
  })

  const parsedBody = () =>
    JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body)

  const mockOk = (json: unknown) => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => json
    })
  }

  // ── Wire contract ──────────────────────────────────────────────────

  it('POSTs to /api/OneRecord/CreateCaseUid with correct headers', async () => {
    mockOk('CASE-1')

    await client.createCase({ caseTemplate: 'TPL', kennitala: '0101901234' })

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.onesystems.test/api/OneRecord/CreateCaseUid',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': 'Bearer valid-token',
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        })
      })
    )
  })

  it('builds a body with the five wire fields', async () => {
    mockOk('CASE-1')

    await client.createCase({
      caseTemplate: 'TPL',
      kennitala: '0101901234',
      externalId: 'ext-1',
      caseName: 'My Case',
      currentUser: 'agent@x.is'
    })

    const body = parsedBody()
    expect(body).toEqual({
      idNumber: '0101901234',
      caseTemplate: 'TPL',
      caseName: 'My Case',
      externalId: 'ext-1',
      currentUser: 'agent@x.is'
    })
  })

  it('normalizes kennitala to digits only', async () => {
    mockOk('CASE-1')

    await client.createCase({ caseTemplate: 'TPL', kennitala: '010190-1234' })

    expect(parsedBody().idNumber).toBe('0101901234')
  })

  it('applies synthetic fallbacks for caseName/externalId/currentUser', async () => {
    mockOk('CASE-1')

    await client.createCase({ caseTemplate: 'TPL', kennitala: '0101901234' })

    const body = parsedBody()
    expect(body.caseName).toMatch(/^ZendeskCase_\d+$/)
    expect(body.externalId).toMatch(/^ticket_\d+$/)
    expect(body.currentUser).toBe('Zendesk')
  })

  it('String()-coerces a numeric externalId', async () => {
    mockOk('CASE-1')

    await client.createCase({
      caseTemplate: 'TPL',
      kennitala: '0101901234',
      externalId: 42 as unknown as string
    })

    expect(parsedBody().externalId).toBe('42')
  })

  // ── Waterfall: one test per branch ─────────────────────────────────

  it('shape 1 — bare string → as-is', async () => {
    mockOk('C-STR')
    const r = await client.createCase({ caseTemplate: 'T', kennitala: '1' })
    expect(r.caseNumber).toBe('C-STR')
  })

  it('shape 2 — bare number → String()', async () => {
    mockOk(12345)
    const r = await client.createCase({ caseTemplate: 'T', kennitala: '1' })
    expect(r.caseNumber).toBe('12345')
  })

  it('shape 3 — {caseNumber} (extra field ignored)', async () => {
    mockOk({ caseNumber: 'C-3', extra: 1 })
    const r = await client.createCase({ caseTemplate: 'T', kennitala: '1' })
    expect(r.caseNumber).toBe('C-3')
  })

  it('shape 4 — {CaseNumber} number', async () => {
    mockOk({ CaseNumber: 99 })
    const r = await client.createCase({ caseTemplate: 'T', kennitala: '1' })
    expect(r.caseNumber).toBe('99')
  })

  it('shape 5 — {id} string', async () => {
    mockOk({ id: 'ID-5' })
    const r = await client.createCase({ caseTemplate: 'T', kennitala: '1' })
    expect(r.caseNumber).toBe('ID-5')
  })

  it('shape 6 — {Id} number', async () => {
    mockOk({ Id: 7 })
    const r = await client.createCase({ caseTemplate: 'T', kennitala: '1' })
    expect(r.caseNumber).toBe('7')
  })

  it('shape 7 — {result:{id}} nested', async () => {
    mockOk({ result: { id: 'R-7' } })
    const r = await client.createCase({ caseTemplate: 'T', kennitala: '1' })
    expect(r.caseNumber).toBe('R-7')
  })

  it('priority — caseNumber wins over id', async () => {
    mockOk({ caseNumber: 'A', id: 'B' })
    const r = await client.createCase({ caseTemplate: 'T', kennitala: '1' })
    expect(r.caseNumber).toBe('A')
  })

  // ── Empty-string-is-missing, no fallthrough ───────────────────────

  it('matched-but-empty {caseNumber:""} → throws (no fallthrough)', async () => {
    mockOk({ caseNumber: '' })
    await expect(
      client.createCase({ caseTemplate: 'T', kennitala: '1' })
    ).rejects.toThrow(/missing case number/)
  })

  it('matched-but-empty does NOT fall through to id', async () => {
    mockOk({ caseNumber: '', id: 'X' })
    await expect(
      client.createCase({ caseTemplate: 'T', kennitala: '1' })
    ).rejects.toThrow(/missing case number/)
  })

  it('unknown shape {foo:"bar"} → throws missing-case-number', async () => {
    mockOk({ foo: 'bar' })
    await expect(
      client.createCase({ caseTemplate: 'T', kennitala: '1' })
    ).rejects.toThrow(/missing case number/)
  })

  it('null / unparseable JSON body → throws missing-case-number', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => {
        throw new Error('invalid json')
      }
    })
    await expect(
      client.createCase({ caseTemplate: 'T', kennitala: '1' })
    ).rejects.toThrow(/missing case number/)
  })

  // ── OS rejection → throw, no token leak ───────────────────────────

  it('OS rejection → throws with status and no bearer-token leak', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => '{"errorCode":"X","errorMessage":"bad"}'
    })

    let caught: Error | undefined
    await expect(
      client.createCase({ caseTemplate: 'T', kennitala: '1' }).catch((e: Error) => {
        caught = e
        throw e
      })
    ).rejects.toThrow(/OneSystems createCase failed: 400/)
    expect(caught?.message).not.toContain('valid-token')
  })

  // ── Auth reuse ────────────────────────────────────────────────────

  it('authenticates before createCase when token is missing', async () => {
    client.token = null
    client.tokenExpiry = null

    ;(global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ token: 'new-token' })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => 'CASE-1'
      })

    await client.createCase({ caseTemplate: 'T', kennitala: '1' })

    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      'https://api.onesystems.test/api/Authenticate/login'
    )
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[1][0]).toBe(
      'https://api.onesystems.test/api/OneRecord/CreateCaseUid'
    )
  })
})
