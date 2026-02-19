/**
 * PDF Generator - creates ticket documentation PDF using jsPDF
 * Renders rich text (HTML) from Zendesk comments with basic formatting.
 */

import { jsPDF } from 'jspdf'
import type { ZendeskTicket, ZendeskComment, PdfConfig, PdfBlock, PdfRun } from './types.js'

interface PdfOptions {
  pdfConfig: PdfConfig
  userMap?: Record<number | string, string>
}

export async function generateTicketPdf(ticket: ZendeskTicket, comments: ZendeskComment[], options: PdfOptions): Promise<Buffer> {
  const { pdfConfig } = options
  const includeInternalNotes = pdfConfig.includeInternalNotes
  const userMap = options.userMap || {}

  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const margin = 50
  const maxWidth = pageWidth - margin * 2
  let y = margin

  // Header
  if (pdfConfig.companyName) {
    doc.setFontSize(10)
    const companyWidth = doc.getTextWidth(pdfConfig.companyName)
    doc.text(pdfConfig.companyName, pageWidth - margin - companyWidth, y)
    y += 14
  }
  const dateStr = new Date().toLocaleDateString(pdfConfig.locale)
  doc.setFontSize(8)
  const dateWidth = doc.getTextWidth(dateStr)
  doc.text(dateStr, pageWidth - margin - dateWidth, y)
  y += 24

  // Title
  doc.setFontSize(18)
  const title = `Miði #${ticket.id}`
  const titleWidth = doc.getTextWidth(title)
  doc.text(title, (pageWidth - titleWidth) / 2, y)
  y += 28

  // Ticket info
  doc.setFontSize(12)
  doc.text(`Efni: ${ticket.subject}`, margin, y)
  y += 16
  doc.setFontSize(10)
  doc.text(`Staða: ${ticket.status}`, margin, y)
  y += 14
  doc.text(`Stofnað: ${formatDate(ticket.created_at, pdfConfig.locale)}`, margin, y)
  y += 14
  if (ticket.updated_at) {
    doc.text(`Uppfært: ${formatDate(ticket.updated_at, pdfConfig.locale)}`, margin, y)
    y += 14
  }
  y += 14

  // Comments header
  doc.setFontSize(14)
  doc.text('Samskipti', margin, y)
  const textWidth = doc.getTextWidth('Samskipti')
  doc.line(margin, y + 2, margin + textWidth, y + 2)
  y += 20

  // Filter comments
  const filteredComments = includeInternalNotes
    ? comments
    : comments.filter(c => c.public !== false)

  for (const comment of filteredComments) {
    const isInternal = comment.public === false
    const authorName = userMap[comment.author_id] || `User ${comment.author_id || 'Unknown'}`
    const header = `${formatDate(comment.created_at, pdfConfig.locale)} \u2014 ${authorName}${isInternal ? ' (innri athugasemd)' : ''}`

    // Check if we need a new page
    if (y > pageHeight - 80) {
      doc.addPage()
      y = margin
    }

    // Internal note: top padding for grey background
    if (isInternal) {
      doc.setFillColor(240, 240, 240)
      doc.rect(margin - 6, y - 18, maxWidth + 12, 6, 'F')
    }

    // Comment header (bold)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    const headerLines = doc.splitTextToSize(header, maxWidth)
    for (const line of headerLines) {
      if (y > pageHeight - 40) {
        doc.addPage()
        y = margin
      }
      if (isInternal) {
        doc.setFillColor(240, 240, 240)
        doc.rect(margin - 6, y - 12, maxWidth + 12, 17, 'F')
      }
      doc.text(line, margin, y)
      y += 13
    }
    y += 2

    // Comment body - render as rich text
    const htmlBody = comment.html_body || comment.body || comment.plain_body || ''
    const blocks = parseHtmlToBlocks(htmlBody)
    y = renderBlocks(doc, blocks, y, margin, maxWidth, pageHeight, { isInternal })

    // Internal note: bottom padding for grey background
    if (isInternal) {
      doc.setFillColor(240, 240, 240)
      doc.rect(margin - 6, y - 4, maxWidth + 12, 8, 'F')
    }

    // Separator line after each comment
    y += 6
    doc.setDrawColor(200, 200, 200)
    doc.setLineWidth(0.5)
    doc.line(margin, y, pageWidth - margin, y)
    y += 14
  }

  const arrayBuffer = doc.output('arraybuffer')
  return Buffer.from(arrayBuffer)
}

function formatDate(dateStr: string, locale: string): string {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleString(locale)
}

// ─── HTML → Block Parser ──────────────────────────────────────────────

/**
 * Parse HTML into structured blocks for PDF rendering.
 * Each block has: type, indent, runs[{text, bold, italic}]
 */
export function parseHtmlToBlocks(html: string | null | undefined): PdfBlock[] {
  if (!html) return []

  // Remove script/style tags with content
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')

  const blocks: PdfBlock[] = []
  let currentBlock: PdfBlock | null = null
  let bold = false
  let italic = false
  const listStack: { type: string; index: number }[] = []
  let blockquoteDepth = 0
  let linkHref: string | null = null
  let pos = 0

  function ensureBlock(): void {
    if (!currentBlock) {
      currentBlock = {
        type: 'paragraph',
        runs: [],
        indent: (listStack.length * 15) + (blockquoteDepth * 20)
      }
    }
  }

  function addText(text: string): void {
    if (!text) return
    ensureBlock()
    currentBlock!.runs.push({ text, bold, italic })
  }

  function flushBlock(): void {
    if (currentBlock && currentBlock.runs.length > 0) {
      blocks.push(currentBlock)
    }
    currentBlock = null
  }

  while (pos < cleaned.length) {
    if (cleaned[pos] === '<') {
      const tagEnd = cleaned.indexOf('>', pos)
      if (tagEnd === -1) {
        addText(cleaned.substring(pos))
        break
      }

      const fullTag = cleaned.substring(pos + 1, tagEnd).trim()
      const isClosing = fullTag.startsWith('/')
      const tagStr = isClosing ? fullTag.substring(1) : fullTag
      const tagName = tagStr.replace(/\/$/, '').split(/[\s/]/)[0].toLowerCase()

      pos = tagEnd + 1

      // Block-level elements
      if (tagName === 'p' || tagName === 'div') {
        flushBlock()
      } else if (tagName === 'br') {
        flushBlock()
      } else if (/^h[1-6]$/.test(tagName)) {
        if (!isClosing) {
          flushBlock()
          ensureBlock()
          currentBlock!.type = 'heading'
          bold = true
        } else {
          bold = false
          flushBlock()
        }
      } else if (tagName === 'blockquote') {
        flushBlock()
        if (!isClosing) blockquoteDepth++
        else blockquoteDepth = Math.max(0, blockquoteDepth - 1)
      } else if (tagName === 'ul' || tagName === 'ol') {
        flushBlock()
        if (!isClosing) listStack.push({ type: tagName, index: 0 })
        else listStack.pop()
      } else if (tagName === 'li') {
        if (!isClosing) {
          flushBlock()
          const list = listStack[listStack.length - 1]
          ensureBlock()
          currentBlock!.type = 'list-item'
          currentBlock!.indent = listStack.length * 15
          if (list) {
            list.index++
            const prefix = list.type === 'ol' ? `${list.index}. ` : '\u2022 '
            currentBlock!.runs.push({ text: prefix, bold: false, italic: false })
          }
        } else {
          flushBlock()
        }
      }
      // Inline elements
      else if (tagName === 'strong' || tagName === 'b') {
        bold = !isClosing
      } else if (tagName === 'em' || tagName === 'i') {
        italic = !isClosing
      } else if (tagName === 'a') {
        if (!isClosing) {
          const hrefMatch = fullTag.match(/href\s*=\s*["']([^"']*)["']/i)
          linkHref = hrefMatch ? hrefMatch[1] : null
        } else {
          if (linkHref) {
            addText(` (${linkHref})`)
            linkHref = null
          }
        }
      }
      // Table cells: add space between cells
      else if (tagName === 'td' || tagName === 'th') {
        if (isClosing) addText('  ')
      } else if (tagName === 'tr') {
        if (isClosing) flushBlock()
      }
      // Ignore all other tags (img, span, table, thead, tbody, etc.)

    } else {
      // Collect text until next tag
      const nextTag = cleaned.indexOf('<', pos)
      const textEnd = nextTag === -1 ? cleaned.length : nextTag
      addText(cleaned.substring(pos, textEnd))
      pos = textEnd
    }
  }

  flushBlock()

  // Post-process: decode entities and collapse whitespace in runs
  for (const block of blocks) {
    for (const run of block.runs) {
      run.text = decodeEntities(run.text).replace(/\s+/g, ' ')
    }
  }

  return blocks
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&[#\w]+;/g, ' ')
}

// ─── Rich Text Renderer ──────────────────────────────────────────────

function getFontStyle(b: boolean, i: boolean): string {
  if (b && i) return 'bolditalic'
  if (b) return 'bold'
  if (i) return 'italic'
  return 'normal'
}

function renderBlocks(doc: jsPDF, blocks: PdfBlock[], startY: number, margin: number, maxWidth: number, pageHeight: number, options: { isInternal?: boolean } = {}): number {
  const { isInternal } = options
  let y = startY

  for (const block of blocks) {
    const indent = block.indent || 0
    const blockX = margin + indent
    const blockWidth = maxWidth - indent
    const fontSize = block.type === 'heading' ? 11 : 9
    doc.setFontSize(fontSize)

    const lines = wrapStyledRuns(doc, block.runs, blockWidth, fontSize)

    for (const line of lines) {
      if (y > pageHeight - 40) {
        doc.addPage()
        y = margin
      }

      if (isInternal) {
        doc.setFillColor(240, 240, 240)
        doc.rect(margin - 6, y - (fontSize + 1), maxWidth + 12, fontSize * 1.4 + 4, 'F')
      }

      let x = blockX
      for (const segment of line) {
        doc.setFont('helvetica', getFontStyle(segment.bold, segment.italic))
        doc.setFontSize(fontSize)
        doc.text(segment.text, x, y)
        x += doc.getTextWidth(segment.text)
      }
      y += fontSize * 1.4
    }

    y += block.type === 'heading' ? 6 : 2
  }

  return y
}

function wrapStyledRuns(doc: jsPDF, runs: PdfRun[], maxWidth: number, fontSize: number): PdfRun[][] {
  const lines: PdfRun[][] = []
  let currentLine: PdfRun[] = []
  let currentWidth = 0

  for (const run of runs) {
    const style = getFontStyle(run.bold, run.italic)
    doc.setFont('helvetica', style)
    doc.setFontSize(fontSize)

    const parts = run.text.split(/( +)/)

    for (const part of parts) {
      if (!part) continue

      const partWidth = doc.getTextWidth(part)

      if (currentWidth + partWidth > maxWidth && currentLine.length > 0 && part.trim()) {
        lines.push(currentLine)
        currentLine = []
        currentWidth = 0
        if (!part.trim()) continue
      }

      currentLine.push({ text: part, bold: run.bold, italic: run.italic })
      currentWidth += partWidth
    }
  }

  if (currentLine.length > 0) {
    lines.push(currentLine)
  }

  return lines.length > 0 ? lines : [[{ text: '', bold: false, italic: false }]]
}
