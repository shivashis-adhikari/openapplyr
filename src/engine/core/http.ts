import { setTimeout as sleep } from 'node:timers/promises'
import { AppError } from './errors'
import { REPO_URL } from '../../shared/project'

export type HttpRequest = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
  headers?: Record<string, string>
  body?: string | Uint8Array
  json?: unknown
  timeoutMs?: number
  maxBytes?: number
  retries?: number
  signal?: AbortSignal
  /** Browser-like headers for plain HTML pages; API calls identify as OpenApplyr. */
  as?: 'api' | 'page'
}

export type HttpResponse = {
  status: number
  url: string
  headers: Headers
  text: string
  json<T = unknown>(): T
}

export class HttpError extends AppError {
  constructor(
    readonly status: number,
    readonly url: string,
    message: string,
  ) {
    super(`HTTP_${status}`, message, { permanent: status >= 400 && status < 500 && status !== 408 && status !== 429 })
  }
}

class Semaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []
  constructor(private readonly limit: number) {}
  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.waiters.push(r))
    this.active++
    return () => {
      this.active--
      this.waiters.shift()?.()
    }
  }
}

/**
 * fetch with timeouts, size caps, per-host concurrency, a global request rate, and retries that honor
 * Retry-After. Every network call from the engine goes through one instance so politeness limits hold.
 */
export class Http {
  private readonly hosts = new Map<string, Semaphore>()
  private nextSlot = 0
  private readonly userAgent: string

  constructor(
    appVersion: string,
    private rps = 3,
    private readonly perHost = 2,
  ) {
    this.userAgent = `OpenApplyr/${appVersion} (+${REPO_URL})`
  }

  setRate(rps: number): void {
    this.rps = Math.max(0.2, rps)
  }

  private async rateLimit(): Promise<void> {
    const gap = 1000 / this.rps
    const now = Date.now()
    const slot = Math.max(now, this.nextSlot)
    this.nextSlot = slot + gap
    if (slot > now) await sleep(slot - now)
  }

  async request(url: string, req: HttpRequest = {}): Promise<HttpResponse> {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new AppError('BAD_URL', `Not a web address: ${url}`, { permanent: true })
    let sem = this.hosts.get(u.host)
    if (!sem) this.hosts.set(u.host, (sem = new Semaphore(this.perHost)))
    const retries = req.retries ?? 2
    for (let attempt = 0; ; attempt++) {
      const release = await sem.acquire()
      let res: HttpResponse
      try {
        await this.rateLimit()
        res = await this.once(u, req)
      } catch (err) {
        release()
        const retriable = !(err instanceof AppError && err.permanent) && !(req.signal?.aborted ?? false)
        if (!retriable || attempt >= retries) throw err
        await sleep(800 * 2 ** attempt)
        continue
      }
      release()
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= retries) throw new HttpError(res.status, url, `${u.host} returned ${res.status}.`)
        const retryAfter = Number(res.headers.get('retry-after'))
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : 800 * 2 ** attempt)
        continue
      }
      return res
    }
  }

  private async once(u: URL, req: HttpRequest): Promise<HttpResponse> {
    const headers: Record<string, string> = {
      'Accept-Language': 'en-US,en;q=0.9',
      ...(req.as === 'page'
        ? { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' }
        : { 'User-Agent': this.userAgent, Accept: 'application/json, text/plain, */*' }),
      ...(req.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...req.headers,
    }
    const timeout = AbortSignal.timeout(req.timeoutMs ?? 30_000)
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout
    let res: Response
    try {
      res = await fetch(u, {
        method: req.method ?? (req.json !== undefined || req.body ? 'POST' : 'GET'),
        headers,
        body: req.json !== undefined ? JSON.stringify(req.json) : req.body,
        signal,
        redirect: 'follow',
      })
    } catch (err) {
      if (timeout.aborted) throw new AppError('TIMEOUT', `${u.host} did not answer within ${Math.round((req.timeoutMs ?? 30_000) / 1000)} seconds.`)
      throw new AppError('NETWORK', `Could not reach ${u.host}.`, { detail: err instanceof Error ? err.message : String(err), cause: err })
    }
    const text = await readCapped(res, req.maxBytes ?? 25 * 1024 * 1024, u.host)
    return {
      status: res.status,
      url: res.url || u.toString(),
      headers: res.headers,
      text,
      json<T>() {
        try {
          return JSON.parse(text) as T
        } catch {
          throw new AppError('BAD_JSON', `${u.host} returned something that is not JSON.`, { detail: text.slice(0, 300) })
        }
      },
    }
  }

  async getJson<T>(url: string, req: HttpRequest = {}): Promise<T> {
    const res = await this.request(url, req)
    if (res.status >= 400) throw new HttpError(res.status, url, `${new URL(url).host} returned ${res.status}.`)
    return res.json<T>()
  }

  async getText(url: string, req: HttpRequest = {}): Promise<HttpResponse> {
    const res = await this.request(url, req)
    if (res.status >= 400) throw new HttpError(res.status, url, `${new URL(url).host} returned ${res.status}.`)
    return res
  }
}

async function readCapped(res: Response, maxBytes: number, host: string): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new AppError('TOO_LARGE', `${host} sent more than ${Math.round(maxBytes / 1024 / 1024)} MB; stopped reading.`, { permanent: true })
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}
