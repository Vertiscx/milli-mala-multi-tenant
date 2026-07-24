/**
 * Environment variable validation.
 *
 * `requireEnv` reads an env var by name and throws if it's missing or empty.
 * Use this when building tenant config (`tenants.config.ts`) so the container
 * fails fast at startup rather than per-request when a secret is missing.
 *
 * The optional `env` parameter mirrors `getConfig` in `config.ts` — it makes
 * the function trivially testable without mutating `process.env`.
 */

export function requireEnv(
  name: string,
  env: Record<string, string | undefined> = process.env
): string {
  const value = env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

/**
 * `optionalNumberEnv` reads an optional numeric env var by name.
 * Use this for optional numeric per-tenant settings like Zendesk custom-field
 * IDs: unset (or empty) means the feature is absent for that tenant —
 * graceful, no fail-fast. A value that IS set but is not a positive integer
 * throws at startup, same fail-fast posture as `requireEnv`.
 *
 * The optional `env` parameter mirrors `requireEnv` — trivially testable
 * without mutating `process.env`.
 */
export function optionalNumberEnv(
  name: string,
  env: Record<string, string | undefined> = process.env
): number | undefined {
  const value = env[name]
  if (value === undefined || value === '') return undefined
  const parsed = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid numeric environment variable: ${name} (must be a positive integer, got "${value}")`
    )
  }
  return parsed
}
