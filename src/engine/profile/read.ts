import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import mammoth from 'mammoth'
import { extractText, getDocumentProxy } from 'unpdf'
import { AppError } from '../core/errors'

export type DocKind = 'pdf' | 'docx' | 'text' | 'json' | 'zip'

const MAX_BYTES = 30 * 1024 * 1024

export function kindOf(path: string): DocKind {
  const ext = extname(path).toLowerCase()
  if (ext === '.pdf') return 'pdf'
  if (ext === '.docx') return 'docx'
  if (ext === '.json') return 'json'
  if (ext === '.zip') return 'zip'
  if (ext === '.txt' || ext === '.md' || ext === '.markdown' || ext === '.text') return 'text'
  if (ext === '.doc') throw new AppError('OLD_WORD', 'Old .doc files cannot be read. Save it as .docx or PDF and import that.', { permanent: true })
  throw new AppError('UNSUPPORTED', `OpenApplyr cannot read ${ext || 'this'} files. Use PDF, DOCX, TXT, JSON Resume or a LinkedIn export ZIP.`, { permanent: true })
}

export async function readBytes(path: string): Promise<Buffer> {
  const s = await stat(path).catch(() => null)
  if (!s?.isFile()) throw new AppError('NOT_FOUND', 'That file no longer exists.', { permanent: true })
  if (s.size > MAX_BYTES) throw new AppError('TOO_LARGE', 'That file is over 30 MB. Export a smaller copy.', { permanent: true })
  return readFile(path)
}

export async function pdfText(buf: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(buf))
  const { text } = await extractText(pdf, { mergePages: true })
  return (Array.isArray(text) ? text.join('\n') : text).replace(/\u0000/g, '')
}

/** Plain text from a PDF, DOCX or text file. Scanned PDFs (images only) are reported, not silently empty. */
export async function documentText(path: string): Promise<string> {
  const kind = kindOf(path)
  const buf = await readBytes(path)
  let text: string
  if (kind === 'pdf') text = await pdfText(buf)
  else if (kind === 'docx') text = (await mammoth.extractRawText({ buffer: buf })).value
  else text = buf.toString('utf8')
  text = text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim()
  if (kind === 'pdf' && text.replace(/\s/g, '').length < 80) {
    throw new AppError('SCANNED_PDF', 'This PDF has no selectable text (it is probably a scan). Export the resume as a text-based PDF or DOCX.', { permanent: true })
  }
  return text
}
