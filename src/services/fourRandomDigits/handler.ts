/**
 * 4-random-digits — returns a new random 4-digit code on request. It calls
 * no other system, stores no codes and doesn't know what they're used for
 * (e.g. e-authentication).
 *
 *   POST /v1/4-random-digits/codes   → 201 { "code": "0427" }   (API key)
 *   GET  /v1/4-random-digits/health  → 200 { "status": "ok" }
 *
 * Any other path under the prefix → 404, wrong method → 405. Every
 * response has Cache-Control: no-store so a code is never cached. Errors
 * are RFC 7807 Problem Details (application/problem+json).
 *
 * Written against the Web Request/Response API so the same handler serves
 * the Cloudflare Worker directly and Node through nodeAdapter.ts.
 *
 * Logs one line per request with the caller's key ID, never the key and
 * never the generated code.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { createLogger } from '../../platform/logger.js'
import type { Logger } from '../../platform/types.js'
import type { FourRandomDigitsConfig } from './config.js'
import { generateCode } from './generate.js'
import { FixedWindowRateLimiter, type RateLimiter } from './rateLimiter.js'

export const BASE_PATH = '/v1/4-random-digits'

const CODES_PATH = `${BASE_PATH}/codes`
const HEALTH_PATH = `${BASE_PATH}/health`
const CODES_ALLOW = 'POST, OPTIONS'
const HEALTH_ALLOW = 'GET'
const PREFLIGHT_MAX_AGE_SECONDS = '600'

export interface FourRandomDigitsDeps {
  config: FourRandomDigitsConfig
  rateLimiter?: RateLimiter
  generate?: () => string
  logger?: Logger
}

export type FourRandomDigitsHandler = (request: Request) => Promise<Response>

interface Outcome {
  response: Response
  keyId: string | null
}

export function isFourRandomDigitsPath(pathname: string): boolean {
  return pathname === BASE_PATH || pathname.startsWith(`${BASE_PATH}/`)
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  })
}

function problem(status: number, title: string, detail: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ type: 'about:blank', title, status, detail }), {
    status,
    headers: { 'Content-Type': 'application/problem+json', ...headers }
  })
}

export function createFourRandomDigitsHandler(deps: FourRandomDigitsDeps): FourRandomDigitsHandler {
  const { config } = deps
  const rateLimiter = deps.rateLimiter ?? new FixedWindowRateLimiter(config.rateLimitPerMinute)
  const generate = deps.generate ?? (() => generateCode())
  const logger = deps.logger ?? createLogger('fourRandomDigits')
  const keyHashes = config.apiKeys.map(k => ({ keyId: k.keyId, hash: sha256(k.key) }))
  const allowedOrigins = new Set(config.corsOrigins)

  /** Returns the matching key ID. Compares against every key, without stopping early. */
  function authenticate(request: Request): string | null {
    const match = /^Bearer +(\S+) *$/i.exec(request.headers.get('authorization') ?? '')
    if (!match) return null
    const presented = sha256(match[1])
    let keyId: string | null = null
    for (const k of keyHashes) {
      if (timingSafeEqual(presented, k.hash) && keyId === null) keyId = k.keyId
    }
    return keyId
  }

  function createCode(request: Request): Outcome {
    const keyId = authenticate(request)
    if (!keyId) {
      return {
        keyId: null,
        response: problem(401, 'Unauthorized', 'A valid API key is required.', { 'WWW-Authenticate': 'Bearer' })
      }
    }
    const limit = rateLimiter.consume(keyId)
    if (!limit.allowed) {
      return {
        keyId,
        response: problem(429, 'Too Many Requests', 'Rate limit exceeded for this API key.', {
          'Retry-After': String(limit.retryAfterSeconds)
        })
      }
    }
    return { keyId, response: json(201, { code: generate() }) }
  }

  function preflight(): Outcome {
    const response = new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Authorization',
        'Access-Control-Max-Age': PREFLIGHT_MAX_AGE_SECONDS
      }
    })
    return { keyId: null, response }
  }

  function route(request: Request, pathname: string): Outcome {
    const method = request.method
    if (pathname === CODES_PATH) {
      if (method === 'POST') return createCode(request)
      if (method === 'OPTIONS') return preflight()
      return {
        keyId: null,
        response: problem(405, 'Method Not Allowed', `${method} is not allowed on this resource.`, { Allow: CODES_ALLOW })
      }
    }
    if (pathname === HEALTH_PATH) {
      if (method === 'GET') return { keyId: null, response: json(200, { status: 'ok' }) }
      return {
        keyId: null,
        response: problem(405, 'Method Not Allowed', `${method} is not allowed on this resource.`, { Allow: HEALTH_ALLOW })
      }
    }
    return { keyId: null, response: problem(404, 'Not Found', 'No such resource.') }
  }

  function finalise(request: Request, response: Response): Response {
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Vary', 'Origin')
    const origin = request.headers.get('origin')
    if (origin && allowedOrigins.has(origin)) {
      response.headers.set('Access-Control-Allow-Origin', origin)
    } else {
      // Preflight-only headers are meaningless without an allowed origin
      response.headers.delete('Access-Control-Allow-Methods')
      response.headers.delete('Access-Control-Allow-Headers')
      response.headers.delete('Access-Control-Max-Age')
    }
    return response
  }

  return async (request: Request): Promise<Response> => {
    const startedAt = Date.now()
    const pathname = new URL(request.url).pathname
    let outcome: Outcome
    try {
      outcome = route(request, pathname)
    } catch (error) {
      logger.error('Request failed', { method: request.method, path: pathname, error: (error as Error).message })
      outcome = { keyId: null, response: problem(500, 'Internal Server Error', 'An unexpected error occurred.') }
    }

    const response = finalise(request, outcome.response)
    const status = response.status
    const level = status === 401 || status === 429 ? 'warn' : 'info'
    logger[level]('Request handled', {
      method: request.method,
      path: pathname,
      status,
      keyId: outcome.keyId,
      durationMs: Date.now() - startedAt
    })
    return response
  }
}
