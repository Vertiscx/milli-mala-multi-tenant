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
 *
 * Optional numeric custom-field IDs (the template/kennitala field-ID
 * variables) use `optionalNumberEnv` and may be unset — unset means the
 * webhook create inputs are unavailable for that tenant.
 */

import type { TenantConfig } from './types.js'
import { requireEnv, optionalNumberEnv } from './env.js'

/**
 * Build the tenant array from environment variables. Called once at startup.
 * Throws if any required env var is missing — the container will fail to
 * start, which is intentional (fail fast on misconfiguration).
 */
export function loadTenants(env: Record<string, string | undefined> = process.env): TenantConfig[] {
  return [
    {
      brand_id: '30220057411090',
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
          templateFieldId: optionalNumberEnv('KERFISSTJORN_TEMPLATE_FIELD_ID', env),
          kennitalaFieldId: optionalNumberEnv('KERFISSTJORN_KENNITALA_FIELD_ID', env),
          // MD-02 invariant: the webhook create path refuses to mint
          // without a case-number field to stamp (duplicate-mint guard).
          caseNumberFieldId: optionalNumberEnv('KERFISSTJORN_CASE_NUMBER_FIELD_ID', env),
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
      brand_id: '28710908212242',
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
          templateFieldId: optionalNumberEnv('SAMGONGUSTOFA_TEMPLATE_FIELD_ID', env),
          kennitalaFieldId: optionalNumberEnv('SAMGONGUSTOFA_KENNITALA_FIELD_ID', env),
          caseNumberFieldId: optionalNumberEnv('SAMGONGUSTOFA_CASE_NUMBER_FIELD_ID', env),
        },
      },
      malaskra: { apiKey: requireEnv('SAMGONGUSTOFA_MALASKRA_API_KEY', env) },
      pdf: {
        companyName: 'Samgöngustofa',
        locale: 'is-IS',
        includeInternalNotes: false,
      },
    },
    {
      brand_id: '11204917066386',
      name: 'Tryggingastofnun',
      zendesk: {
        subdomain: requireEnv('TRYGGINGASTOFNUN_ZENDESK_SUBDOMAIN', env),
        email: requireEnv('TRYGGINGASTOFNUN_ZENDESK_EMAIL', env),
        apiToken: requireEnv('TRYGGINGASTOFNUN_ZENDESK_API_TOKEN', env),
        webhookSecret: requireEnv('TRYGGINGASTOFNUN_ZENDESK_WEBHOOK_SECRET', env),
      },
      endpoints: {
        onesystems: {
          type: 'onesystems',
          baseUrl: requireEnv('TRYGGINGASTOFNUN_ONESYSTEMS_BASE_URL', env),
          appKey: requireEnv('TRYGGINGASTOFNUN_ONESYSTEMS_APP_KEY', env),
          templateFieldId: optionalNumberEnv('TRYGGINGASTOFNUN_TEMPLATE_FIELD_ID', env),
          kennitalaFieldId: optionalNumberEnv('TRYGGINGASTOFNUN_KENNITALA_FIELD_ID', env),
          caseNumberFieldId: optionalNumberEnv('TRYGGINGASTOFNUN_CASE_NUMBER_FIELD_ID', env),
        },
      },
      malaskra: { apiKey: requireEnv('TRYGGINGASTOFNUN_MALASKRA_API_KEY', env) },
      pdf: {
        companyName: 'Tryggingastofnun',
        locale: 'is-IS',
        includeInternalNotes: false,
      },
    },
    {
      brand_id: '36102499292434',
      name: 'Tryggingastofnun-internal',
      zendesk: {
        subdomain: requireEnv('TRYGGINGASTOFNUN_INTERNAL_ZENDESK_SUBDOMAIN', env),
        email: requireEnv('TRYGGINGASTOFNUN_INTERNAL_ZENDESK_EMAIL', env),
        apiToken: requireEnv('TRYGGINGASTOFNUN_INTERNAL_ZENDESK_API_TOKEN', env),
        webhookSecret: requireEnv('TRYGGINGASTOFNUN_INTERNAL_ZENDESK_WEBHOOK_SECRET', env),
      },
      endpoints: {
        onesystems: {
          type: 'onesystems',
          baseUrl: requireEnv('TRYGGINGASTOFNUN_INTERNAL_ONESYSTEMS_BASE_URL', env),
          appKey: requireEnv('TRYGGINGASTOFNUN_INTERNAL_ONESYSTEMS_APP_KEY', env),
          templateFieldId: optionalNumberEnv('TRYGGINGASTOFNUN_INTERNAL_TEMPLATE_FIELD_ID', env),
          kennitalaFieldId: optionalNumberEnv('TRYGGINGASTOFNUN_INTERNAL_KENNITALA_FIELD_ID', env),
          caseNumberFieldId: optionalNumberEnv('TRYGGINGASTOFNUN_INTERNAL_CASE_NUMBER_FIELD_ID', env),
        },
      },
      malaskra: { apiKey: requireEnv('TRYGGINGASTOFNUN_INTERNAL_MALASKRA_API_KEY', env) },
      pdf: {
        companyName: 'Tryggingastofnun',
        locale: 'is-IS',
        includeInternalNotes: false,
      },
    },
    {
      brand_id: '25782179205266',
      name: 'HMS',
      zendesk: {
        subdomain: requireEnv('HMS_ZENDESK_SUBDOMAIN', env),
        email: requireEnv('HMS_ZENDESK_EMAIL', env),
        apiToken: requireEnv('HMS_ZENDESK_API_TOKEN', env),
        webhookSecret: requireEnv('HMS_ZENDESK_WEBHOOK_SECRET', env),
      },
      endpoints: {
        onesystems: {
          type: 'onesystems',
          baseUrl: requireEnv('HMS_ONESYSTEMS_BASE_URL', env),
          appKey: requireEnv('HMS_ONESYSTEMS_APP_KEY', env),
        },
      },
      malaskra: { apiKey: requireEnv('HMS_MALASKRA_API_KEY', env) },
      pdf: {
        companyName: 'HMS',
        locale: 'is-IS',
        includeInternalNotes: false,
      },
    },
  ]
}
