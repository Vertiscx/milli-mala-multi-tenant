import type { HandlerResult } from '../../platform/types.js'

export interface ZendeskOAuthTokenResponse {
  access_token: string
  token_type: string
  expires_in: number
  scope: string
}

export interface UserUpdateHttpRequest {
  body: Record<string, unknown>
  headers: Record<string, string>
}

// A 429 passes Zendesk's Retry-After on to the caller, so this service's
// results can carry response headers.
export type UserUpdateResult = HandlerResult & { headers?: Record<string, string> }

// The fields of a Zendesk user this service reads.
export interface ZendeskUserRecord {
  id: number
  email?: string | null
  role?: string
}
