/**
 * Kennitala helpers, moved from the TR Smári app (tr-smari/src/kennitala.ts)
 * so the gateway, not the browser, decides what counts as valid.
 *
 * Kennitala check digit (9th digit): weights 3,2,7,6,5,4,3,2 over the
 * first 8 digits, check = 11 - (sum mod 11); 11 → 0, 10 → invalid.
 */

const WEIGHTS = [3, 2, 7, 6, 5, 4, 3, 2]

export function normalizeKennitala(input: string): string {
  return input.replace(/[\s-]/g, '')
}

export function isValidKennitala(input: string): boolean {
  const kt = normalizeKennitala(input)
  if (!/^\d{10}$/.test(kt)) return false
  const sum = WEIGHTS.reduce((acc, w, i) => acc + w * Number(kt[i]), 0)
  const rest = 11 - (sum % 11)
  const check = rest === 11 ? 0 : rest
  if (check === 10) return false
  return check === Number(kt[8])
}

/** Kennitala → DDMMYY-****, for logs and audit. */
export function maskKennitala(kt: string): string {
  const n = normalizeKennitala(kt)
  return /^\d{10}$/.test(n) ? `${n.slice(0, 6)}-****` : '****'
}
