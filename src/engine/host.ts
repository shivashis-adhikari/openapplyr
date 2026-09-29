import type { EngineToMain, HostMethod, HostRequestMap, MainToEngine } from '../shared/host'

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

/** Engine-side client for things only the main process can do (PDF, notifications, power, dock badge). */
export interface HostClient {
  request<M extends HostMethod>(method: M, params: HostRequestMap[M]['params']): Promise<HostRequestMap[M]['result']>
}

export class ParentPortHost implements HostClient {
  private seq = 0
  private readonly pending = new Map<number, Pending>()

  constructor(private readonly post: (msg: EngineToMain) => void) {}

  handleReply(msg: Extract<MainToEngine, { type: 'reply' }>): void {
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    if (msg.ok) p.resolve(msg.value)
    else p.reject(new Error(msg.error))
  }

  request<M extends HostMethod>(method: M, params: HostRequestMap[M]['params']): Promise<HostRequestMap[M]['result']> {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.post({ type: 'request', id, method, params })
    })
  }
}

/** Used in tests and headless runs: renders nothing, notifies nobody. */
export const nullHost: HostClient = {
  async request(method) {
    if (method === 'pdf') throw new Error('PDF rendering needs the desktop app.')
    return null as never
  },
}
