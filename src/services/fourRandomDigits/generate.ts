/**
 * Random 4-digit code generation (0000–9999).
 *
 * Draws a 16-bit value (0–65535) from the platform's cryptographically
 * secure generator — Web Crypto's getRandomValues, available on both Node
 * and Cloudflare Workers. 65536 isn't a multiple of 10000, so taking
 * `% 10000` of every draw would favour 0000–5535. Values ≥ 60000 are
 * therefore rejected and redrawn; the remaining 60000 values map onto
 * 0000–9999 exactly six times each, so every code is equally likely.
 */

/** Source of uniformly distributed integers in 0–65535. Injectable for tests. */
export type Uint16Source = () => number

/** Draws at or above this value are rejected (largest multiple of 10000 ≤ 65536). */
export const REJECTION_THRESHOLD = 60000

const CODE_SPACE = 10000
const CODE_LENGTH = 4

export function secureUint16(): number {
  const buffer = new Uint16Array(1)
  crypto.getRandomValues(buffer)
  return buffer[0]
}

export function generateCode(source: Uint16Source = secureUint16): string {
  for (;;) {
    const value = source()
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      throw new Error('Random source returned a value outside 0–65535')
    }
    if (value < REJECTION_THRESHOLD) {
      return String(value % CODE_SPACE).padStart(CODE_LENGTH, '0')
    }
  }
}
