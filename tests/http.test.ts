import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchWithTimeout, REQUEST_TIMEOUT_MS } from '../src/platform/http.js'
import { OneSystemsClient } from '../src/services/archive/onesystems.js'
import { GoProClient } from '../src/services/archive/gopro.js'
import { ZendeskClient } from '../src/platform/zendesk.js'

global.fetch = vi.fn() as unknown as typeof fetch

describe('fetchWithTimeout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes an AbortSignal to fetch', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true })
    await fetchWithTimeout('https://example.test/x', { method: 'POST' })

    const init = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.method).toBe('POST')
  })

  it('has a sane default timeout', () => {
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000)
    expect(REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(120_000)
  })

  it('signal aborts after the given timeout', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true })
    await fetchWithTimeout('https://example.test/x', {}, 5)
    const signal = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].signal as AbortSignal
    expect(signal.aborted).toBe(false)
    await new Promise(r => setTimeout(r, 25))
    expect(signal.aborted).toBe(true)
  })

  it('respects a caller-provided signal', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true })
    const controller = new AbortController()
    await fetchWithTimeout('https://example.test/x', { signal: controller.signal })
    const signal = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].signal
    expect(signal).toBe(controller.signal)
  })
})

describe('all HTTP clients pass a timeout signal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('OneSystemsClient.authenticate uses a timeout signal', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ token: 't' })
    })
    const client = new OneSystemsClient('https://api.test', 'key')
    await client.authenticate()
    const init = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('GoProClient.authenticate uses a timeout signal', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      text: async () => 'gp-token'
    })
    const client = new GoProClient('https://api.test', 'u', 'p')
    await client.authenticate()
    const init = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('ZendeskClient.request uses a timeout signal', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ticket: {} })
    })
    const client = new ZendeskClient('sub', 'token', 'a@b.c')
    await client.getTicket(1)
    const init = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
})
