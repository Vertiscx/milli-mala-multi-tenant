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
 *
 * The ticket-update service is opt-in per tenant the same way: see
 * `ticketUpdateSection` below.
 */

import type { TenantConfig, TenantLoadFailure, TicketUpdateServiceConfig } from './platform/types.js'
import { requireEnv, optionalNumberEnv } from './platform/env.js'
import { validateTenantConfig } from './platform/tenant.js'

/**
 * Build the optional `services.ticketUpdate` section for a tenant.
 *
 * Unlike the archive section, this one is opt-in per tenant: a tenant with
 * none of the three variables set simply has no ticketUpdate section, and
 * `/v1/tickets/update` returns a neutral 400 for its brand. Absent config
 * means the service is switched off for that tenant, not that the tenant is
 * broken — so it is not reported as a load failure either.
 *
 * A *partly* configured tenant is still a hard boot failure: the three
 * values only make sense together, so a typo or a half-finished rollout
 * should be loud rather than silently leave the service switched off.
 */
function ticketUpdateSection(
  prefix: string,
  env: Record<string, string | undefined>
): { ticketUpdate?: TicketUpdateServiceConfig } {
  const names = {
    webhookSecret: `${prefix}_TICKET_UPDATE_WEBHOOK_SECRET`,
    clientId: `${prefix}_ZENDESK_OAUTH_CLIENT_ID`,
    clientSecret: `${prefix}_ZENDESK_OAUTH_CLIENT_SECRET`,
  }

  if (Object.values(names).every((name) => !env[name])) return {}

  return {
    ticketUpdate: {
      // Independent from zendesk.webhookSecret — Zendesk generates one
      // signing secret per webhook target, never a chosen value, so the
      // webhook target calling this service has its own secret.
      webhookSecret: requireEnv(names.webhookSecret, env),
      oauth: {
        clientId: requireEnv(names.clientId, env),
        clientSecret: requireEnv(names.clientSecret, env),
      },
    },
  }
}

type TenantBuilder = [name: string, build: (env: Record<string, string | undefined>) => TenantConfig]

/**
 * Every tenant, each one built by its own function so that one tenant's
 * configuration cannot stop another's from being built. The label repeats
 * the entry's `name` because it has to be known even when the build throws;
 * a test asserts the two never drift apart.
 */
function tenantBuilders(): TenantBuilder[] {
  return [
    ['Kerfisstjórn', (env: Record<string, string | undefined>): TenantConfig => ({
      brand_id: '30220057411090',
      name: 'Kerfisstjórn',
      zendesk: {
        subdomain: requireEnv('KERFISSTJORN_ZENDESK_SUBDOMAIN', env),
        email: requireEnv('KERFISSTJORN_ZENDESK_EMAIL', env),
        apiToken: requireEnv('KERFISSTJORN_ZENDESK_API_TOKEN', env),
        webhookSecret: requireEnv('KERFISSTJORN_ZENDESK_WEBHOOK_SECRET', env),
      },
      services: {
        archive: {
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
      },
    })],
    ['Vinnueftirlitið', (env: Record<string, string | undefined>): TenantConfig => ({
      brand_id: '28710908212242',
      name: 'Vinnueftirlitið',
      zendesk: {
        subdomain: requireEnv('VINNUEFTIRLIT_ZENDESK_SUBDOMAIN', env),
        email: requireEnv('VINNUEFTIRLIT_ZENDESK_EMAIL', env),
        apiToken: requireEnv('VINNUEFTIRLIT_ZENDESK_API_TOKEN', env),
        webhookSecret: requireEnv('VINNUEFTIRLIT_ZENDESK_WEBHOOK_SECRET', env),
      },
      services: {
        archive: {
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
      },
    })],
    ['Samgöngustofa', (env: Record<string, string | undefined>): TenantConfig => ({
      brand_id: '11037960588818',
      name: 'Samgöngustofa',
      zendesk: {
        subdomain: requireEnv('SAMGONGUSTOFA_ZENDESK_SUBDOMAIN', env),
        email: requireEnv('SAMGONGUSTOFA_ZENDESK_EMAIL', env),
        apiToken: requireEnv('SAMGONGUSTOFA_ZENDESK_API_TOKEN', env),
        webhookSecret: requireEnv('SAMGONGUSTOFA_ZENDESK_WEBHOOK_SECRET', env),
      },
      services: {
        archive: {
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
            includeInternalNotes: true,
          },
        },
      },
    })],
    ['Tryggingastofnun', (env: Record<string, string | undefined>): TenantConfig => ({
      brand_id: '11204917066386',
      name: 'Tryggingastofnun',
      zendesk: {
        subdomain: requireEnv('TRYGGINGASTOFNUN_ZENDESK_SUBDOMAIN', env),
        email: requireEnv('TRYGGINGASTOFNUN_ZENDESK_EMAIL', env),
        apiToken: requireEnv('TRYGGINGASTOFNUN_ZENDESK_API_TOKEN', env),
        webhookSecret: requireEnv('TRYGGINGASTOFNUN_ZENDESK_WEBHOOK_SECRET', env),
      },
      services: {
        archive: {
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
        ...ticketUpdateSection('TRYGGINGASTOFNUN', env),
      },
    })],
    ['Tryggingastofnun-internal', (env: Record<string, string | undefined>): TenantConfig => ({
      brand_id: '36102499292434',
      name: 'Tryggingastofnun-internal',
      zendesk: {
        subdomain: requireEnv('TRYGGINGASTOFNUN_INTERNAL_ZENDESK_SUBDOMAIN', env),
        email: requireEnv('TRYGGINGASTOFNUN_INTERNAL_ZENDESK_EMAIL', env),
        apiToken: requireEnv('TRYGGINGASTOFNUN_INTERNAL_ZENDESK_API_TOKEN', env),
        webhookSecret: requireEnv('TRYGGINGASTOFNUN_INTERNAL_ZENDESK_WEBHOOK_SECRET', env),
      },
      services: {
        archive: {
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
      },
    })],
    ['HMS', (env: Record<string, string | undefined>): TenantConfig => ({
      brand_id: '25782179205266',
      name: 'HMS',
      zendesk: {
        subdomain: requireEnv('HMS_ZENDESK_SUBDOMAIN', env),
        email: requireEnv('HMS_ZENDESK_EMAIL', env),
        apiToken: requireEnv('HMS_ZENDESK_API_TOKEN', env),
        webhookSecret: requireEnv('HMS_ZENDESK_WEBHOOK_SECRET', env),
      },
      services: {
        archive: {
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
      },
    })],
    ['Sýslumenn', (env: Record<string, string | undefined>): TenantConfig => ({
      brand_id: '5311999061778',
      name: 'Sýslumenn',
      zendesk: {
        subdomain: requireEnv('SYSLUMENN_ZENDESK_SUBDOMAIN', env),
        email: requireEnv('SYSLUMENN_ZENDESK_EMAIL', env),
        apiToken: requireEnv('SYSLUMENN_ZENDESK_API_TOKEN', env),
        webhookSecret: requireEnv('SYSLUMENN_ZENDESK_WEBHOOK_SECRET', env),
      },
      services: {
        archive: {
          endpoints: {
            onesystems: {
              type: 'onesystems',
              baseUrl: requireEnv('SYSLUMENN_ONESYSTEMS_BASE_URL', env),
              appKey: requireEnv('SYSLUMENN_ONESYSTEMS_APP_KEY', env),
              templateFieldId: optionalNumberEnv('SYSLUMENN_TEMPLATE_FIELD_ID', env),
              kennitalaFieldId: optionalNumberEnv('SYSLUMENN_KENNITALA_FIELD_ID', env),
              // MD-02 invariant: the webhook create path refuses to mint
              // without a case-number field to stamp (duplicate-mint guard).
              caseNumberFieldId: optionalNumberEnv('SYSLUMENN_CASE_NUMBER_FIELD_ID', env),
            },
          },
          malaskra: { apiKey: requireEnv('SYSLUMENN_MALASKRA_API_KEY', env) },
          pdf: {
            companyName: 'Sýslumenn',
            locale: 'is-IS',
            includeInternalNotes: false,
          },
        },
      },
    })],
  ]
}

export type { TenantLoadFailure }

export interface TenantLoadResult {
  tenants: TenantConfig[]
  failures: TenantLoadFailure[]
}

/**
 * Build every tenant independently, keeping the ones that succeed.
 *
 * A tenant whose variables are missing, or whose values fail validation, is
 * left out of the result and reported in `failures`; the rest load and serve
 * normally. This is what stops one institution's typo from taking every
 * other institution's archiving down with it. The caller is expected to log
 * the failures loudly and expose them on /v1/health — a skipped tenant is a
 * degraded deployment, not a healthy one.
 *
 * Requests for a skipped tenant get the same neutral 400 an unknown brand
 * already gets, because it is simply not in the store.
 *
 * Validation runs here as well as in `resolveTenantConfig`, so that a bad
 * URL or a weak secret is caught once at boot rather than on every request.
 */
export function loadTenantsIsolated(
  env: Record<string, string | undefined> = process.env
): TenantLoadResult {
  const tenants: TenantConfig[] = []
  const failures: TenantLoadFailure[] = []

  for (const [name, build] of tenantBuilders()) {
    try {
      const tenant = build(env)
      validateTenantConfig(tenant)
      tenants.push(tenant)
    } catch (err) {
      failures.push({ name, error: (err as Error).message })
    }
  }

  return { tenants, failures }
}

/**
 * Strict load: every tenant or nothing.
 *
 * Used by the tenant-list test, which exists to prove the committed list is
 * well-formed, and by any caller that would rather not start at all than
 * start degraded. The error names every tenant that failed and why, so a
 * misconfigured deployment is fixed in one pass rather than one deploy per
 * missing variable.
 */
export function loadTenants(env: Record<string, string | undefined> = process.env): TenantConfig[] {
  const { tenants, failures } = loadTenantsIsolated(env)
  if (failures.length > 0) {
    const detail = failures.map((f) => `  ${f.name}: ${f.error}`).join('\n')
    throw new Error(`Invalid tenant configuration (${failures.length} of ${failures.length + tenants.length} tenants):\n${detail}`)
  }
  return tenants
}
