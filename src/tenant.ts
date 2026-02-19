/**
 * Tenant resolution — looks up TenantConfig by brand_id from a backing store.
 *
 * Cloudflare Workers → KV store
 * Docker / K8s      → tenants.json file
 */

import type { TenantConfig, EndpointConfig } from './types.js'
import { createLogger } from './logger.js'

const logger = createLogger('tenant')

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

  // Malaskra section
  if (!config.malaskra?.apiKey) missing.push('malaskra.apiKey')

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
    const available = Object.keys(tenantConfig.endpoints).join(', ')
    throw new Error(`Unknown doc_endpoint "${docEndpoint}". Available: ${available}`)
  }
  return ep
}
