// Tabs for "How it works" (WAI-ARIA tabs pattern), the copy button, and the navigation rule on scroll.
// Without this script every step is shown in order.

for (const root of document.querySelectorAll('[data-tabs]')) {
  const tabs = [...root.querySelectorAll('[role="tab"]')]
  const select = (tab, focus) => {
    for (const t of tabs) {
      const on = t === tab
      t.setAttribute('aria-selected', String(on))
      t.tabIndex = on ? 0 : -1
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on
    }
    if (focus) tab.focus()
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(tab, false))
    tab.addEventListener('keydown', (e) => {
      const next = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key]
      if (next === undefined) return
      e.preventDefault()
      select(tabs[(next + tabs.length) % tabs.length], true)
    })
  })
  select(tabs.find((t) => t.getAttribute('aria-selected') === 'true') ?? tabs[0], false)
}

for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const label = button.querySelector('span')
    try {
      await navigator.clipboard.writeText(button.parentElement.querySelector('code').textContent)
      label.textContent = 'Copied'
    } catch {
      label.textContent = 'Select and copy'
    }
    setTimeout(() => (label.textContent = 'Copy'), 2000)
  })
}

const nav = document.querySelector('.nav')
const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8)
addEventListener('scroll', onScroll, { passive: true })
onScroll()
