/**
 * Tenant configuration — structure committed to the repo, secrets and
 * operationally-sensitive values injected at runtime via environment variables.
 *
 * What lives in code (here): which tenants exist, their public Zendesk brand
 * IDs, display names, endpoint type, and cosmetic PDF settings.
 *
 * What lives in environment variables (provisioned by DevOps):
 *  - Zendesk subdomain (reveals which Zendesk instance the tenant uses)
 *  - Zendesk admin email (phishing target if exposed publicly)
 *  - Archive endpoint base URL (reveals operational topology)
 *  - All credentials (API tokens, webhook secrets, archive system passwords,
 *    Málaskrá API keys)
 *
 * Each tenant carries its own values end-to-end. Even when two tenants are
 * brands on the same Zendesk account, the env vars are scoped per tenant so a
 * compromise of one tenant cannot affect another.
 *
 * Adding a tenant: append a new entry below and tell DevOps which new env
 * variables to provision (the names of the requireEnv calls in the new entry).
 *
 * Rotating any value: no code change. DevOps updates the env var on the
 * deployment and restarts the container.
 */

import type { TenantConfig } from './types.js'
import { requireEnv } from './env.js'

/**
 * Build the tenant array from environment variables. Called once at startup.
 * Throws if any required env var is missing — the container will fail to
 * start, which is intentional (fail fast on misconfiguration).
 */
export function loadTenants(env: Record<string, string | undefined> = process.env): TenantConfig[] {
  return [
    {
      brand_id: '33979373713298',
      name: 'Kerfisstjórn',
      zendesk: {
        subdomain: requireEnv('KERFISSTJORN_ZENDESK_SUBDOMAIN', env),
        email: requireEnv('KERFISSTJORN_ZENDESK_EMAIL', env),
        apiToken: requireEnv('KERFISSTJORN_ZENDESK_API_TOKEN', env),
        webhookSecret: requireEnv('KERFISSTJORN_ZENDESK_WEBHOOK_SECRET', env),
      },
      endpoints: {
        onesystems: {
          type: 'onesystems',
          baseUrl: requireEnv('KERFISSTJORN_ONESYSTEMS_BASE_URL', env),
          appKey: requireEnv('KERFISSTJORN_ONESYSTEMS_APP_KEY', env),
        },
      },
      malaskra: { apiKey: requireEnv('KERFISSTJORN_MALASKRA_API_KEY', env) },
      pdf: {
        companyName: 'Kerfisstjórn',
        locale: 'is-IS',
        includeInternalNotes: false,
      },
    },
    {
      brand_id: '33979400825874',
      name: 'Vinnueftirlitið',
      zendesk: {
        subdomain: requireEnv('VINNUEFTIRLIT_ZENDESK_SUBDOMAIN', env),
        email: requireEnv('VINNUEFTIRLIT_ZENDESK_EMAIL', env),
        apiToken: requireEnv('VINNUEFTIRLIT_ZENDESK_API_TOKEN', env),
        webhookSecret: requireEnv('VINNUEFTIRLIT_ZENDESK_WEBHOOK_SECRET', env),
      },
      endpoints: {
        gopro: {
          type: 'gopro',
          baseUrl: requireEnv('VINNUEFTIRLIT_GOPRO_BASE_URL', env),
          username: requireEnv('VINNUEFTIRLIT_GOPRO_USERNAME', env),
          password: requireEnv('VINNUEFTIRLIT_GOPRO_PASSWORD', env),
        },
      },
      malaskra: { apiKey: requireEnv('VINNUEFTIRLIT_MALASKRA_API_KEY', env) },
      pdf: {
        companyName: 'Vinnueftirlitið',
        locale: 'is-IS',
        includeInternalNotes: false,
      },
    },
    {
      brand_id: '11037960588818',
      name: 'Samgöngustofa',
      zendesk: {
        subdomain: requireEnv('SAMGONGUSTOFA_ZENDESK_SUBDOMAIN', env),
        email: requireEnv('SAMGONGUSTOFA_ZENDESK_EMAIL', env),
        apiToken: requireEnv('SAMGONGUSTOFA_ZENDESK_API_TOKEN', env),
        webhookSecret: requireEnv('SAMGONGUSTOFA_ZENDESK_WEBHOOK_SECRET', env),
      },
      endpoints: {
        onesystems: {
          type: 'onesystems',
          baseUrl: requireEnv('SAMGONGUSTOFA_ONESYSTEMS_BASE_URL', env),
          appKey: requireEnv('SAMGONGUSTOFA_ONESYSTEMS_APP_KEY', env),
        },
      },
      malaskra: { apiKey: requireEnv('SAMGONGUSTOFA_MALASKRA_API_KEY', env) },
      pdf: {
        companyName: 'Samgöngustofa',
        locale: 'is-IS',
        includeInternalNotes: false,
      },
    },
  ]
}
