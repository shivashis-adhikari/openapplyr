import { useEffect, useRef, useState } from 'react'

const PAGE_WIDTH = 816 // 8.5in at 96dpi; A4 pages are 794px and scale the same way.

/**
 * Renders a generated document (resume or letter HTML) as it will print. The frame has no scripts
 * (sandbox without allow-scripts); same-origin only so its height can be measured.
 */
export function DocPreview({ html, title }: { html: string; title: string }) {
  const wrap = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const [scale, setScale] = useState(0.7)
  const [height, setHeight] = useState(1056)
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(() => setScale(Math.min(1, el.clientWidth / PAGE_WIDTH)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const measure = () => {
    const doc = frame.current?.contentDocument
    if (doc) setHeight(Math.max(600, doc.documentElement.scrollHeight))
  }
  return (
    <div ref={wrap} style={{ width: '100%', height: height * scale, overflow: 'hidden', border: '1px solid var(--border)', borderRadius: 8, background: 'white' }}>
      <iframe
        ref={frame}
        title={title}
        sandbox="allow-same-origin"
        srcDoc={html}
        onLoad={measure}
        style={{ width: PAGE_WIDTH, height, border: 0, transform: `scale(${scale})`, transformOrigin: '0 0' }}
      />
    </div>
  )
}
