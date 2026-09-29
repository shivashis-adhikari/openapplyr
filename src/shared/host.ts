/** Messages between the Electron main process and the engine utility process. */

export type Platform = 'darwin' | 'win32' | 'linux' | (string & {})

export type HostInit = {
  type: 'init'
  dataDir: string
  dataKey: string // base64, 32 bytes
  appVersion: string
  isPackaged: boolean
  resourcesPath: string
  platform: Platform
  demo: boolean
}

export type HostRequestMap = {
  pdf: { params: { html: string; pageSize: 'Letter' | 'A4' }; result: Uint8Array }
  notify: { params: { title: string; body: string; route?: string; silent?: boolean }; result: null }
  power: { params: { block: boolean }; result: null }
  reveal: { params: { path: string }; result: null }
  badge: { params: { count: number }; result: null }
  appSettings: { params: { backgroundMode: boolean; launchAtLogin: boolean; theme: 'system' | 'light' | 'dark' }; result: null }
  openExternal: { params: { url: string }; result: null }
}
export type HostMethod = keyof HostRequestMap

export type MainToEngine =
  | HostInit
  | { type: 'renderer-port' }
  | { type: 'reply'; id: number; ok: true; value: unknown }
  | { type: 'reply'; id: number; ok: false; error: string }
  | { type: 'shutdown' }
  | { type: 'power-event'; event: 'suspend' | 'resume' }

export type EngineToMain =
  | { type: 'ready' }
  | { type: 'shutdown-complete' }
  | { type: 'request'; id: number; method: HostMethod; params: unknown }
  | { type: 'fatal'; message: string }

/** Messages over the renderer <-> engine MessagePort. */
export type RendererToEngine = { type: 'call'; id: number; name: string; input: unknown }
export type EngineToRenderer =
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: WireError }
  | { type: 'event'; topic: string; data?: unknown }

export type WireError = { code: string; message: string; detail?: string }
