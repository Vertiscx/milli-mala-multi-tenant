/**
 * Images pasted into comments and side conversation messages: the parser,
 * the per-image decision (draw / send separately / report), the fetch step
 * and the PDF.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ZendeskClient } from '../src/platform/zendesk.js'
import { parseHtmlToBlocks, generateTicketPdf } from '../src/services/archive/pdf.js'
import {
  collectImageSources,
  detectImageFormat,
  prepareInlineImages,
  INLINE_IMAGE_LIMITS
} from '../src/services/archive/inlineImages.js'
import { fetchTicketInfo } from '../src/services/archive/pipeline/fetch.js'
import type { TenantConfig, PdfConfig, DownloadedAttachment, SideConversationThread } from '../src/platform/types.js'
import type { InlineImageMap } from '../src/services/archive/types.js'
import { PNG_4x2, JPEG_4x2, GIF_4x2 } from './fixtures/images.js'

global.fetch = vi.fn() as unknown as typeof fetch
const fetchMock = global.fetch as ReturnType<typeof vi.fn>

const SUB = 'test-subdomain'
const API = `https://${SUB}.zendesk.com/api/v2`
const IMG = (token: string, name: string) => `https://${SUB}.zendesk.com/attachments/token/${token}/?name=${name}`

const png = Buffer.from(PNG_4x2, 'base64')
const jpeg = Buffer.from(JPEG_4x2, 'base64')
const gif = Buffer.from(GIF_4x2, 'base64')
const brokenPng = Buffer.concat([png.subarray(0, 8), Buffer.from('not really a png')])

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }
}

function file(data: Buffer, contentType: string) {
  return {
    ok: true, status: 200,
    headers: new Headers({ 'content-type': contentType }),
    arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.length)
  }
}

function urls(): string[] {
  return fetchMock.mock.calls.map(([url]) => url as string)
}

const client = () => new ZendeskClient(SUB, 'test-token', 'test@example.com')

beforeEach(() => {
  fetchMock.mockReset()
})

describe('parseHtmlToBlocks — <img>', () => {
  it('turns an <img> into its own image block between the text around it', () => {
    const blocks = parseHtmlToBlocks('<p>Sjá villuna:<img src="https://x.zendesk.com/a.png"> og meira</p>')
    expect(blocks.map(b => b.type)).toEqual(['paragraph', 'image', 'paragraph'])
    expect(blocks[1].src).toBe('https://x.zendesk.com/a.png')
  })

  it('decodes entities in the src and accepts single-quoted and unquoted values', () => {
    expect(parseHtmlToBlocks('<img src="https://x.zendesk.com/a/?name=a.png&amp;b=1">')[0].src)
      .toBe('https://x.zendesk.com/a/?name=a.png&b=1')
    expect(parseHtmlToBlocks("<img alt='x' src='https://x.zendesk.com/b.png' />")[0].src).toBe('https://x.zendesk.com/b.png')
    expect(parseHtmlToBlocks('<img src=https://x.zendesk.com/c.png>')[0].src).toBe('https://x.zendesk.com/c.png')
  })

  it('ignores an <img> without a src, as before', () => {
    expect(parseHtmlToBlocks('<p>Texti<img alt="x"></p>').map(b => b.type)).toEqual(['paragraph'])
  })
})

describe('collectImageSources / detectImageFormat', () => {
  it('lists each src once, in order of appearance across bodies', () => {
    expect(collectImageSources([
      '<img src="https://x.zendesk.com/1.png"><img src="https://x.zendesk.com/2.png">',
      '<p>no images</p>',
      '<img src="https://x.zendesk.com/1.png"><img src="cid:abc">'
    ])).toEqual(['https://x.zendesk.com/1.png', 'https://x.zendesk.com/2.png', 'cid:abc'])
  })

  it('recognises PNG and JPEG by their first bytes only', () => {
    expect(detectImageFormat(png)).toBe('PNG')
    expect(detectImageFormat(jpeg)).toBe('JPEG')
    expect(detectImageFormat(gif)).toBeNull()
    expect(detectImageFormat(Buffer.from('<svg/>'))).toBeNull()
  })
})

describe('prepareInlineImages', () => {
  async function prepare(sources: string[], attachments: DownloadedAttachment[] = [], limits = INLINE_IMAGE_LIMITS) {
    return prepareInlineImages(client(), sources, attachments, '111', limits)
  }

  it('draws a PNG and a JPEG in the PDF and sends nothing separately', async () => {
    fetchMock
      .mockResolvedValueOnce(file(png, 'image/png'))
      .mockResolvedValueOnce(file(jpeg, 'image/jpeg'))
    const r = await prepare([IMG('a', 'skjamynd.png'), IMG('b', 'mynd.jpg')])
    expect(r.images.get(IMG('a', 'skjamynd.png'))).toMatchObject({ kind: 'embed', format: 'PNG', width: 4, height: 2 })
    expect(r.images.get(IMG('b', 'mynd.jpg'))).toMatchObject({ kind: 'embed', format: 'JPEG', width: 4, height: 2 })
    expect(r.separateFiles).toEqual([])
    expect(r.failed).toEqual([])
  })

  it('downloads with the same sign-in as attachments (Basic for an API-token client)', async () => {
    fetchMock.mockResolvedValueOnce(file(png, 'image/png'))
    await prepare([IMG('a', 'a.png')])
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Basic /)
  })

  it('sends a GIF to the archive as a separate file with a numbered name and a matching placeholder', async () => {
    fetchMock
      .mockResolvedValueOnce(file(png, 'image/png'))
      .mockResolvedValueOnce(file(gif, 'image/gif; charset=binary'))
    const r = await prepare([IMG('a', 'a.png'), IMG('g', 'hreyfimynd.gif')])
    expect(r.separateFiles).toHaveLength(1)
    expect(r.separateFiles[0]).toMatchObject({ filename: 'mynd-2-hreyfimynd.gif', contentType: 'image/gif', size: gif.length })
    expect(r.images.get(IMG('g', 'hreyfimynd.gif'))).toEqual({
      kind: 'separate', placeholder: '[Mynd: hreyfimynd.gif – vistuð sem sérstakt skjal: mynd-2-hreyfimynd.gif]'
    })
    expect(r.failed).toEqual([])
  })

  it('sends a damaged PNG separately instead of breaking the PDF', async () => {
    fetchMock.mockResolvedValueOnce(file(brokenPng, 'image/png'))
    const r = await prepare([IMG('x', 'brotin.png')])
    expect(r.images.get(IMG('x', 'brotin.png'))?.kind).toBe('separate')
    expect(r.separateFiles[0].filename).toBe('mynd-1-brotin.png')
  })

  it('sends a PNG over the embed size limit separately', async () => {
    fetchMock.mockResolvedValueOnce(file(png, 'image/png'))
    const r = await prepare([IMG('a', 'stor.png')], [], { ...INLINE_IMAGE_LIMITS, maxEmbedBytes: png.length - 1 })
    expect(r.images.get(IMG('a', 'stor.png'))?.kind).toBe('separate')
  })

  it('reports a failed download: placeholder in the PDF, entry for the result note, nothing sent', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403 })
    const r = await prepare([IMG('a', 'a.png')])
    expect(r.images.get(IMG('a', 'a.png'))).toEqual({ kind: 'failed', placeholder: '[Mynd: a.png – tókst ekki að sækja]' })
    expect(r.failed).toEqual([{ filename: 'mynd-1-a.png', reason: 'mynd í texta: download status 403' }])
    expect(r.separateFiles).toEqual([])
  })

  it('never fetches an image from a host outside Zendesk', async () => {
    const r = await prepare(['https://evil-zendesk.com/a.png', 'http://test-subdomain.zendesk.com/b.png'])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(r.failed.map(f => f.reason)).toEqual(['mynd í texta: non-Zendesk URL', 'mynd í texta: non-HTTPS URL'])
  })

  it('reports cid: and relative sources as unsupported without fetching', async () => {
    const r = await prepare(['cid:image001.png@01DA', '/images/a.png'])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(r.failed.map(f => f.reason)).toEqual(['mynd í texta: unsupported image source', 'mynd í texta: unsupported image source'])
  })

  it('reads data: URI images without any download', async () => {
    const r = await prepare([`data:image/png;base64,${PNG_4x2}`, `data:image/gif;base64,${GIF_4x2}`])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(r.images.get(`data:image/png;base64,${PNG_4x2}`)?.kind).toBe('embed')
    expect(r.separateFiles.map(f => f.filename)).toEqual(['mynd-2-mynd.gif'])
  })

  it('stops at the image count limit and reports the rest', async () => {
    fetchMock.mockResolvedValue(file(png, 'image/png'))
    const r = await prepare([IMG('a', 'a.png'), IMG('b', 'b.png')], [], { ...INLINE_IMAGE_LIMITS, maxImages: 1 })
    expect(urls()).toHaveLength(1)
    expect(r.images.get(IMG('b', 'b.png'))).toEqual({ kind: 'failed', placeholder: '[Mynd: b.png – ekki vistuð, hámarki mynda náð]' })
    expect(r.failed).toEqual([{ filename: 'mynd-2-b.png', reason: 'mynd í texta: image count limit reached' }])
  })

  it('stops at the download size limit', async () => {
    fetchMock.mockResolvedValue(file(png, 'image/png'))
    const r = await prepare([IMG('a', 'a.png'), IMG('b', 'b.png')], [], { ...INLINE_IMAGE_LIMITS, maxTotalBytes: png.length + 1 })
    expect(r.images.get(IMG('a', 'a.png'))?.kind).toBe('embed')
    expect(r.failed.map(f => f.reason)).toEqual(['mynd í texta: total size limit reached'])
  })

  it('shares the 50-file archive limit with the ticket\'s attachments', async () => {
    fetchMock.mockResolvedValueOnce(file(gif, 'image/gif'))
    const full = Array.from({ length: 50 }, (_, i) => ({ filename: `f${i}`, contentType: 'x', size: 1, data: Buffer.from('x') }))
    const r = await prepare([IMG('g', 'g.gif')], full)
    expect(r.separateFiles).toEqual([])
    expect(r.failed).toEqual([{ filename: 'mynd-1-g.gif', reason: 'mynd í texta: file count limit reached' }])
    expect(r.images.get(IMG('g', 'g.gif'))).toEqual({ kind: 'failed', placeholder: '[Mynd: g.gif – ekki vistuð, hámarki skjala náð]' })
  })

  it('shares the archive size limit with the ticket\'s attachments', async () => {
    fetchMock.mockResolvedValueOnce(file(gif, 'image/gif'))
    const big = [{ filename: 'big', contentType: 'x', size: 10, data: Buffer.alloc(10) }]
    const r = await prepare([IMG('g', 'g.gif')], big, { ...INLINE_IMAGE_LIMITS, maxArchiveBytes: 10 + gif.length - 1 })
    expect(r.failed.map(f => f.reason)).toEqual(['mynd í texta: total size limit reached'])
  })

  it('makes a separate file name safe and falls back to "mynd" without a name', async () => {
    fetchMock
      .mockResolvedValueOnce(file(gif, 'image/gif'))
      .mockResolvedValueOnce(file(gif, 'image/gif'))
    const r = await prepare([IMG('a', encodeURIComponent('../../etc/x.gif')), `https://${SUB}.zendesk.com/attachments/token/b/`])
    expect(r.separateFiles.map(f => f.filename)).toEqual(['mynd-1-.._.._etc_x.gif', 'mynd-2-mynd'])
  })
})

describe('fetchTicketInfo — pasted images', () => {
  function tenant(brandId: string, pdf: Partial<PdfConfig> = {}): TenantConfig {
    return {
      brand_id: brandId,
      name: 'Prófunarstofnun',
      zendesk: { subdomain: SUB, webhookSecret: 'w', email: 'a@b.is', apiToken: 'tkn' },
      services: {
        archive: {
          endpoints: { onesystems: { type: 'onesystems', baseUrl: 'https://api.onesystems.test', appKey: 'k' } },
          malaskra: { apiKey: 'm' },
          pdf: { companyName: 'P', locale: 'is-IS', includeInternalNotes: false, includeSideConversations: false, ...pdf }
        }
      }
    }
  }

  function mockZendesk(brandId: string, extra: Record<string, unknown> = {}) {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === `${API}/tickets/42.json`) return json({ ticket: { id: 42, brand_id: brandId, subject: 'S', status: 'solved', created_at: 'x' } })
      if (url === `${API}/tickets/42/comments.json`) {
        return json({ comments: [
          { id: 1, author_id: 5, public: true, created_at: 'x', html_body: `<p>Sjá:</p><img src="${IMG('p', 'skjamynd.png')}"><img src="${IMG('g', 'logo.gif')}"><img src="${IMG('d', 'farin.png')}">` },
          { id: 2, author_id: 6, public: false, created_at: 'x', html_body: `<p>Innri</p><img src="${IMG('i', 'innri.png')}">` }
        ] })
      }
      if (url === `${API}/users/show_many.json?ids=5,6`) return json({ users: [] })
      if (url === IMG('p', 'skjamynd.png') || url === IMG('i', 'innri.png') || url === IMG('s', 'hlidar.png')) return file(png, 'image/png')
      if (url === IMG('g', 'logo.gif')) return file(gif, 'image/gif')
      if (url === IMG('d', 'farin.png')) return { ok: false, status: 404 }
      if (url in extra) return extra[url]
      throw new Error(`unexpected ${url}`)
    })
  }

  it('draws, sends separately and reports images, and never downloads images from hidden internal notes', async () => {
    mockZendesk('111')
    const result = await fetchTicketInfo(tenant('111'), 42)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { inlineImages, attachments, failedAttachments } = result.info
    expect(inlineImages.get(IMG('p', 'skjamynd.png'))?.kind).toBe('embed')
    expect(inlineImages.get(IMG('g', 'logo.gif'))?.kind).toBe('separate')
    expect(attachments.map(a => a.filename)).toEqual(['mynd-2-logo.gif'])
    expect(failedAttachments).toEqual([{ filename: 'mynd-3-farin.png', reason: 'mynd í texta: download status 404' }])
    expect(urls()).not.toContain(IMG('i', 'innri.png'))
  })

  it('includes images from internal notes when the tenant includes internal notes', async () => {
    mockZendesk('222')
    const result = await fetchTicketInfo(tenant('222', { includeInternalNotes: true }), 42)
    expect(result.ok && result.info.inlineImages.get(IMG('i', 'innri.png'))?.kind).toBe('embed')
  })

  it('includes images from side conversation messages when the tenant includes side conversations', async () => {
    mockZendesk('333', {
      [`${API}/tickets/42/side_conversations`]: json({ side_conversations: [{ id: 'sc1', subject: 'S', created_at: 'x' }], next_page: null }),
      [`${API}/tickets/42/side_conversations/sc1/events`]: json({ events: [
        { id: 'e1', type: 'create', created_at: 'x', message: { html_body: `<img src="${IMG('s', 'hlidar.png')}">` } }
      ], next_page: null })
    })
    const result = await fetchTicketInfo(tenant('333', { includeSideConversations: true }), 42)
    expect(result.ok && result.info.inlineImages.get(IMG('s', 'hlidar.png'))?.kind).toBe('embed')
  })
})

describe('generateTicketPdf — pasted images', () => {
  const ticket = { id: 42, subject: 'Test', status: 'solved', created_at: '2025-06-15T10:00:00Z' }
  const pdfConfig: PdfConfig = { companyName: 'C', locale: 'is-IS', includeInternalNotes: true, includeSideConversations: true }
  const text = (b: Buffer) => b.toString('latin1')
  const SRC = 'https://x.zendesk.com/a.png'
  const embedded: InlineImageMap = new Map([[SRC, { kind: 'embed', data: new Uint8Array(png), format: 'PNG', width: 4, height: 2 }]])
  const comment = (html: string, isPublic = true) => [{ id: 1, html_body: html, public: isPublic, author_id: 1, created_at: '2025-06-15T10:00:00Z' }]

  it('draws an embedded image in a comment', async () => {
    const pdf = text(await generateTicketPdf(ticket, comment(`<p>Sjá:</p><img src="${SRC}">`) as any, { pdfConfig, inlineImages: embedded }))
    expect(pdf).toContain('/Subtype /Image')
  })

  it('draws it in an internal note and in a side conversation message too', async () => {
    const threads = [{
      sideConversation: { id: 's', subject: 'S', created_at: '2025-06-15T10:00:00Z' },
      events: [{ id: 'e', type: 'create', created_at: '2025-06-15T10:00:00Z', message: { html_body: `<img src="${SRC}">` } }]
    }] as SideConversationThread[]
    const internal = text(await generateTicketPdf(ticket, comment(`<img src="${SRC}">`, false) as any, { pdfConfig, inlineImages: embedded }))
    const side = text(await generateTicketPdf(ticket, [], { pdfConfig, inlineImages: embedded, sideConversations: threads }))
    expect(internal).toContain('/Subtype /Image')
    expect(side).toContain('/Subtype /Image')
  })

  it('writes the placeholder for an image sent separately', async () => {
    const images: InlineImageMap = new Map([[SRC, { kind: 'separate', placeholder: '[Mynd: logo.gif – vistuð sem sérstakt skjal: mynd-1-logo.gif]' }]])
    const pdf = text(await generateTicketPdf(ticket, comment(`<img src="${SRC}">`) as any, { pdfConfig, inlineImages: images }))
    expect(pdf).toContain('mynd-1-logo.gif]')
    expect(pdf).not.toContain('/Subtype /Image')
  })

  it('writes a plain [Mynd] placeholder for an image with no decision', async () => {
    const pdf = text(await generateTicketPdf(ticket, comment(`<img src="${SRC}">`) as any, { pdfConfig }))
    expect(pdf).toContain('[Mynd]')
  })

  it('scales a very tall image to fit one page without failing', async () => {
    const tall: InlineImageMap = new Map([[SRC, { kind: 'embed', data: new Uint8Array(png), format: 'PNG', width: 400, height: 20000 }]])
    const pdf = await generateTicketPdf(ticket, comment(`<p>a</p><img src="${SRC}"><p>b</p>`) as any, { pdfConfig, inlineImages: tall })
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
  })
})
