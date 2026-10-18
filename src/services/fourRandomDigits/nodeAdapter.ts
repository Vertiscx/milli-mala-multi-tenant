/**
 * Node HTTP adapter for the 4-random-digits handler: turns the Node request
 * into a Web Request (built into Node 20+) and writes the Web Response back.
 * The service takes no request body, so none is read or forwarded.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { FourRandomDigitsHandler } from './handler.js'

function toWebRequest(req: IncomingMessage): Request {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  return new Request(new URL(req.url ?? '/', 'http://localhost'), { method: req.method, headers })
}

export async function handleFourRandomDigitsHttp(
  handler: FourRandomDigitsHandler,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const response = await handler(toWebRequest(req))
  res.writeHead(response.status, Object.fromEntries(response.headers))
  res.end(await response.text())
}
