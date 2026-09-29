import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Bridge } from '../shared/bridge'
import type { EngineToRenderer, RendererToEngine, WireError } from '../shared/host'

type Pending = { resolve: (v: unknown) => void; reject: (e: WireError) => void }

let port: MessagePort | null = null
let seq = 0
const pending = new Map<number, Pending>()
const queued: RendererToEngine[] = []
const topicListeners = new Map<string, Set<(data: unknown) => void>>()
const connectionListeners = new Set<(connected: boolean) => void>()

function onMessage(ev: MessageEvent<EngineToRenderer>): void {
  const msg = ev.data
  if (msg.type === 'result') {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.ok) p.resolve(msg.value)
    else p.reject(msg.error)
    return
  }
  for (const key of [msg.topic, '*']) {
    for (const fn of topicListeners.get(key) ?? []) {
      try {
        fn(key === '*' ? { topic: msg.topic, data: msg.data } : msg.data)
      } catch (err) {
        console.error(err)
      }
    }
  }
}

ipcRenderer.on('engine-port', (event) => {
  const next = event.ports[0]
  if (!next) return
  if (port) {
    // The engine restarted: calls in flight on the old port will never be answered.
    for (const [id, p] of pending) {
      p.reject({ code: 'ENGINE_RESTARTED', message: 'The engine restarted while this was running. Try again.' })
      pending.delete(id)
    }
    port.close()
  }
  port = next
  port.onmessage = onMessage
  port.start()
  for (const msg of queued.splice(0)) port.postMessage(msg)
  for (const fn of connectionListeners) fn(true)
})

ipcRenderer.send('engine-port-request')

const bridge: Bridge = {
  call(name, input) {
    return new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      const msg: RendererToEngine = { type: 'call', id, name, input }
      if (port) port.postMessage(msg)
      else queued.push(msg)
    })
  },
  subscribe(topic, listener) {
    let set = topicListeners.get(topic)
    if (!set) topicListeners.set(topic, (set = new Set()))
    set.add(listener)
    return () => set.delete(listener)
  },
  onConnection(listener) {
    connectionListeners.add(listener)
    if (port) listener(true)
    return () => connectionListeners.delete(listener)
  },
  host: {
    platform: process.platform,
    keyState: () => ipcRenderer.invoke('host:key-state'),
    unlock: (passphrase) => ipcRenderer.invoke('host:unlock', passphrase),
    pickFile: (opts) => ipcRenderer.invoke('host:pick-file', opts),
    saveFile: (opts) => ipcRenderer.invoke('host:save-file', opts),
    reveal: (path) => ipcRenderer.invoke('host:reveal', path),
    openExternal: (url) => ipcRenderer.invoke('host:open-external', url),
    setTheme: (mode) => ipcRenderer.invoke('host:set-theme', mode),
    openSample: (on) => ipcRenderer.invoke('host:open-sample', on),
    pathForFile: (file) => webUtils.getPathForFile(file),
    onNavigate(listener) {
      const fn = (_e: unknown, route: string) => listener(route)
      ipcRenderer.on('navigate', fn)
      return () => ipcRenderer.off('navigate', fn)
    },
  },
}

contextBridge.exposeInMainWorld('openapplyr', bridge)
