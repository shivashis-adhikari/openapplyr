import type { Platform, WireError } from './host'

/** The only API the renderer can reach. Exposed by the preload as `window.openapplyr`. */
export type Bridge = {
  call(name: string, input: unknown): Promise<unknown>
  subscribe(topic: string, listener: (data: unknown) => void): () => void
  onConnection(listener: (connected: boolean) => void): () => void
  host: {
    platform: Platform
    keyState(): Promise<{ kind: 'ready' } | { kind: 'needs-passphrase'; firstRun: boolean } | null>
    unlock(passphrase: string): Promise<boolean>
    pickFile(opts: { title?: string; extensions?: string[]; multiple?: boolean }): Promise<string[]>
    saveFile(opts: { defaultPath?: string; extensions?: string[] }): Promise<string | null>
    reveal(path: string): Promise<void>
    openExternal(url: string): Promise<void>
    setTheme(mode: 'system' | 'light' | 'dark'): Promise<void>
    /** Relaunches into (or out of) the sample workspace. */
    openSample(on: boolean): Promise<void>
    pathForFile(file: File): string
    onNavigate(listener: (route: string) => void): () => void
  }
}

export class EngineError extends Error {
  readonly code: string
  readonly detail: string | undefined
  constructor(e: WireError) {
    super(e.message)
    this.name = 'EngineError'
    this.code = e.code
    this.detail = e.detail
  }
}
