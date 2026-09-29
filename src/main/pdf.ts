import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Renders a self-contained HTML document (fonts inlined) to PDF with Chromium's print engine,
 * which produces selectable, parser-friendly text. Scripts are disabled in the render window.
 */
export async function renderPdf(html: string, pageSize: 'Letter' | 'A4'): Promise<Uint8Array> {
  const file = join(tmpdir(), `openapplyr-${randomUUID()}.html`)
  await writeFile(file, html, 'utf8')
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
  })
  try {
    await win.loadFile(file)
    const pdf = await win.webContents.printToPDF({
      pageSize,
      printBackground: true,
      preferCSSPageSize: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    })
    return new Uint8Array(pdf)
  } finally {
    win.destroy()
    await rm(file, { force: true })
  }
}
