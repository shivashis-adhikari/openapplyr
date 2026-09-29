import {
  type MenuItemConstructorOptions,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  app,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  net,
  powerMonitor,
  powerSaveBlocker,
  protocol,
  screen,
  session,
  shell,
} from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { HostMethod, HostRequestMap } from '../shared/host'
import { REPO_URL } from '../shared/project'
import { type DataKeyState, keyFromPassphrase, loadDataKey, passphraseKeyMatches } from './data-key'
import { EngineHost } from './engine-host'
import { renderPdf } from './pdf'
import { APP_ORIGIN, csp, hardenSession, installGlobalHardening, isSafeExternalUrl, isTrustedUrl } from './security'

const here = dirname(fileURLToPath(import.meta.url))
const devServerUrl = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined
// The sample workspace (fictional data, nothing sent) lives in its own folder next to the real one.
const sample = process.argv.includes('--sample')
const demo = process.env['OPENAPPLYR_DEMO'] === '1' || sample

if (process.env['OPENAPPLYR_DATA_DIR']) app.setPath('userData', process.env['OPENAPPLYR_DATA_DIR'])
if (sample) app.setPath('userData', join(app.getPath('userData'), 'sample-workspace'))
const dataDir = app.getPath('userData')
mkdirSync(dataDir, { recursive: true })

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
])

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let engine: EngineHost | null = null
let keyState: DataKeyState | null = null
let quitting = false
let powerBlockId: number | null = null
const appSettings = { backgroundMode: true, launchAtLogin: false, theme: 'system' as 'system' | 'light' | 'dark' }

installGlobalHardening(devServerUrl)

// ---------------------------------------------------------------------------
// Window

type WindowState = { width: number; height: number; x?: number; y?: number; maximized?: boolean }
const stateFile = join(dataDir, 'window.json')

// Every screen passes the layout check down to this size (tests/e2e/app.spec.ts).
const MIN = { width: 800, height: 560 }

function readWindowState(): WindowState | null {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8')) as WindowState
  } catch {
    return null // first run
  }
}

/**
 * Where the window opens: the saved size and place if they still fit a connected display, otherwise
 * centred on the main display at a size that fits its work area (small laptops at 125% or 150% scaling
 * have as little as 1090x570 to spare). Minimums never exceed the display either.
 */
function windowBounds(saved: WindowState | null) {
  const display = saved?.x !== undefined && saved.y !== undefined ? screen.getDisplayMatching({ x: saved.x, y: saved.y, width: saved.width, height: saved.height }) : screen.getPrimaryDisplay()
  const area = display.workArea
  const minWidth = Math.min(MIN.width, area.width)
  const minHeight = Math.min(MIN.height, area.height)
  const width = Math.max(minWidth, Math.min(saved?.width ?? Math.round(area.width * 0.9), area.width, saved ? Infinity : 1320))
  const height = Math.max(minHeight, Math.min(saved?.height ?? Math.round(area.height * 0.9), area.height, saved ? Infinity : 860))
  const visible = saved?.x !== undefined && saved.y !== undefined && saved.x >= area.x && saved.y >= area.y && saved.x + width <= area.x + area.width && saved.y + height <= area.y + area.height
  return { width, height, minWidth, minHeight, ...(visible ? { x: saved!.x, y: saved!.y } : {}) }
}

function saveWindowState(win: BrowserWindow): void {
  const b = win.getNormalBounds()
  writeFileSync(stateFile, JSON.stringify({ ...b, maximized: win.isMaximized() }))
}

function createWindow(): BrowserWindow {
  const s = readWindowState()
  const win = new BrowserWindow({
    ...windowBounds(s),
    show: false,
    title: 'OpenApplyr',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#101714' : '#F6F4EE',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
    },
  })
  if (s?.maximized) win.maximize()
  win.once('ready-to-show', () => {
    if (!process.env['OPENAPPLYR_HIDDEN']) win.show()
  })
  win.on('close', (e) => {
    saveWindowState(win)
    if (quitting) return
    // macOS keeps apps open without windows; elsewhere background mode keeps the tray running.
    if (process.platform === 'darwin' || appSettings.backgroundMode) {
      e.preventDefault()
      win.hide()
    }
  })
  void win.loadURL(devServerUrl ?? `${APP_ORIGIN}/index.html`)
  return win
}

function showWindow(route?: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  if (route) mainWindow.webContents.send('navigate', route)
}

// ---------------------------------------------------------------------------
// Engine

async function handleEngineRequest(method: HostMethod, params: unknown): Promise<unknown> {
  switch (method) {
    case 'pdf': {
      const p = params as HostRequestMap['pdf']['params']
      return renderPdf(p.html, p.pageSize)
    }
    case 'notify': {
      const p = params as HostRequestMap['notify']['params']
      if (!Notification.isSupported()) return null
      const n = new Notification({ title: p.title, body: p.body, silent: p.silent ?? false })
      n.on('click', () => showWindow(p.route))
      n.show()
      return null
    }
    case 'power': {
      const p = params as HostRequestMap['power']['params']
      if (p.block && powerBlockId === null) powerBlockId = powerSaveBlocker.start('prevent-app-suspension')
      if (!p.block && powerBlockId !== null) {
        powerSaveBlocker.stop(powerBlockId)
        powerBlockId = null
      }
      return null
    }
    case 'reveal': {
      const p = params as HostRequestMap['reveal']['params']
      shell.showItemInFolder(p.path)
      return null
    }
    case 'badge': {
      const p = params as HostRequestMap['badge']['params']
      app.setBadgeCount(p.count)
      tray?.setToolTip(p.count > 0 ? `OpenApplyr: ${p.count} need you` : 'OpenApplyr')
      return null
    }
    case 'appSettings': {
      const p = params as HostRequestMap['appSettings']['params']
      Object.assign(appSettings, p)
      nativeTheme.themeSource = p.theme
      if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: p.launchAtLogin })
      return null
    }
    case 'openExternal': {
      const p = params as HostRequestMap['openExternal']['params']
      if (!isSafeExternalUrl(p.url)) throw new Error('Refused to open a non-web link.')
      await shell.openExternal(p.url)
      return null
    }
  }
}

function startEngine(key: Buffer): void {
  engine = new EngineHost(
    join(here, 'engine.js'),
    {
      dataDir,
      dataKey: key.toString('base64'),
      appVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      resourcesPath: app.isPackaged ? process.resourcesPath : join(here, '../..'),
      platform: process.platform,
      demo,
    },
    handleEngineRequest,
    (message) => {
      dialog.showErrorBox('OpenApplyr stopped working', message)
    },
  )
  engine.start()
  for (const wc of portWanted) if (!wc.isDestroyed()) engine.attach(wc)
  portWanted.clear()
}

// ---------------------------------------------------------------------------
// Renderer -> main (things only the main process can do)

function trusted(e: { senderFrame: Electron.WebFrameMain | null }): boolean {
  return !!e.senderFrame && isTrustedUrl(e.senderFrame.url, devServerUrl)
}

// Pages that asked for an engine port before the engine started (it waits for the unlock screen).
const portWanted = new Set<Electron.WebContents>()

function registerIpc(): void {
  // Every page load asks for its own port, so reloads and renderer recovery reconnect too.
  ipcMain.on('engine-port-request', (e) => {
    if (!trusted(e)) return
    if (engine) engine.attach(e.sender)
    else portWanted.add(e.sender)
  })
  const handle = (channel: string, fn: (e: Electron.IpcMainInvokeEvent, arg: never) => unknown) =>
    ipcMain.handle(channel, (e, arg) => {
      if (!trusted(e)) throw new Error('Untrusted sender')
      return fn(e, arg as never)
    })

  handle('host:key-state', () => (keyState?.kind === 'ready' ? { kind: 'ready' } : keyState))
  handle('host:open-sample', (_e, on: boolean) => {
    app.relaunch({ args: [...process.argv.slice(1).filter((a) => a !== '--sample'), ...(on ? ['--sample'] : [])] })
    app.exit(0)
  })
  handle('host:unlock', (_e, passphrase: string) => {
    if (typeof passphrase !== 'string' || passphrase.length < 8) throw new Error('Use at least 8 characters.')
    const key = keyFromPassphrase(dataDir, passphrase)
    if (!passphraseKeyMatches(dataDir, key)) return false
    keyState = { kind: 'ready', key }
    startEngine(key)
    return true
  })
  handle('host:pick-file', async (_e, opts: { title?: string; extensions?: string[]; multiple?: boolean }) => {
    const r = await dialog.showOpenDialog(mainWindow!, {
      title: opts?.title,
      properties: opts?.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: opts?.extensions?.length ? [{ name: 'Files', extensions: opts.extensions }] : [],
    })
    return r.canceled ? [] : r.filePaths
  })
  handle('host:save-file', async (_e, opts: { defaultPath?: string; extensions?: string[] }) => {
    const r = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: opts?.defaultPath,
      filters: opts?.extensions?.length ? [{ name: 'Files', extensions: opts.extensions }] : [],
    })
    return r.canceled ? null : (r.filePath ?? null)
  })
  handle('host:reveal', (_e, path: string) => {
    if (typeof path === 'string' && existsSync(path)) shell.showItemInFolder(path)
  })
  handle('host:open-external', async (_e, url: string) => {
    if (!isSafeExternalUrl(url)) throw new Error('Refused to open a non-web link.')
    await shell.openExternal(url)
  })
  handle('host:set-theme', (_e, mode: 'system' | 'light' | 'dark') => {
    if (mode === 'system' || mode === 'light' || mode === 'dark') nativeTheme.themeSource = mode
  })
}

// ---------------------------------------------------------------------------
// Tray and menu

function createTray(): void {
  // macOS menu bar icons are monochrome templates the system tints; Windows and Linux get the colored mark.
  const iconPath = join(app.isPackaged ? process.resourcesPath : join(here, '../../build'), process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png')
  if (!existsSync(iconPath)) return
  const image = nativeImage.createFromPath(iconPath)
  if (process.platform === 'darwin') image.setTemplateImage(true)
  tray = new Tray(image)
  tray.setToolTip('OpenApplyr')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open OpenApplyr', click: () => showWindow() },
      { label: 'Today', click: () => showWindow('/today') },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  )
  tray.on('click', () => showWindow())
}

function createMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { label: 'Settings…', accelerator: 'Cmd+,', click: () => showWindow('/settings') },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'Import job from URL…', accelerator: 'CmdOrCtrl+I', click: () => showWindow('/jobs?import=1') },
        ...(isMac ? [] : [{ label: 'Settings', accelerator: 'Ctrl+,', click: () => showWindow('/settings') }]),
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ] as MenuItemConstructorOptions[],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        ...(devServerUrl ? [{ role: 'reload' }, { role: 'toggleDevTools' }] : []),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ] as MenuItemConstructorOptions[],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Documentation', click: () => void shell.openExternal(`${REPO_URL}#readme`) },
        { label: 'Report a problem', click: () => void shell.openExternal(`${REPO_URL}/issues/new/choose`) },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---------------------------------------------------------------------------
// Lifecycle

app.on('second-instance', () => showWindow())

app.whenReady().then(() => {
  const root = normalize(join(here, '../renderer'))
  protocol.handle('app', async (req) => {
    const url = new URL(req.url)
    let rel = decodeURIComponent(url.pathname)
    if (rel === '/' || rel === '') rel = '/index.html'
    const file = normalize(join(root, rel))
    if (!file.startsWith(root + sep)) return new Response('Not found', { status: 404 })
    const res = await net.fetch(pathToFileURL(file).toString())
    const headers = new Headers(res.headers)
    headers.set('Content-Security-Policy', csp())
    headers.set('X-Content-Type-Options', 'nosniff')
    return new Response(res.body, { status: res.status, headers })
  })

  hardenSession(session.defaultSession, devServerUrl)
  registerIpc()
  createMenu()

  try {
    keyState = loadDataKey(dataDir)
  } catch (err) {
    dialog.showErrorBox('OpenApplyr cannot read its encryption key', err instanceof Error ? err.message : String(err))
    app.exit(1)
    return
  }
  if (keyState.kind === 'ready') startEngine(keyState.key)
  mainWindow = createWindow()
  createTray()

  powerMonitor.on('suspend', () => engine?.send({ type: 'power-event', event: 'suspend' }))
  powerMonitor.on('resume', () => engine?.send({ type: 'power-event', event: 'resume' }))
  app.on('activate', () => showWindow())
})

app.on('before-quit', (e) => {
  if (quitting) return
  quitting = true
  if (!engine) return
  e.preventDefault()
  void engine.stop().finally(() => app.exit(0))
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !appSettings.backgroundMode) app.quit()
})
