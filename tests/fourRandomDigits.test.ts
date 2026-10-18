import { describe, it, expect, vi, afterEach } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequest, createResponse } from 'node-mocks-http'
import { generateCode, secureUint16, REJECTION_THRESHOLD } from '../src/services/fourRandomDigits/generate.js'
import { loadFourRandomDigitsConfig, type FourRandomDigitsConfig } from '../src/services/fourRandomDigits/config.js'
import { FixedWindowRateLimiter } from '../src/services/fourRandomDigits/rateLimiter.js'
import {
  BASE_PATH,
  createFourRandomDigitsHandler,
  isFourRandomDigitsPath
} from '../src/services/fourRandomDigits/handler.js'
import { handleFourRandomDigitsHttp } from '../src/services/fourRandomDigits/nodeAdapter.js'
import type { Logger } from '../src/platform/types.js'

const KEY_A = 'test-four-random-digits-key-a-0123456789'
const KEY_B = 'test-four-random-digits-key-b-0123456789'
const ORIGIN = 'https://forms.example.is'

function makeConfig(overrides: Partial<FourRandomDigitsConfig> = {}): FourRandomDigitsConfig {
  return {
    apiKeys: [{ keyId: 'zendesk-eauth', key: KEY_A }, { keyId: 'web-form', key: KEY_B }],
    corsOrigins: [ORIGIN],
    rateLimitPerMinute: 60,
    ...overrides
  }
}

interface LogLine { level: string; message: string; data: Record<string, unknown> }

function makeLogger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = []
  const at = (level: string) => (message: string, data: Record<string, unknown> = {}) => {
    lines.push({ level, message, data })
  }
  return { logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }, lines }
}

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, init)
}

function post(path = `${BASE_PATH}/codes`, key: string | null = KEY_A, extra: Record<string, string> = {}): Request {
  const headers: Record<string, string> = { ...extra }
  if (key !== null) headers.authorization = `Bearer ${key}`
  return req(path, { method: 'POST', headers })
}

/** A 16-bit source that replays the given values in order. */
function sequence(values: number[]): () => number {
  let i = 0
  return vi.fn(() => {
    if (i >= values.length) throw new Error('sequence exhausted')
    return values[i++]
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// ─── Generation ──────────────────────────────────────────────────────────

describe('generateCode', () => {
  it('returns a 4-character string of digits', () => {
    for (let i = 0; i < 1000; i++) {
      const code = generateCode()
      expect(typeof code).toBe('string')
      expect(code).toMatch(/^\d{4}$/)
    }
  })

  it('zero-pads small values', () => {
    expect(generateCode(sequence([7]))).toBe('0007')
    expect(generateCode(sequence([0]))).toBe('0000')
    expect(generateCode(sequence([42]))).toBe('0042')
    expect(generateCode(sequence([427]))).toBe('0427')
  })

  it('maps accepted 16-bit values with % 10000', () => {
    expect(generateCode(sequence([9999]))).toBe('9999')
    expect(generateCode(sequence([10000]))).toBe('0000')
    expect(generateCode(sequence([59999]))).toBe('9999')
  })

  it('rejects values >= 60000 and draws again', () => {
    expect(REJECTION_THRESHOLD).toBe(60000)
    const source = sequence([60000, 65535, 61234, 1234])
    expect(generateCode(source)).toBe('1234')
    expect(source).toHaveBeenCalledTimes(4)
  })

  it('rejects a source value outside 0–65535 or non-integer', () => {
    expect(() => generateCode(() => -1)).toThrow()
    expect(() => generateCode(() => 65536)).toThrow()
    expect(() => generateCode(() => 1.5)).toThrow()
  })

  it('uses crypto.getRandomValues for the default source', () => {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues')
    generateCode()
    expect(spy).toHaveBeenCalled()
    const arg = spy.mock.calls[0][0]
    expect(arg).toBeInstanceOf(Uint16Array)
  })

  it('secureUint16 returns integers in 0–65535', () => {
    for (let i = 0; i < 1000; i++) {
      const v = secureUint16()
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(65535)
    }
  })

  it('never uses Math.random anywhere in the service', async () => {
    const spy = vi.spyOn(Math, 'random')
    for (let i = 0; i < 100; i++) generateCode()
    expect(spy).not.toHaveBeenCalled()

    const dir = join(process.cwd(), 'src/services/fourRandomDigits')
    for (const file of await readdir(dir)) {
      const source = await readFile(join(dir, file), 'utf8')
      expect(source, file).not.toMatch(/Math\.random/)
    }
  })

  describe('over 100,000 draws', () => {
    const DRAWS = 100_000
    const counts = new Array<number>(10_000).fill(0)
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < DRAWS; i++) {
      const n = Number(generateCode())
      counts[n]++
      if (n < min) min = n
      if (n > max) max = n
    }

    it('covers the whole range', () => {
      expect(min).toBeLessThan(50)
      expect(max).toBeGreaterThan(9950)
      const distinct = counts.filter(c => c > 0).length
      // Expected distinct ≈ 10000 × (1 − e^−10) ≈ 9999.5
      expect(distinct).toBeGreaterThan(9990)
    })

    it('is roughly uniform — no value or range wildly over/under-represented', () => {
      // Per value: expected 10, so anything above 40 is a > 9σ outlier.
      expect(Math.max(...counts)).toBeLessThanOrEqual(40)

      // 10 buckets of 1000 values: expected 10,000 each. Chi-square with
      // 9 degrees of freedom; 40 is far beyond the 0.9999 quantile (~33.7).
      const buckets = new Array<number>(10).fill(0)
      counts.forEach((c, n) => { buckets[Math.floor(n / 1000)] += c })
      const expected = DRAWS / 10
      const chiSquare = buckets.reduce((sum, b) => sum + (b - expected) ** 2 / expected, 0)
      expect(chiSquare).toBeLessThan(40)
      for (const b of buckets) expect(Math.abs(b - expected) / expected).toBeLessThan(0.05)
    })
  })
})

// ─── Config ──────────────────────────────────────────────────────────────

describe('loadFourRandomDigitsConfig', () => {
  it('returns null (service off) when no API keys are configured', () => {
    expect(loadFourRandomDigitsConfig({})).toBeNull()
    expect(loadFourRandomDigitsConfig({ RANDOM_DIGITS_API_KEYS: '' })).toBeNull()
  })

  it('parses named keys, origins and the rate limit', () => {
    const config = loadFourRandomDigitsConfig({
      RANDOM_DIGITS_API_KEYS: ` zendesk-eauth:${KEY_A} , web-form:${KEY_B} `,
      RANDOM_DIGITS_CORS_ORIGINS: `${ORIGIN}, https://other.example.is`,
      RANDOM_DIGITS_RATE_LIMIT_PER_MINUTE: '120'
    })
    expect(config).toEqual({
      apiKeys: [{ keyId: 'zendesk-eauth', key: KEY_A }, { keyId: 'web-form', key: KEY_B }],
      corsOrigins: [ORIGIN, 'https://other.example.is'],
      rateLimitPerMinute: 120
    })
  })

  it('defaults to no CORS origins and 60 requests/minute', () => {
    const config = loadFourRandomDigitsConfig({ RANDOM_DIGITS_API_KEYS: `a:${KEY_A}` })
    expect(config?.corsOrigins).toEqual([])
    expect(config?.rateLimitPerMinute).toBe(60)
  })

  it('allows a colon inside the key itself', () => {
    const key = `${KEY_A}:with:colons`
    expect(loadFourRandomDigitsConfig({ RANDOM_DIGITS_API_KEYS: `a:${key}` })?.apiKeys[0].key).toBe(key)
  })

  it.each([
    ['missing key id', `:${KEY_A}`],
    ['missing separator', KEY_A],
    ['key too short', 'a:short-key'],
    ['invalid key id', `bad id!:${KEY_A}`],
    ['duplicate key id', `a:${KEY_A},a:${KEY_B}`],
    ['duplicate key', `a:${KEY_A},b:${KEY_A}`]
  ])('throws on malformed keys (%s) without echoing the key', (_label, value) => {
    let message = ''
    try {
      loadFourRandomDigitsConfig({ RANDOM_DIGITS_API_KEYS: value })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/RANDOM_DIGITS_API_KEYS/)
    expect(message).not.toContain(KEY_A)
    expect(message).not.toContain(KEY_B)
  })

  it.each(['forms.example.is', 'https://forms.example.is/', 'https://forms.example.is/path', '*'])(
    'throws on an invalid CORS origin %s',
    (origin) => {
      expect(() => loadFourRandomDigitsConfig({
        RANDOM_DIGITS_API_KEYS: `a:${KEY_A}`,
        RANDOM_DIGITS_CORS_ORIGINS: origin
      })).toThrow(/RANDOM_DIGITS_CORS_ORIGINS/)
    }
  )

  it.each(['0', '-1', '1.5', 'abc'])('throws on an invalid rate limit %s', (value) => {
    expect(() => loadFourRandomDigitsConfig({
      RANDOM_DIGITS_API_KEYS: `a:${KEY_A}`,
      RANDOM_DIGITS_RATE_LIMIT_PER_MINUTE: value
    })).toThrow(/RANDOM_DIGITS_RATE_LIMIT_PER_MINUTE/)
  })
})

// ─── Rate limiter ────────────────────────────────────────────────────────

describe('FixedWindowRateLimiter', () => {
  it('allows `limit` requests per window, then refuses with Retry-After seconds', () => {
    let now = 1_000_000
    const limiter = new FixedWindowRateLimiter(3, 60_000, () => now)
    expect(limiter.consume('a').allowed).toBe(true)
    expect(limiter.consume('a').allowed).toBe(true)
    expect(limiter.consume('a').allowed).toBe(true)
    now += 15_500
    expect(limiter.consume('a')).toEqual({ allowed: false, retryAfterSeconds: 45 })
  })

  it('counts each key separately', () => {
    const limiter = new FixedWindowRateLimiter(1, 60_000, () => 0)
    expect(limiter.consume('a').allowed).toBe(true)
    expect(limiter.consume('b').allowed).toBe(true)
    expect(limiter.consume('a').allowed).toBe(false)
  })

  it('resets when the window has passed', () => {
    let now = 0
    const limiter = new FixedWindowRateLimiter(1, 60_000, () => now)
    expect(limiter.consume('a').allowed).toBe(true)
    expect(limiter.consume('a').allowed).toBe(false)
    now = 60_000
    expect(limiter.consume('a').allowed).toBe(true)
  })
})

// ─── HTTP handler ────────────────────────────────────────────────────────

describe('createFourRandomDigitsHandler', () => {
  function setup(overrides: Partial<Parameters<typeof createFourRandomDigitsHandler>[0]> = {}) {
    const { logger, lines } = makeLogger()
    const handler = createFourRandomDigitsHandler({ config: makeConfig(), logger, ...overrides })
    return { handler, lines }
  }

  async function expectProblem(res: Response, status: number) {
    expect(res.status).toBe(status)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
    const body = await res.json() as Record<string, unknown>
    expect(body).toMatchObject({ type: 'about:blank', status })
    expect(typeof body.title).toBe('string')
    return body
  }

  it('recognises only paths under the service prefix', () => {
    expect(isFourRandomDigitsPath(`${BASE_PATH}/codes`)).toBe(true)
    expect(isFourRandomDigitsPath(BASE_PATH)).toBe(true)
    expect(isFourRandomDigitsPath(`${BASE_PATH}/anything`)).toBe(true)
    expect(isFourRandomDigitsPath('/v1/4-random-digitsx/codes')).toBe(false)
    expect(isFourRandomDigitsPath('/v1/health')).toBe(false)
  })

  it('POST /codes → 201 { code } as a 4-digit string', async () => {
    const { handler } = setup()
    const res = await handler(post())
    expect(res.status).toBe(201)
    expect(res.headers.get('content-type')).toBe('application/json')
    const body = await res.json()
    expect(Object.keys(body)).toEqual(['code'])
    expect(body.code).toMatch(/^\d{4}$/)
  })

  it('returns the injected generator’s code', async () => {
    const { handler } = setup({ generate: () => '0427' })
    expect(await (await handler(post())).json()).toEqual({ code: '0427' })
  })

  it('accepts the second configured key and a lower-case bearer scheme', async () => {
    const { handler } = setup()
    expect((await handler(post(undefined, KEY_B))).status).toBe(201)
    const res = await handler(req(`${BASE_PATH}/codes`, { method: 'POST', headers: { authorization: `bearer ${KEY_A}` } }))
    expect(res.status).toBe(201)
  })

  it('GET /health → 200 { status: "ok" } without a key', async () => {
    const { handler } = setup()
    const res = await handler(req(`${BASE_PATH}/health`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it.each([
    ['no Authorization header', null, {}],
    ['wrong key', 'wrong-key-wrong-key-wrong-key-wrong-key', {}],
    ['empty bearer', '', {}],
    ['a key that is a prefix of a real key', KEY_A.slice(0, -1), {}]
  ])('401 with %s', async (_label, key) => {
    const { handler } = setup()
    const res = await handler(post(undefined, key as string | null))
    await expectProblem(res, 401)
    expect(res.headers.get('www-authenticate')).toBe('Bearer')
  })

  it('401 with a non-Bearer scheme', async () => {
    const { handler } = setup()
    const res = await handler(req(`${BASE_PATH}/codes`, { method: 'POST', headers: { authorization: `Basic ${KEY_A}` } }))
    await expectProblem(res, 401)
  })

  it('429 once a key is over the limit, with Retry-After; other keys unaffected', async () => {
    let now = 0
    const { handler } = setup({
      config: makeConfig({ rateLimitPerMinute: 3 }),
      rateLimiter: new FixedWindowRateLimiter(3, 60_000, () => now)
    })
    for (let i = 0; i < 3; i++) expect((await handler(post())).status).toBe(201)
    const limited = await handler(post())
    await expectProblem(limited, 429)
    expect(limited.headers.get('retry-after')).toBe('60')
    expect((await handler(post(undefined, KEY_B))).status).toBe(201)
    now = 60_000
    expect((await handler(post())).status).toBe(201)
  })

  it('defaults to the configured limit (60/minute)', async () => {
    const { handler } = setup()
    for (let i = 0; i < 60; i++) expect((await handler(post())).status).toBe(201)
    expect((await handler(post())).status).toBe(429)
  })

  it('does not count rejected (401) requests against a key', async () => {
    const { handler } = setup({ config: makeConfig({ rateLimitPerMinute: 1 }) })
    for (let i = 0; i < 5; i++) expect((await handler(post(undefined, 'nope'))).status).toBe(401)
    expect((await handler(post())).status).toBe(201)
  })

  it.each([
    `${BASE_PATH}`,
    `${BASE_PATH}/`,
    `${BASE_PATH}/code`,
    `${BASE_PATH}/codes/`,
    `${BASE_PATH}/codes/1234`,
    `${BASE_PATH}/health/x`
  ])('404 for other route %s', async (path) => {
    const { handler } = setup()
    await expectProblem(await handler(post(path)), 404)
  })

  it.each([
    ['GET', '/codes', 'POST, OPTIONS'],
    ['PUT', '/codes', 'POST, OPTIONS'],
    ['DELETE', '/codes', 'POST, OPTIONS'],
    ['POST', '/health', 'GET'],
    ['DELETE', '/health', 'GET']
  ])('405 for %s %s with Allow header', async (method, path, allow) => {
    const { handler } = setup()
    const res = await handler(req(`${BASE_PATH}${path}`, { method, headers: { authorization: `Bearer ${KEY_A}` } }))
    await expectProblem(res, 405)
    expect(res.headers.get('allow')).toBe(allow)
  })

  it('every response carries Cache-Control: no-store', async () => {
    const { handler } = setup({ config: makeConfig({ rateLimitPerMinute: 1 }) })
    const responses = [
      await handler(post()),                                            // 201
      await handler(post()),                                            // 429
      await handler(post(undefined, null)),                             // 401
      await handler(req(`${BASE_PATH}/health`)),                        // 200
      await handler(req(`${BASE_PATH}/nope`)),                          // 404
      await handler(req(`${BASE_PATH}/codes`)),                         // 405
      await handler(req(`${BASE_PATH}/codes`, { method: 'OPTIONS' }))   // 204
    ]
    expect(responses.map(r => r.status)).toEqual([201, 429, 401, 200, 404, 405, 204])
    for (const r of responses) expect(r.headers.get('cache-control')).toBe('no-store')
  })

  it('500 problem (still no-store) when generation fails, without leaking the error', async () => {
    const { handler, lines } = setup({ generate: () => { throw new Error('boom-secret-detail') } })
    const res = await handler(post())
    const body = await expectProblem(res, 500)
    expect(JSON.stringify(body)).not.toContain('boom-secret-detail')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(lines.some(l => l.level === 'error')).toBe(true)
  })

  describe('CORS', () => {
    it('echoes an allowed origin', async () => {
      const { handler } = setup()
      const res = await handler(post(undefined, KEY_A, { origin: ORIGIN }))
      expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN)
      expect(res.headers.get('vary')).toBe('Origin')
    })

    it('adds no CORS headers for an origin not on the list', async () => {
      const { handler } = setup()
      const res = await handler(post(undefined, KEY_A, { origin: 'https://evil.example.com' }))
      expect(res.status).toBe(201)
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    })

    it('adds no CORS headers by default (empty allow-list)', async () => {
      const { handler } = setup({ config: makeConfig({ corsOrigins: [] }) })
      const res = await handler(post(undefined, KEY_A, { origin: ORIGIN }))
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    })

    it('answers a preflight for an allowed origin without a key', async () => {
      const { handler } = setup()
      const res = await handler(req(`${BASE_PATH}/codes`, {
        method: 'OPTIONS',
        headers: { origin: ORIGIN, 'access-control-request-method': 'POST' }
      }))
      expect(res.status).toBe(204)
      expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN)
      expect(res.headers.get('access-control-allow-methods')).toBe('POST')
      expect(res.headers.get('access-control-allow-headers')).toBe('Authorization')
      expect(res.headers.get('access-control-max-age')).toBe('600')
    })

    it('answers a preflight for a disallowed origin without CORS headers', async () => {
      const { handler } = setup()
      const res = await handler(req(`${BASE_PATH}/codes`, { method: 'OPTIONS', headers: { origin: 'https://evil.example.com' } }))
      expect(res.status).toBe(204)
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    })
  })

  describe('logging', () => {
    it('logs time, status and key ID — not the key', async () => {
      const { handler, lines } = setup()
      await handler(post(undefined, KEY_B))
      expect(lines).toHaveLength(1)
      expect(lines[0].level).toBe('info')
      expect(lines[0].data).toMatchObject({
        method: 'POST',
        path: `${BASE_PATH}/codes`,
        status: 201,
        keyId: 'web-form'
      })
      expect(typeof lines[0].data.durationMs).toBe('number')
      expect(JSON.stringify(lines)).not.toContain(KEY_B)
    })

    it('logs 401 at warn with a null key ID and without the presented key', async () => {
      const { handler, lines } = setup()
      await handler(post(undefined, 'presented-but-wrong-key-0123456789abcdef'))
      expect(lines[0]).toMatchObject({ level: 'warn', data: { status: 401, keyId: null } })
      expect(JSON.stringify(lines)).not.toContain('presented-but-wrong-key')
    })

    it('logs 429 at warn with the key ID', async () => {
      const { handler, lines } = setup({ config: makeConfig({ rateLimitPerMinute: 1 }) })
      await handler(post())
      await handler(post())
      expect(lines[1]).toMatchObject({ level: 'warn', data: { status: 429, keyId: 'zendesk-eauth' } })
    })

    it('never logs the generated code (injected logger)', async () => {
      const { handler, lines } = setup({ generate: () => '7351' })
      const res = await handler(post())
      expect(await res.json()).toEqual({ code: '7351' })
      expect(JSON.stringify(lines)).not.toContain('7351')
    })

    it('never logs the generated code (real logger on stdout)', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const handler = createFourRandomDigitsHandler({ config: makeConfig(), generate: () => '7351' })
      for (let i = 0; i < 5; i++) expect(await (await handler(post())).json()).toEqual({ code: '7351' })
      expect(logSpy).toHaveBeenCalled()
      const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n')
      expect(output).toContain('zendesk-eauth')
      expect(output).not.toContain('7351')
      expect(output).not.toContain(KEY_A)
    })
  })
})

// ─── Node adapter / Worker parity ────────────────────────────────────────

describe('Node adapter', () => {
  async function viaNode(handler: (r: Request) => Promise<Response>, method: string, url: string, headers: Record<string, string> = {}) {
    const nodeReq = createRequest({ method: method as 'POST', url, headers })
    const nodeRes = createResponse()
    await handleFourRandomDigitsHttp(handler, nodeReq, nodeRes)
    return nodeRes
  }

  it('maps status, headers and body from the Web handler', async () => {
    const handler = createFourRandomDigitsHandler({ config: makeConfig(), logger: makeLogger().logger, generate: () => '0007' })
    const res = await viaNode(handler, 'POST', `${BASE_PATH}/codes`, { authorization: `Bearer ${KEY_A}`, origin: ORIGIN })
    expect(res.statusCode).toBe(201)
    expect(res._getJSONData()).toEqual({ code: '0007' })
    expect(res.getHeader('cache-control')).toBe('no-store')
    expect(res.getHeader('access-control-allow-origin')).toBe(ORIGIN)
  })

  it('passes 401/404/405 through unchanged', async () => {
    const handler = createFourRandomDigitsHandler({ config: makeConfig(), logger: makeLogger().logger })
    expect((await viaNode(handler, 'POST', `${BASE_PATH}/codes`)).statusCode).toBe(401)
    expect((await viaNode(handler, 'GET', `${BASE_PATH}/nope`)).statusCode).toBe(404)
    const notAllowed = await viaNode(handler, 'GET', `${BASE_PATH}/codes`)
    expect(notAllowed.statusCode).toBe(405)
    expect(notAllowed.getHeader('allow')).toBe('POST, OPTIONS')
    expect(notAllowed.getHeader('content-type')).toBe('application/problem+json')
  })
})

describe('Worker entry point', () => {
  const env = {
    RANDOM_DIGITS_API_KEYS: `zendesk-eauth:${KEY_A}`,
    RANDOM_DIGITS_CORS_ORIGINS: ORIGIN
  }

  it('serves the service routes when configured', async () => {
    const { default: worker } = await import('../src/worker.js')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const created = await worker.fetch(post(`${BASE_PATH}/codes`, KEY_A, { origin: ORIGIN }), env, {})
    expect(created.status).toBe(201)
    expect((await created.json()).code).toMatch(/^\d{4}$/)
    expect(created.headers.get('cache-control')).toBe('no-store')
    expect(created.headers.get('access-control-allow-origin')).toBe(ORIGIN)

    expect((await worker.fetch(post(`${BASE_PATH}/codes`, null), env, {})).status).toBe(401)
    expect((await worker.fetch(req(`${BASE_PATH}/health`), env, {})).status).toBe(200)
    expect((await worker.fetch(req(`${BASE_PATH}/codes`), env, {})).status).toBe(405)
  })

  it('returns the gateway 404 for the service paths when not configured', async () => {
    const { default: worker } = await import('../src/worker.js')
    const res = await worker.fetch(post(`${BASE_PATH}/codes`), {}, {})
    expect(res.status).toBe(404)
  })
})
