/**
 * Shared fixtures for the TR service tests: a tenant with a TR section,
 * an RSA key pair standing in for TR's Auth0, signed agent tokens, and a
 * URL-routing fetch mock.
 */

import { generateKeyPairSync, createSign } from 'node:crypto'
import { vi } from 'vitest'
import type { GatewayRequest } from '../../src/platform/http/routes.js'
import type { AuditStore, TenantConfig, TrServiceConfig } from '../../src/platform/types.js'

export const BRAND = '11204917066386'
export const API_KEY = 'tr-sidebar-api-key-that-is-long-enough-01'
export const AGENT_DOMAIN = 'tr-agents.eu.auth0.com'
export const AGENT_AUDIENCE = 'https://milli-mala.tr-services'
export const EMAIL_CLAIM = 'https://tr.is/email'
export const VERIFIED_CLAIM = 'https://tr.is/email_verified'
export const SPA_CLIENT_ID = 'tr-smari-spa-client'
export const HULD = 'https://huldtest.tr.is/zendesktest/api/protected/v1'
export const TR_AUTH0_DOMAIN = 'tr-test.eu.auth0.com'
export const KID = 'test-kid-1'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const otherPair = generateKeyPairSync('rsa', { modulusLength: 2048 })

export const JWKS = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' }] }

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

export function signToken(
  claims: Record<string, unknown> = {},
  opts: { header?: Record<string, unknown>; wrongKey?: boolean } = {}
): string {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT', kid: KID, ...opts.header }
  const payload = {
    iss: `https://${AGENT_DOMAIN}/`,
    aud: [AGENT_AUDIENCE, `https://${AGENT_DOMAIN}/userinfo`],
    sub: 'auth0|agent-1',
    iat: now,
    exp: now + 3600,
    azp: SPA_CLIENT_ID,
    [EMAIL_CLAIM]: 'Anna@TR.is',
    [VERIFIED_CLAIM]: true,
    ...claims
  }
  const data = `${b64url(header)}.${b64url(payload)}`
  const signer = createSign('RSA-SHA256')
  signer.update(data)
  const signature = signer.sign(opts.wrongKey ? otherPair.privateKey : privateKey).toString('base64url')
  return `${data}.${signature}`
}

export function makeTrConfig(overrides: Partial<TrServiceConfig> = {}): TrServiceConfig {
  return {
    apiKey: API_KEY,
    huld: { baseUrl: HULD },
    auth0: { domain: TR_AUTH0_DOMAIN, audience: 'https://zendesk.dev.tr.is', clientId: 'tr-m2m-client', clientSecret: 'tr-m2m-secret-long-enough' },
    agentAuth: { domain: AGENT_DOMAIN, audience: AGENT_AUDIENCE, clientId: SPA_CLIENT_ID, emailClaim: EMAIL_CLAIM, emailVerifiedClaim: VERIFIED_CLAIM },
    smari: { enabled: true },
    eauth: {
      hashValueMode: 'code',
      timeoutSeconds: 120,
      attemptTtlSeconds: 180,
      rateLimits: { perAgent: { max: 10, windowSeconds: 600 }, perTarget: { max: 3, windowSeconds: 600 } },
      zendeskOAuth: { clientId: 'zd-oauth-client', clientSecret: 'zd-oauth-secret-that-is-long-enough-123' }
    },
    ...overrides
  }
}

export function makeTenant(tr: TrServiceConfig | undefined = makeTrConfig()): TenantConfig {
  return {
    brand_id: BRAND,
    name: 'Tryggingastofnun',
    zendesk: { subdomain: 'digitaliceland' } as TenantConfig['zendesk'],
    services: tr ? { tr } : {}
  }
}

export function memoryAudit(): AuditStore & { entries: Map<string, string> } {
  const entries = new Map<string, string>()
  return {
    entries,
    put: async (key, value) => { entries.set(key, value) },
    get: async (key) => entries.get(key) ?? null,
    list: async () => ({ keys: [...entries.keys()].map(name => ({ name })) })
  }
}

export function makeReq(
  body: Record<string, unknown>,
  opts: { tenant?: TenantConfig; token?: string | null; apiKey?: string | null; auditStore?: AuditStore } = {}
): GatewayRequest {
  const headers: Record<string, string> = {}
  if (opts.apiKey !== null) headers['x-api-key'] = opts.apiKey ?? API_KEY
  if (opts.token !== null) headers['x-agent-token'] = opts.token ?? signToken()
  return {
    body: { brand_id: BRAND, ...body },
    rawBody: JSON.stringify(body),
    headers,
    tenantConfig: opts.tenant ?? makeTenant(),
    auditStore: opts.auditStore
  }
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

export type Route = (url: string, init: RequestInit) => Response | Promise<Response>

/**
 * Install a fetch mock that answers JWKS and TR's Auth0 token itself and
 * hands every other URL to `route`. Returns the mock for call assertions.
 */
export function installFetch(route: Route): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    if (url === `https://${AGENT_DOMAIN}/.well-known/jwks.json`) return json(200, JWKS)
    if (url === `https://${TR_AUTH0_DOMAIN}/oauth/token`) return json(200, { access_token: 'tr-access-token', expires_in: 3600 })
    return route(url, init)
  })
  global.fetch = mock as unknown as typeof fetch
  return mock
}

export function callsTo(mock: ReturnType<typeof vi.fn>, prefix: string): [string, RequestInit][] {
  return mock.mock.calls.filter(([u]) => String(u).startsWith(prefix)) as [string, RequestInit][]
}
