import type { Page } from '@playwright/test'

// Browser globals used inside page.evaluate, declared for this file only so the Node project stays free
// of DOM types.
/* eslint-disable @typescript-eslint/no-explicit-any */
declare const document: any
declare const innerWidth: number
declare const innerHeight: number
declare function getComputedStyle(el: any): any
type Element = any

/**
 * Content the person can't see or scroll to: visible elements that extend past the window, or past a
 * box that clips them, where no ancestor scrolls in that direction. Returns one line per problem.
 */
export function unreachable(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const W = innerWidth
    const H = innerHeight
    const doc = document.documentElement
    const out: string[] = []
    if (doc.scrollWidth > W + 1) out.push(`page scrolls sideways (${doc.scrollWidth}px wide in ${W}px)`)
    const scrolls = (el: Element, axis: 'x' | 'y') => {
      const s = getComputedStyle(el)
      const o = axis === 'x' ? s.overflowX : s.overflowY
      return (o === 'auto' || o === 'scroll') && (axis === 'x' ? el.scrollWidth > el.clientWidth : el.scrollHeight > el.clientHeight)
    }
    const clips = (el: Element) => {
      const s = getComputedStyle(el)
      return s.overflowX !== 'visible' || s.overflowY !== 'visible'
    }
    const name = (el: Element) => {
      const c = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''
      const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 30)
      return `${el.tagName.toLowerCase()}${c}${text ? ` "${text}"` : ''}`
    }
    for (const el of document.querySelectorAll('body *')) {
      const s = getComputedStyle(el)
      if (s.visibility === 'hidden' || s.display === 'none' || s.position === 'fixed' || s.opacity === '0') continue
      // Deliberately hidden controls (native inputs behind custom checkboxes and radios).
      if (s.clipPath !== 'none' || (s.clip && s.clip !== 'auto')) continue
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2 || el.closest('[aria-hidden="true"], .sr-only, .visually-hidden')) continue
      // Content of a collapsed <details> is laid out but not shown.
      const closed = el.closest('details:not([open])')
      if (closed && !el.closest('summary')) continue
      // Walk up: the element is fine if a scrolling ancestor can bring it into view.
      let right = W
      let bottom = H
      let reachableX = false
      let reachableY = false
      let hidden = false
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ps = getComputedStyle(p)
        const pr0 = p.getBoundingClientRect()
        // Inside a visually hidden wrapper (1px clipped box, clip-path or clip): hidden on purpose.
        if (ps.clipPath !== 'none' || (ps.clip && ps.clip !== 'auto') || (clips(p) && (pr0.width < 2 || pr0.height < 2))) {
          hidden = true
          break
        }
        if (scrolls(p, 'x')) reachableX = true
        if (scrolls(p, 'y')) reachableY = true
        if (clips(p)) {
          const pr = p.getBoundingClientRect()
          if (!reachableX) right = Math.min(right, pr.right)
          if (!reachableY) bottom = Math.min(bottom, pr.bottom)
        }
      }
      // Only report the outermost offender, and ignore text that deliberately ends in an ellipsis.
      if (hidden || s.textOverflow === 'ellipsis') continue
      const parent = el.parentElement?.getBoundingClientRect()
      if (!reachableX && r.right > right + 2 && !(parent && parent.right > right + 2 && el.parentElement !== document.body)) out.push(`cut off on the right: ${name(el)} (${Math.round(r.right)} > ${Math.round(right)})`)
      if (!reachableY && r.bottom > bottom + 2 && !(parent && parent.bottom > bottom + 2 && el.parentElement !== document.body)) out.push(`cut off at the bottom: ${name(el)} (${Math.round(r.bottom)} > ${Math.round(bottom)})`)
    }
    return [...new Set(out)]
  })
}
