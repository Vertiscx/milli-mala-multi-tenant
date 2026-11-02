/**
 * Kennitala and phone-number helpers, moved from the TR Smári app
 * (tr-smari/src/kennitala.ts) so the gateway, not the browser, decides
 * what counts as a valid target.
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

// Icelandic mobile numbers are 7 digits; accept an optional +354 / 00354 prefix.
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/[\s-]/g, '').replace(/^(\+354|00354)/, '')
  return /^\d{7}$/.test(digits) ? digits : null
}

export type EidTarget = { kind: 'kennitala'; value: string } | { kind: 'phone'; value: string }

export function parseEidTarget(input: string): EidTarget | null {
  if (isValidKennitala(input)) return { kind: 'kennitala', value: normalizeKennitala(input) }
  const phone = normalizePhone(input)
  return phone ? { kind: 'phone', value: phone } : null
}

/** Kennitala → DDMMYY-****, for logs, audit and the internal note. */
export function maskKennitala(kt: string): string {
  const n = normalizeKennitala(kt)
  return /^\d{10}$/.test(n) ? `${n.slice(0, 6)}-****` : '****'
}

/** Phone → ***-**NN, for logs, audit and the internal note. */
export function maskPhone(phone: string): string {
  return /^\d{7}$/.test(phone) ? `***-**${phone.slice(5)}` : '****'
}

export function maskTarget(target: EidTarget): string {
  return target.kind === 'kennitala' ? maskKennitala(target.value) : maskPhone(target.value)
}
