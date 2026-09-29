// Renders the app and tray icons from LogoOnly.svg with the installed Chrome.
// Usage: node scripts/icons.mjs   (writes build/icon.png, build/tray*.png)
import { readFileSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright-core'

const logo = readFileSync('LogoOnly.svg', 'utf8')
const inner = logo.replace(/^[\s\S]*?<g[^>]*>/, '').replace(/<\/g>[\s\S]*$/, '')
const mono = inner.replace(/fill="#[0-9A-Fa-f]{6}"/g, 'fill="#000000"')

const svg = (body, size, bg) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">
${bg ? `<rect x="64" y="64" width="896" height="896" rx="200" fill="#F6F4EE"/><rect x="64.5" y="64.5" width="895" height="895" rx="199.5" fill="none" stroke="#E2DED3"/>` : ''}
<g transform="translate(${bg ? 222 : 57} ${bg ? 262 : 157}) scale(${bg ? 2.44 : 3.82})">${body}</g></svg>`

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage()
async function render(markup, size, file) {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(`<html><body style="margin:0;background:transparent">${markup}</body></html>`)
  writeFileSync(file, await page.locator('svg').screenshot({ omitBackground: true }))
}
await render(svg(inner, 1024, true), 1024, 'build/icon.png')
await render(svg(mono, 18, false), 18, 'build/trayTemplate.png')
await render(svg(mono, 36, false), 36, 'build/trayTemplate@2x.png')
await render(svg(inner, 32, false), 32, 'build/tray.png')
await render(svg(inner, 64, false), 64, 'build/tray@2x.png')
await browser.close()
console.log('Icons written to build/.')
