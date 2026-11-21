import { describe, it, expect } from 'vitest'
import { buildPdfFilename, MAX_SUBJECT_CHARS } from '../src/services/archive/pdfFilename.js'

describe('buildPdfFilename', () => {
  it('formats as "<id> - <subject>.pdf"', () => {
    expect(buildPdfFilename(12345, 'Umsókn um aðgang')).toBe('12345 - Umsókn um aðgang.pdf')
  })

  it('preserves Icelandic characters', () => {
    expect(buildPdfFilename(1, 'Þjóðskrá ÆÖÐ æöð áíóúéý')).toBe('1 - Þjóðskrá ÆÖÐ æöð áíóúéý.pdf')
  })

  it('replaces filename-unsafe characters and # / % with "-"', () => {
    expect(buildPdfFilename(7, 'a/b\\c:d*e?f"g<h>i|j#k%l')).toBe('7 - a-b-c-d-e-f-g-h-i-j-k-l.pdf')
  })

  it('removes line breaks and collapses whitespace', () => {
    expect(buildPdfFilename(7, '  Fyrsta\r\nlína \t  önnur  ')).toBe('7 - Fyrsta lína önnur.pdf')
  })

  it('trims trailing dots and spaces', () => {
    expect(buildPdfFilename(7, 'Spurning...  ')).toBe('7 - Spurning.pdf')
  })

  it('falls back to "<id>.pdf" for empty, whitespace-only or missing subject', () => {
    expect(buildPdfFilename(42, '')).toBe('42.pdf')
    expect(buildPdfFilename(42, '   ')).toBe('42.pdf')
    expect(buildPdfFilename(42, undefined)).toBe('42.pdf')
    expect(buildPdfFilename(42, null)).toBe('42.pdf')
  })

  it(`caps the subject at ${MAX_SUBJECT_CHARS} characters without splitting characters`, () => {
    const long = 'ð'.repeat(150)
    expect(buildPdfFilename(1, long)).toBe(`1 - ${'ð'.repeat(MAX_SUBJECT_CHARS)}.pdf`)
    const emoji = '😀'.repeat(150)
    const name = buildPdfFilename(1, emoji)
    expect(Array.from(name.slice(4, -4))).toHaveLength(MAX_SUBJECT_CHARS)
    expect(name).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })
})
