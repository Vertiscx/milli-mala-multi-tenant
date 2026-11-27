/**
 * Images pasted into comments and side conversation messages.
 *
 * Every <img> in the HTML that goes into the PDF is resolved BEFORE the PDF
 * is drawn, so each one gets exactly one outcome and its placeholder can
 * say what happened:
 *
 *  1. PNG or JPEG that jsPDF can read          → drawn in the PDF (embed)
 *  2. Downloaded, but not drawable (GIF, WebP,
 *     HEIC, damaged, or over maxEmbedBytes)     → placeholder in the PDF,
 *                                                 file sent to the archive
 *                                                 as mynd-<n>-<name>
 *  3. No file (download refused or failed, a
 *     cid: or other unsupported source, or a
 *     limit reached)                            → placeholder in the PDF,
 *                                                 listed in the result note
 *
 * Downloads go through ZendeskClient.downloadFile, so the same host check
 * (HTTPS on zendesk.com / zdassets.com only) and sign-in rules apply as for
 * attachments. Files sent separately share the attachment limits (50 files,
 * 100 MB per request) with the ticket's own attachments.
 */

import { jsPDF } from 'jspdf'
import { parseHtmlToBlocks } from './pdf.js'
import { createLogger } from '../../platform/logger.js'
import type { ZendeskClient } from '../../platform/zendesk.js'
import type { DownloadedAttachment, Logger } from '../../platform/types.js'
import type { InlineImage, InlineImageMap } from './types.js'

const logger: Logger = createLogger('inlineImages')

export interface InlineImageLimits {
  /** Images resolved per request; the rest become placeholders. */
  maxImages: number
  /** Image bytes downloaded per request. */
  maxTotalBytes: number
  /** A larger PNG/JPEG is sent as a separate file instead of drawn. */
  maxEmbedBytes: number
  /** Shared with the ticket's attachments (fetchAttachments' defaults). */
  maxArchiveFiles: number
  maxArchiveBytes: number
}

export const INLINE_IMAGE_LIMITS: InlineImageLimits = {
  maxImages: 50,
  maxTotalBytes: 50 * 1024 * 1024,
  maxEmbedBytes: 10 * 1024 * 1024,
  maxArchiveFiles: 50,
  maxArchiveBytes: 100 * 1024 * 1024
}

export interface InlineImagesResult {
  images: InlineImageMap
  /** Case 2: to be sent to the archive with the ticket's attachments. */
  separateFiles: DownloadedAttachment[]
  /** Case 3: for the result note and audit, like failed attachments. */
  failed: { filename: string; reason: string }[]
}

/** Every distinct <img> src in the given HTML bodies, in order of appearance. */
export function collectImageSources(htmlBodies: string[]): string[] {
  const sources = new Set<string>()
  for (const html of htmlBodies) {
    for (const block of parseHtmlToBlocks(html)) {
      if (block.type === 'image' && block.src) sources.add(block.src)
    }
  }
  return [...sources]
}

/** PNG or JPEG by the file's first bytes; anything else is null. */
export function detectImageFormat(data: Uint8Array): 'PNG' | 'JPEG' | null {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 &&
      data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) return 'PNG'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'JPEG'
  return null
}

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/heic': 'heic', 'image/heif': 'heif', 'image/bmp': 'bmp', 'image/tiff': 'tif', 'image/svg+xml': 'svg'
}

/** Keep a name safe as an archive filename: no path parts or control characters. */
function safeName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim()
  return (cleaned.length > 100 ? cleaned.slice(-100) : cleaned) || 'mynd'
}

/** The name shown in the placeholder: Zendesk's ?name=, else the URL's file name, else 'mynd'. */
function imageLabel(src: string, mime?: string): string {
  if (src.startsWith('data:')) {
    const ext = mime ? EXTENSIONS[mime] : undefined
    return ext ? `mynd.${ext}` : 'mynd'
  }
  try {
    const url = new URL(src)
    const name = url.searchParams.get('name')
    if (name) return safeName(name)
    const last = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '')
    if (last.includes('.')) return safeName(last)
  } catch { /* not a URL (cid:, relative path): fall through */ }
  return 'mynd'
}

/** Decode a base64 data: URI image. Non-image or non-base64 data URIs are unsupported. */
function decodeDataUri(src: string): { data: Buffer; contentType: string } | null {
  const match = /^data:(image\/[\w.+-]+)((?:;[\w-]+=[\w.-]+)*);base64,([\s\S]*)$/i.exec(src)
  if (!match) return null
  const data = Buffer.from(match[3].replace(/\s+/g, ''), 'base64')
  return data.length > 0 ? { data, contentType: match[1].toLowerCase() } : null
}

const FAILED_PLACEHOLDER_REASONS: Record<string, string> = {
  'image count limit reached': 'ekki vistuð, hámarki mynda náð',
  'total size limit reached': 'ekki vistuð, hámarksstærð náð',
  'file count limit reached': 'ekki vistuð, hámarki skjala náð'
}

export async function prepareInlineImages(
  zendesk: ZendeskClient,
  sources: string[],
  attachments: DownloadedAttachment[],
  brandId: string,
  limits: InlineImageLimits = INLINE_IMAGE_LIMITS
): Promise<InlineImagesResult> {
  const images: InlineImageMap = new Map()
  const separateFiles: DownloadedAttachment[] = []
  const failed: { filename: string; reason: string }[] = []
  let downloadedBytes = 0
  let archiveBytes = attachments.reduce((sum, a) => sum + a.data.length, 0)
  // One throwaway document to check that jsPDF can read an image.
  let probe: jsPDF | undefined

  const fail = (src: string, label: string, archiveName: string, reason: string): void => {
    const why = FAILED_PLACEHOLDER_REASONS[reason] ?? 'tókst ekki að sækja'
    images.set(src, { kind: 'failed', placeholder: `[Mynd: ${label} – ${why}]` })
    failed.push({ filename: archiveName, reason: `mynd í texta: ${reason}` })
  }

  for (let i = 0; i < sources.length; i++) {
    const src = sources[i]
    const n = i + 1
    let label = imageLabel(src)
    let archiveName = `mynd-${n}-${label}`

    if (n > limits.maxImages) {
      fail(src, label, archiveName, 'image count limit reached')
      continue
    }

    // 1. Get the bytes
    let data: Buffer
    let contentType: string
    if (src.startsWith('data:')) {
      const decoded = decodeDataUri(src)
      if (!decoded) {
        fail(src, label, archiveName, 'unsupported image source')
        continue
      }
      ;({ data, contentType } = decoded)
      label = imageLabel(src, contentType)
      archiveName = `mynd-${n}-${label}`
    } else if (/^https?:/i.test(src)) {
      const download = await zendesk.downloadFile(src)
      if (!download.ok) {
        logger.warn('Inline image not downloaded', { brand_id: brandId, image: n, reason: download.reason })
        fail(src, label, archiveName, download.reason)
        continue
      }
      data = download.data
      contentType = download.contentType.split(';')[0].trim().toLowerCase()
    } else {
      // cid: (an email part Zendesk did not resolve) or a relative path
      fail(src, label, archiveName, 'unsupported image source')
      continue
    }

    if (downloadedBytes + data.length > limits.maxTotalBytes) {
      logger.warn('Inline image total size limit reached', { brand_id: brandId, image: n })
      fail(src, label, archiveName, 'total size limit reached')
      continue
    }
    downloadedBytes += data.length

    // 2. Draw it if jsPDF can
    const format = detectImageFormat(data)
    if (format && data.length <= limits.maxEmbedBytes) {
      try {
        probe ??= new jsPDF()
        const props = probe.getImageProperties(new Uint8Array(data))
        if (props.width > 0 && props.height > 0) {
          images.set(src, { kind: 'embed', data: new Uint8Array(data), format, width: props.width, height: props.height })
          continue
        }
      } catch { /* damaged image: send it separately below */ }
    }

    // 3. Otherwise send the file separately, if it fits the shared limits
    if (attachments.length + separateFiles.length >= limits.maxArchiveFiles) {
      fail(src, label, archiveName, 'file count limit reached')
      continue
    }
    if (archiveBytes + data.length > limits.maxArchiveBytes) {
      fail(src, label, archiveName, 'total size limit reached')
      continue
    }
    archiveBytes += data.length
    separateFiles.push({
      filename: archiveName,
      contentType: contentType || 'application/octet-stream',
      size: data.length,
      data
    })
    const image: InlineImage = {
      kind: 'separate',
      placeholder: `[Mynd: ${label} – vistuð sem sérstakt skjal: ${archiveName}]`
    }
    images.set(src, image)
  }

  return { images, separateFiles, failed }
}
