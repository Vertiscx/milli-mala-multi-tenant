/**
 * Shared factory for document system clients.
 * Used by both webhook and attachments handlers.
 */

import { OneSystemsClient } from './onesystems.js'
import { GoProClient } from './gopro.js'
import { WorkpointClient } from './workpoint.js'
import type { EndpointConfig } from '../../platform/types.js'
import type { DocClient } from './types.js'

/**
 * Build a DocClient from an EndpointConfig.
 * Throws if required credentials are missing for the endpoint type.
 */
export function createDocClient(ep: EndpointConfig, user?: string): DocClient {
  if (ep.type === 'gopro') {
    if (!ep.username || !ep.password) {
      throw new Error('GoPro endpoint missing username or password')
    }
    return new GoProClient(ep.baseUrl, ep.username, ep.password, {
      tokenTtlMs: ep.tokenTtlMs
    })
  }
  if (ep.type === 'workpoint') {
    if (!ep.appKey || !ep.clientId) {
      throw new Error('WorkPoint endpoint missing appKey or clientId')
    }
    return new WorkpointClient(ep.baseUrl, ep.appKey, ep.clientId, {
      tokenTtlMs: ep.tokenTtlMs,
      user: user || 'Zendesk'
    })
  }
  if (!ep.appKey) {
    throw new Error('OneSystems endpoint missing appKey')
  }
  return new OneSystemsClient(ep.baseUrl, ep.appKey, {
    tokenTtlMs: ep.tokenTtlMs,
    user: user || 'Zendesk'
  })
}
