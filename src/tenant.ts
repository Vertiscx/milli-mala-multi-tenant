/**
 * Tenant resolution — looks up TenantConfig by brand_id from a backing store.
 *
 * Cloudflare Workers → KV store
 * Docker / K8s      → tenants.json file
 */

import type { TenantConfig, EndpointConfig } from './types.js'
import { createLogger } from './logger.js'

const logger = createLogger('tenant')

// ─── Validation Patterns ────────────────────────────────────────────

/** Zendesk subdomains are alphanumeric + hyphens only */
const SUBDOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*$/i

/** Private/reserved IP ranges that must be blocked in baseUrl */
const PRIVATE_IP_PATTERNS = [
  /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^169\.254\./, /^0\./, /^::1$/, /^fc00:/, /^fe80:/,
  /^\[/,  // Block all IPv6 literal addresses (brackets in hostname) — no legitimate archive uses these
  /^localhost$/i
]

/** Audit query params must be alphanumeric/hyphens only — prevents prefix injection */
const AUDIT_PARAM_PATTERN = /^[a-zA-Z0-9_-]+$/

// ─── Tenant Store Interface ──────────────────────────────────────────

export interface TenantStore {
  get(brandId: string): Promise<TenantConfig | null>
}

// ─── KV-backed store (Cloudflare Workers) ────────────────────────────

interface KvNamespace {
  get(key: string, format?: string): Promise<string | null>
}

export class KvTenantStore implements TenantStore {
  private kv: KvNamespace

  constructor(kv: KvNamespace) {
    this.kv = kv
  }

  async get(brandId: string): Promise<TenantConfig | null> {
    const raw = await this.kv.get(`tenant:${brandId}`)
    if (!raw) return null
    try {
      return JSON.parse(raw) as TenantConfig
    } catch {
      logger.error('Failed to parse tenant config from KV', { brand_id: brandId })
      return null
    }
  }
}

// ─── File-backed store (Docker / K8s) ────────────────────────────────

export class FileTenantStore implements TenantStore {
  private tenants: Map<string, TenantConfig>

  constructor(tenants: TenantConfig[]) {
    this.tenants = new Map(tenants.map(t => [t.brand_id, t]))
  }

  async get(brandId: string): Promise<TenantConfig | null> {
    return this.tenants.get(brandId) ?? null
  }

  static fromJson(json: string): FileTenantStore {
    const data = JSON.parse(json) as { tenants: TenantConfig[] }
    return new FileTenantStore(data.tenants)
  }
}

// ─── Resolution + Validation ─────────────────────────────────────────

/**
 * Resolve a TenantConfig from a brand_id. Returns null if not found.
 * Validates the config before returning — malformed configs are rejected
 * with a logged error and null return.
 */
export async function resolveTenantConfig(
  brandId: string,
  store: TenantStore
): Promise<TenantConfig | null> {
  if (!brandId) return null
  const config = await store.get(brandId)
  if (!config) {
    logger.warn('Tenant not found', { brand_id: brandId })
    return null
  }

  // Validate config before returning — catches malformed KV entries or tenants.json
  try {
    validateTenantConfig(config)
  } catch (err) {
    logger.error('Invalid tenant config', { brand_id: brandId, error: (err as Error).message })
    return null
  }

  return config
}

/**
 * Validate that a TenantConfig has all required fields.
 * Throws with a descriptive message on failure.
 */
export function validateTenantConfig(config: TenantConfig): void {
  const missing: string[] = []

  if (!config.brand_id) missing.push('brand_id')
  if (!config.name) missing.push('name')

  // Zendesk section
  if (!config.zendesk?.subdomain) missing.push('zendesk.subdomain')
  if (!config.zendesk?.email) missing.push('zendesk.email')
  if (!config.zendesk?.apiToken) missing.push('zendesk.apiToken')
  if (!config.zendesk?.webhookSecret) missing.push('zendesk.webhookSecret')

  // Validate subdomain format (prevents URL injection via crafted subdomains)
  if (config.zendesk?.subdomain && !SUBDOMAIN_PATTERN.test(config.zendesk.subdomain)) {
    throw new Error(
      `Invalid tenant config for "${config.name || config.brand_id}": ` +
      `zendesk.subdomain contains invalid characters (must be alphanumeric/hyphens only)`
    )
  }

  // Malaskra section
  if (!config.malaskra?.apiKey) missing.push('malaskra.apiKey')

  // PDF section — required since pdf.ts accesses it unconditionally
  if (!config.pdf) {
    missing.push('pdf')
  } else {
    if (!config.pdf.companyName) missing.push('pdf.companyName')
    if (config.pdf.locale !== undefined && typeof config.pdf.locale !== 'string') {
      missing.push('pdf.locale (must be a string)')
    }
  }

  // At least one endpoint
  if (!config.endpoints || Object.keys(config.endpoints).length === 0) {
    missing.push('endpoints (at least one required)')
  }

  if (missing.length > 0) {
    throw new Error(`Invalid tenant config for "${config.name || config.brand_id}": missing ${missing.join(', ')}`)
  }

  // Validate each endpoint
  for (const [name, ep] of Object.entries(config.endpoints)) {
    validateEndpoint(name, ep)
  }
}

function validateEndpoint(name: string, ep: EndpointConfig): void {
  const missing: string[] = []

  if (!ep.type) missing.push('type')
  if (!ep.baseUrl) missing.push('baseUrl')

  // Validate baseUrl: must be HTTPS, must not point to private/reserved IPs
  if (ep.baseUrl) {
    try {
      const url = new URL(ep.baseUrl)
      if (url.protocol !== 'https:') {
        throw new Error(`Endpoint "${name}": baseUrl must use HTTPS (got "${url.protocol}")`)
      }
      // Block private/reserved IP ranges to prevent SSRF via config injection
      for (const pattern of PRIVATE_IP_PATTERNS) {
        if (pattern.test(url.hostname)) {
          throw new Error(`Endpoint "${name}": baseUrl must not point to a private/reserved address`)
        }
      }
    } catch (err) {
      if ((err as Error).message.startsWith('Endpoint')) throw err
      throw new Error(`Endpoint "${name}": invalid baseUrl "${ep.baseUrl}"`)
    }
  }

  if (ep.type === 'onesystems') {
    if (!ep.appKey) missing.push('appKey')
  } else if (ep.type === 'gopro') {
    if (!ep.username) missing.push('username')
    if (!ep.password) missing.push('password')
  } else if (ep.type) {
    throw new Error(`Endpoint "${name}": unknown type "${ep.type}". Must be "onesystems" or "gopro".`)
  }

  if (missing.length > 0) {
    throw new Error(`Endpoint "${name}": missing ${missing.join(', ')}`)
  }
}

/**
 * Validate that the requested doc_endpoint exists in the tenant's endpoints map.
 * Returns the EndpointConfig or throws.
 */
export function resolveEndpoint(tenantConfig: TenantConfig, docEndpoint: string): EndpointConfig {
  const ep = tenantConfig.endpoints[docEndpoint]
  if (!ep) {
    throw new Error(`Unknown doc_endpoint "${docEndpoint}"`)
  }
  return ep
}

/**
 * Validate an audit query parameter (brand_id, ticket_id).
 * Returns the sanitized value or null if invalid.
 */
export function sanitizeAuditParam(value: string | null): string | null {
  if (!value) return null
  return AUDIT_PARAM_PATTERN.test(value) ? value : null
}
