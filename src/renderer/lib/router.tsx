import { type ReactNode, useCallback, useSyncExternalStore } from 'react'

/**
 * Hash routes: "#/jobs?job=12&view=matches". The path picks the screen; parameters hold the selection,
 * so every item has an address (notifications and the palette link straight to it).
 */
export type Route = { path: string; params: URLSearchParams }

const parse = (hash: string): Route => {
  const raw = hash.replace(/^#/, '') || '/today'
  const [path = '/today', query = ''] = raw.split('?')
  return { path: path || '/today', params: new URLSearchParams(query) }
}

const subscribe = (l: () => void) => {
  window.addEventListener('hashchange', l)
  return () => window.removeEventListener('hashchange', l)
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash)
  return parse(hash)
}

export function href(path: string, params: Record<string, string | number | null | undefined> = {}): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') q.set(k, String(v))
  const qs = q.toString()
  return `#${path}${qs ? `?${qs}` : ''}`
}

export function navigate(path: string, params: Record<string, string | number | null | undefined> = {}, replace = false): void {
  const next = href(path, params)
  if (replace) window.history.replaceState(null, '', next)
  else window.location.hash = next.slice(1)
  if (replace) window.dispatchEvent(new HashChangeEvent('hashchange'))
}

/** Reads and writes one query parameter of the current route. */
export function useParam(key: string): [string | null, (v: string | number | null, replace?: boolean) => void] {
  const route = useRoute()
  const set = useCallback(
    (v: string | number | null, replace = true) => {
      const r = parse(window.location.hash)
      const params: Record<string, string> = Object.fromEntries(r.params)
      if (v === null || v === '') delete params[key]
      else params[key] = String(v)
      navigate(r.path, params, replace)
    },
    [key],
  )
  return [route.params.get(key), set]
}

export function Link({ to, params, children, className }: { to: string; params?: Record<string, string | number | null | undefined>; children: ReactNode; className?: string }) {
  return (
    <a href={href(to, params)} className={className}>
      {children}
    </a>
  )
}
