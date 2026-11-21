/**
 * Filename for the archived ticket PDF: "<ticketId> - <subject>.pdf".
 *
 * The subject is made safe for document systems and file systems:
 * - characters illegal in Windows/SharePoint-style filenames and control
 *   characters (incl. line breaks) become "-"
 * - "#" and "%" also become "-" (they break URLs if a downstream system
 *   builds download links from the filename without encoding it)
 * - whitespace is collapsed, trailing dots/spaces are trimmed
 * - capped at MAX_SUBJECT_CHARS code points (never splits a character)
 * Icelandic letters (þ, ð, æ, ö, á, ...) are kept as-is.
 *
 * Empty/missing subject → "<ticketId>.pdf".
 */
export const MAX_SUBJECT_CHARS = 100

// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\\/:*?"<>|#%\u0000-\u001f\u007f]/g

export function buildPdfFilename(ticketId: number, subject: string | null | undefined): string {
  const cleaned = String(subject ?? '')
    .replace(/\s+/g, ' ')
    .replace(UNSAFE_CHARS, '-')
    .trim()

  const capped = Array.from(cleaned).slice(0, MAX_SUBJECT_CHARS).join('')
    .replace(/[\s.]+$/, '')

  return capped ? `${ticketId} - ${capped}.pdf` : `${ticketId}.pdf`
}
