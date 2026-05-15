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
