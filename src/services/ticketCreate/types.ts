export interface ZendeskOAuthTokenResponse {
  access_token: string
  token_type: string
  expires_in: number
  scope: string
}

export interface TicketCreateHttpRequest {
  body: Record<string, unknown>
  headers: Record<string, string>
}
