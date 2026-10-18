/**
 * Huld clientlookup response → normalized customer card. The only file
 * that knows TR's lookup response shape; moved from tr-smari/src/tr/mapper.ts
 * so a change on TR's side no longer needs an app release.
 *
 * TR has not yet sent real samples, so the mapper accepts the likely key
 * spellings (English camelCase and Icelandic), as the app did. Update this
 * file and the test fixtures when TR's samples arrive.
 */

export interface Application {
  type: string
  status: string
  submittedDate: string | null
  url: string | null
}

export interface Customer {
  name: string
  nationalId: string
  phone: string | null
  email: string | null
  url: string | null
  applications: Application[]
}

type Raw = Record<string, unknown>

function pick(obj: Raw, keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k]
  }
  return undefined
}

function text(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null
  if (typeof v === 'number') return String(v)
  return null
}

// Deep links are rendered as <a href> in the app; only http(s) passes, so a
// bad payload can't inject javascript: URLs.
export function safeUrl(v: unknown): string | null {
  const s = text(v)
  if (!s) return null
  try {
    const u = new URL(s)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null
  } catch {
    return null
  }
}

function unwrap(raw: unknown): Raw | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Raw
  const inner = pick(obj, ['data', 'result', 'client', 'customer'])
  return inner && typeof inner === 'object' && !Array.isArray(inner) ? (inner as Raw) : obj
}

// ISO dates (2026-09-14 or 2026-09-14T…) are shown Icelandic-style: 14.09.2026.
export function formatDate(v: string | null): string | null {
  const m = v?.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[3]}.${m[2]}.${m[1]}` : v ?? null
}

const CLOSED = /^(closed|lokið|lokuð|afgreidd|completed|cancelled|hafnað)$/i

function mapApplication(raw: unknown): Application | null {
  if (!raw || typeof raw !== 'object') return null
  const a = raw as Raw
  const type = text(pick(a, ['type', 'applicationType', 'name', 'title', 'tegund', 'heiti']))
  const status = text(pick(a, ['status', 'state', 'stada', 'staða']))
  if (!type && !status) return null
  return {
    type: type ?? '—',
    status: status ?? '—',
    submittedDate: formatDate(text(pick(a, ['submittedDate', 'dateSubmitted', 'submitted', 'createdDate', 'created', 'dagsetning', 'mottekin']))),
    url: safeUrl(pick(a, ['url', 'link', 'deepLink', 'slod', 'slóð'])),
  }
}

export function mapClientLookup(raw: unknown): Customer | null {
  const c = unwrap(raw)
  if (!c) return null
  const nationalId = text(pick(c, ['nationalId', 'kennitala', 'ssn', 'nationalID']))
  const name = text(pick(c, ['name', 'fullName', 'nafn']))
  if (!nationalId && !name) return null

  const appsRaw = pick(c, ['openApplications', 'applications', 'umsoknir', 'umsóknir', 'opnarUmsoknir'])
  const applications = (Array.isArray(appsRaw) ? appsRaw : [])
    .map(mapApplication)
    .filter((a): a is Application => a !== null && !CLOSED.test(a.status))

  return {
    name: name ?? '—',
    nationalId: nationalId ?? '',
    phone: text(pick(c, ['phone', 'phoneNumber', 'mobile', 'simi', 'sími', 'simanumer', 'símanúmer'])),
    email: text(pick(c, ['email', 'emailAddress', 'netfang'])),
    url: safeUrl(pick(c, ['url', 'link', 'deepLink', 'clientUrl', 'slod', 'slóð'])),
    applications,
  }
}
