import type { TenantConfig, AuditStore, HandlerResult } from '../types.js'

export interface GatewayRequest {
  body: Record<string, unknown>
  rawBody: string
  headers: Record<string, string>
  tenantConfig: TenantConfig
  auditStore?: AuditStore
}

export interface ServiceRoute {
  method: 'POST'            // GET routes (health, audit) stay owned by the platform
  path: string               // exact match, e.g. '/v1/webhook'
  handler: (req: GatewayRequest) => Promise<HandlerResult>
}

export function findRoute(routes: ServiceRoute[], method: string, path: string): ServiceRoute | undefined {
  return routes.find(r => r.method === method && r.path === path)
}
