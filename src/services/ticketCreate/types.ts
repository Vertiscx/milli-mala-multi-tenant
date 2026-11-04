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

// The file is the raw request body, so everything else arrives in the
// query string and headers. readBody is called only after those checks
// pass, so an unauthenticated caller never gets a file read.
export interface TicketUploadHttpRequest {
  query: URLSearchParams
  headers: Record<string, string>
  readBody: () => Promise<Buffer>
}
