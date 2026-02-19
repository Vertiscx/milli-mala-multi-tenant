/**
 * Instance-level configuration — non-tenant settings only.
 * Tenant-specific config (Zendesk creds, archive creds, PDF settings)
 * lives in TenantConfig, resolved per-request from brand_id.
 */

export interface InstanceConfig {
  service: {
    port: number
    logLevel: string
  }
  auditSecret: string
}

let config: InstanceConfig | null = null

export function getConfig(env?: Record<string, string | undefined>): InstanceConfig {
  if (config) return config

  const e = env || process.env

  config = {
    service: {
      port: parseInt(e.PORT || '8080', 10),
      logLevel: e.LOG_LEVEL || 'info'
    },
    auditSecret: e.AUDIT_SECRET || ''
  }
  return config
}

export function resetConfig(): void {
  config = null
}
