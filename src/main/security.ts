import { type Session, type WebContents, app, shell } from 'electron'

export const APP_ORIGIN = 'app://openapplyr'

const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // React Aria and the virtual list set style attributes; styles cannot execute code.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

export function csp(devServerUrl?: string): string {
  if (!devServerUrl) return PROD_CSP
  const ws = devServerUrl.replace(/^http/, 'ws')
  // Vite's React refresh preamble is an inline script; this relaxation exists only in dev.
  return PROD_CSP.replace("script-src 'self'", `script-src 'self' 'unsafe-inline' ${devServerUrl}`).replace(
    "connect-src 'self'",
    `connect-src 'self' ${devServerUrl} ${ws}`,
  )
}

export function isTrustedUrl(url: string, devServerUrl?: string): boolean {
  if (url.startsWith(`${APP_ORIGIN}/`) || url === APP_ORIGIN) return true
  return !!devServerUrl && url.startsWith(devServerUrl)
}

export function hardenSession(ses: Session, devServerUrl?: string): void {
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  if (devServerUrl) {
    ses.webRequest.onHeadersReceived({ urls: [`${devServerUrl}/*`] }, (details, callback) => {
      callback({
        responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp(devServerUrl)] },
      })
    })
  }
}

/** Applied to every web contents the app creates. */
export function hardenWebContents(contents: WebContents, devServerUrl?: string): void {
  contents.on('will-navigate', (event, url) => {
    if (!isTrustedUrl(url, devServerUrl)) event.preventDefault()
  })
  contents.on('will-redirect', (event, url) => {
    if (!isTrustedUrl(url, devServerUrl)) event.preventDefault()
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.setWindowOpenHandler(({ url }) => {
    // Links with target=_blank open in the default browser, never inside the app.
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
}

export function isSafeExternalUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:'
  } catch {
    return false
  }
}

export function installGlobalHardening(devServerUrl?: string): void {
  app.on('web-contents-created', (_e, contents) => hardenWebContents(contents, devServerUrl))
}
