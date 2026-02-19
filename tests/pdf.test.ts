import { describe, it, expect } from 'vitest'
import { generateTicketPdf, parseHtmlToBlocks } from '../src/pdf.js'
import type { PdfConfig } from '../src/types.js'

const defaultPdfConfig: PdfConfig = {
  companyName: 'Test Company',
  locale: 'is-IS',
  includeInternalNotes: false
}

describe('generateTicketPdf', () => {
  const mockTicket = {
    id: 42,
    subject: 'Test ticket subject',
    status: 'closed',
    created_at: '2025-06-15T10:00:00Z',
    updated_at: '2025-06-16T14:00:00Z'
  }

  const mockComments = [
    { id: 1, body: 'Public comment', public: true, author_id: 1, created_at: '2025-06-15T10:00:00Z' },
    { id: 2, body: 'Internal note', public: false, author_id: 2, created_at: '2025-06-15T11:00:00Z' },
    { id: 3, body: '<p>HTML comment</p>', public: true, author_id: 1, created_at: '2025-06-15T12:00:00Z' }
  ]

  it('should return a Buffer', async () => {
    const result = await generateTicketPdf(mockTicket, mockComments as any, { pdfConfig: defaultPdfConfig })
    expect(result).toBeInstanceOf(Buffer)
    expect(result.length).toBeGreaterThan(0)
  })

  it('should produce valid PDF (starts with %PDF header)', async () => {
    const result = await generateTicketPdf(mockTicket, mockComments as any, { pdfConfig: defaultPdfConfig })
    const header = result.slice(0, 5).toString('ascii')
    expect(header).toBe('%PDF-')
  })

  it('should exclude internal notes when configured', async () => {
    const excludeConfig: PdfConfig = { ...defaultPdfConfig, includeInternalNotes: false }
    const includeConfig: PdfConfig = { ...defaultPdfConfig, includeInternalNotes: true }

    const resultExcluding = await generateTicketPdf(mockTicket, mockComments as any, { pdfConfig: excludeConfig })
    const resultIncluding = await generateTicketPdf(mockTicket, mockComments as any, { pdfConfig: includeConfig })

    // The PDF with internal notes should be larger (more content)
    expect(resultIncluding.length).toBeGreaterThan(resultExcluding.length)
  })

  it('should handle empty comments', async () => {
    const result = await generateTicketPdf(mockTicket, [], { pdfConfig: defaultPdfConfig })
    expect(result).toBeInstanceOf(Buffer)
    expect(result.length).toBeGreaterThan(0)
  })

  it('should handle ticket without updated_at', async () => {
    const ticket = { ...mockTicket, updated_at: undefined }
    const result = await generateTicketPdf(ticket, [], { pdfConfig: defaultPdfConfig })
    expect(result).toBeInstanceOf(Buffer)
  })

  it('should render rich HTML in comment bodies', async () => {
    const comments = [
      { id: 1, html_body: '<p>Hello <strong>bold</strong> and <em>italic</em></p>', public: true, author_id: 1, created_at: '2025-01-01T00:00:00Z' }
    ]
    const result = await generateTicketPdf(mockTicket, comments as any, { pdfConfig: defaultPdfConfig })
    expect(result).toBeInstanceOf(Buffer)
  })

  it('should use userMap for author names', async () => {
    const comments = [
      { id: 1, body: 'Comment', public: true, author_id: 42, created_at: '2025-01-01T00:00:00Z' }
    ]
    const userMap = { 42: 'Jón Jónsson' }
    const result = await generateTicketPdf(mockTicket, comments as any, { pdfConfig: defaultPdfConfig, userMap })
    expect(result).toBeInstanceOf(Buffer)
    expect(result.length).toBeGreaterThan(0)
  })
})

describe('parseHtmlToBlocks', () => {
  it('should return empty array for empty input', () => {
    expect(parseHtmlToBlocks('')).toEqual([])
    expect(parseHtmlToBlocks(null)).toEqual([])
  })

  it('should parse plain text as a single paragraph', () => {
    const blocks = parseHtmlToBlocks('Hello world')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe('paragraph')
    expect(blocks[0].runs[0].text).toBe('Hello world')
    expect(blocks[0].runs[0].bold).toBe(false)
  })

  it('should parse bold text', () => {
    const blocks = parseHtmlToBlocks('Normal <b>bold</b> text')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].runs).toHaveLength(3)
    expect(blocks[0].runs[0].bold).toBe(false)
    expect(blocks[0].runs[1].bold).toBe(true)
    expect(blocks[0].runs[1].text).toBe('bold')
    expect(blocks[0].runs[2].bold).toBe(false)
  })

  it('should parse strong as bold', () => {
    const blocks = parseHtmlToBlocks('<strong>bold</strong>')
    expect(blocks[0].runs[0].bold).toBe(true)
  })

  it('should parse italic text', () => {
    const blocks = parseHtmlToBlocks('<em>italic</em>')
    expect(blocks[0].runs[0].italic).toBe(true)
  })

  it('should split paragraphs into separate blocks', () => {
    const blocks = parseHtmlToBlocks('<p>First</p><p>Second</p>')
    expect(blocks).toHaveLength(2)
    expect(blocks[0].runs[0].text).toBe('First')
    expect(blocks[1].runs[0].text).toBe('Second')
  })

  it('should handle br as block separator', () => {
    const blocks = parseHtmlToBlocks('Line one<br>Line two')
    expect(blocks).toHaveLength(2)
  })

  it('should parse unordered lists', () => {
    const blocks = parseHtmlToBlocks('<ul><li>Item one</li><li>Item two</li></ul>')
    expect(blocks).toHaveLength(2)
    expect(blocks[0].type).toBe('list-item')
    expect(blocks[0].runs[0].text).toBe('\u2022 ')
    expect(blocks[0].runs[1].text).toBe('Item one')
  })

  it('should parse ordered lists', () => {
    const blocks = parseHtmlToBlocks('<ol><li>First</li><li>Second</li></ol>')
    expect(blocks).toHaveLength(2)
    expect(blocks[0].runs[0].text).toBe('1. ')
    expect(blocks[1].runs[0].text).toBe('2. ')
  })

  it('should handle blockquote indentation', () => {
    const blocks = parseHtmlToBlocks('<blockquote>Quoted text</blockquote>')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].indent).toBe(20)
  })

  it('should decode HTML entities', () => {
    const blocks = parseHtmlToBlocks('&amp; &lt; &gt; &quot;')
    expect(blocks[0].runs[0].text).toBe('& < > "')
  })

  it('should handle links with href', () => {
    const blocks = parseHtmlToBlocks('<a href="https://example.com">click here</a>')
    expect(blocks).toHaveLength(1)
    const text = blocks[0].runs.map(r => r.text).join('')
    expect(text).toContain('click here')
    expect(text).toContain('https://example.com')
  })

  it('should remove script and style tags', () => {
    const blocks = parseHtmlToBlocks('Hello<script>alert("xss")</script> world')
    const text = blocks.map(b => b.runs.map(r => r.text).join('')).join('')
    expect(text).not.toContain('alert')
    expect(text).toContain('Hello')
    expect(text).toContain('world')
  })

  it('should handle headings', () => {
    const blocks = parseHtmlToBlocks('<h2>Title</h2>')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe('heading')
  })
})
