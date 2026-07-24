import type { ServiceRoute, GatewayRequest } from '../../platform/http/routes.js'
import type { HandlerResult } from '../../platform/types.js'
import { handleWebhook } from './webhook.js'
import { handleAttachments } from './attachments.js'
import { handleCases } from './cases.js'

// doc_endpoint is an archive concept, so the archive routes check it themselves —
// with exactly the same error text the server used before:
function getDocEndpoint(req: GatewayRequest): string | HandlerResult {
  const docEndpoint = req.body.doc_endpoint != null ? String(req.body.doc_endpoint) : undefined
  if (!docEndpoint) return { status: 400, body: { error: 'Missing doc_endpoint' } }
  return docEndpoint
}

export const archiveRoutes: ServiceRoute[] = [
  {
    method: 'POST', path: '/v1/webhook',
    handler: async (req) => {
      const docEndpoint = getDocEndpoint(req)
      if (typeof docEndpoint !== 'string') return docEndpoint
      return handleWebhook({ body: req.body, rawBody: req.rawBody, headers: req.headers, tenantConfig: req.tenantConfig, docEndpoint, auditStore: req.auditStore })
    },
  },
  {
    method: 'POST', path: '/v1/attachments',
    handler: async (req) => {
      const docEndpoint = getDocEndpoint(req)
      if (typeof docEndpoint !== 'string') return docEndpoint
      return handleAttachments({ body: req.body, headers: req.headers, tenantConfig: req.tenantConfig, docEndpoint })
    },
  },
  {
    method: 'POST', path: '/v1/cases',
    handler: async (req) => {
      const docEndpoint = getDocEndpoint(req)
      if (typeof docEndpoint !== 'string') return docEndpoint
      return handleCases({ body: req.body, headers: req.headers, tenantConfig: req.tenantConfig, docEndpoint, auditStore: req.auditStore })
    },
  },
]
