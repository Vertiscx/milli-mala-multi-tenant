/**
 * Configuration for the 4-random-digits service, read from environment
 * variables (Node) or Worker bindings (Cloudflare — `wrangler secret put
 * RANDOM_DIGITS_API_KEYS`). Never committed.
 *
 *   RANDOM_DIGITS_API_KEYS               keyId:key,keyId:key   (unset = service off)
 *   RANDOM_DIGITS_CORS_ORIGINS           comma-separated origins (default: none)
 *   RANDOM_DIGITS_RATE_LIMIT_PER_MINUTE  per key (default: 60)
 *
 * The key ID is a non-secret label used in logs instead of the key. A
 * malformed value throws, so a bad deployment fails at startup rather than
 * per request. Error messages never include a key.
 */

import { optionalNumberEnv } from '../../platform/env.js'

export interface ApiKey {
  keyId: string
  key: string
}

export interface FourRandomDigitsConfig {
  apiKeys: ApiKey[]
  corsOrigins: string[]
  rateLimitPerMinute: number
}

const KEYS_VAR = 'RANDOM_DIGITS_API_KEYS'
const ORIGINS_VAR = 'RANDOM_DIGITS_CORS_ORIGINS'
const RATE_LIMIT_VAR = 'RANDOM_DIGITS_RATE_LIMIT_PER_MINUTE'

const DEFAULT_RATE_LIMIT_PER_MINUTE = 60
const MIN_KEY_LENGTH = 32
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function splitList(value: string | undefined): string[] {
  return (value ?? '').split(',').map(s => s.trim()).filter(Boolean)
}

function parseApiKeys(value: string | undefined): ApiKey[] {
  const apiKeys: ApiKey[] = []
  splitList(value).forEach((entry, index) => {
    const separator = entry.indexOf(':')
    const keyId = separator === -1 ? '' : entry.slice(0, separator)
    const key = separator === -1 ? '' : entry.slice(separator + 1)
    const position = `entry ${index + 1}`

    if (!KEY_ID_PATTERN.test(keyId)) {
      throw new Error(`Invalid ${KEYS_VAR}: ${position} must be "keyId:key" with a keyId of letters, digits, ".", "_" or "-"`)
    }
    if (key.length < MIN_KEY_LENGTH) {
      throw new Error(`Invalid ${KEYS_VAR}: key "${keyId}" must be at least ${MIN_KEY_LENGTH} characters`)
    }
    if (apiKeys.some(k => k.keyId === keyId)) {
      throw new Error(`Invalid ${KEYS_VAR}: duplicate keyId "${keyId}"`)
    }
    if (apiKeys.some(k => k.key === key)) {
      throw new Error(`Invalid ${KEYS_VAR}: key "${keyId}" reuses another entry's key`)
    }
    apiKeys.push({ keyId, key })
  })
  return apiKeys
}

function parseOrigins(value: string | undefined): string[] {
  return splitList(value).map(origin => {
    let parsed: URL | undefined
    try {
      parsed = new URL(origin)
    } catch {
      parsed = undefined
    }
    if (!parsed || parsed.origin !== origin) {
      throw new Error(`Invalid ${ORIGINS_VAR}: "${origin}" must be an exact origin such as https://example.is`)
    }
    return origin
  })
}

/** Returns null when no API keys are configured — the service is then off. */
export function loadFourRandomDigitsConfig(
  env: Record<string, string | undefined> = process.env
): FourRandomDigitsConfig | null {
  const apiKeys = parseApiKeys(env[KEYS_VAR])
  if (apiKeys.length === 0) return null

  return {
    apiKeys,
    corsOrigins: parseOrigins(env[ORIGINS_VAR]),
    rateLimitPerMinute: optionalNumberEnv(RATE_LIMIT_VAR, env) ?? DEFAULT_RATE_LIMIT_PER_MINUTE
  }
}
