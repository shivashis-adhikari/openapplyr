// Runs inside the application page (and inside embedded form iframes).
// Reads the form the way a person does: one entry per question, with its label, options and whether it is
// required. Each control is tagged with data-oa-field (and options with data-oa-opt) so the engine can
// address it with a stable selector. Idempotent: calling it again re-reads the form after a step changes.
;(() => {
  const clean = (t) => (t || '').replace(/[\s ]+/g, ' ').trim()
  const textOf = (el) => clean(el ? el.innerText || el.textContent : '')
  const REQUIRED_MARK = /\s*(\*|✱|\(required\))\s*$/i

  function visible(el) {
    if (!el || !el.isConnected) return false
    const s = getComputedStyle(el)
    if (s.display === 'none' || s.visibility === 'hidden') return false
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return false
    // Honeypots placed off the page (document coordinates, so scrolling does not hide real fields).
    if (r.right + window.scrollX < -100 || r.bottom + window.scrollY < -100) return false
    return true
  }

  function hiddenByAria(el) {
    return !!el.closest('[aria-hidden="true"], [inert]')
  }

  function byIds(ids) {
    return clean(
      ids
        .split(/\s+/)
        .map((i) => document.getElementById(i))
        .filter(Boolean)
        .map((e) => e.innerText || e.textContent)
        .join(' '),
    )
  }

  /** The nearest label-like element in the containers around a control. */
  function containerLabelEl(el, exclude) {
    const group = el.closest('[role=group][aria-labelledby], [role=radiogroup][aria-labelledby]')
    if (group) {
      const first = document.getElementById(group.getAttribute('aria-labelledby').split(/\s+/)[0])
      if (first && textOf(first)) return first
    }
    let c = el.parentElement
    for (let depth = 0; c && depth < 6; depth++, c = c.parentElement) {
      const candidates = c.querySelectorAll('legend, label, [class*="label" i], [class*="question" i], [class*="title" i], h3, h4, p')
      for (const l of candidates) {
        if (l.contains(el) || (exclude && exclude.some((x) => l.contains(x) || x.contains(l)))) continue
        if (l.querySelector('input, select, textarea') || l.closest('button')) continue
        // A <label> that belongs to another control is not this control's question.
        if (l.htmlFor && l.htmlFor !== el.id) continue
        const t = textOf(l)
        if (t && t.length < 600) return l
      }
    }
    return null
  }
  const containerLabel = (el, exclude) => textOf(containerLabelEl(el, exclude))

  /** Some forms mark required fields only with a class and a CSS asterisk. */
  const markedRequired = (labelEl) => !!labelEl && (/required/i.test(labelEl.className || '') || !!labelEl.querySelector('[class*="required" i]'))

  function ownLabel(el) {
    const by = el.getAttribute('aria-labelledby')
    if (by) {
      const t = byIds(by)
      if (t) return t
    }
    if (el.labels && el.labels.length) {
      const t = textOf(el.labels[0])
      if (t) return t
    }
    const aria = el.getAttribute('aria-label')
    if (aria) return clean(aria)
    return ''
  }

  function optionLabel(el) {
    const own = ownLabel(el)
    if (own) return own
    const next = el.nextElementSibling
    if (next && textOf(next)) return textOf(next)
    const parent = el.parentElement
    if (parent && textOf(parent)) return textOf(parent)
    return clean(el.value)
  }

  function isRequired(el, label) {
    return !!(el.required || el.getAttribute('aria-required') === 'true' || REQUIRED_MARK.test(label))
  }

  const fields = []
  let seq = Number(document.documentElement.dataset.oaSeq || 0)
  const tag = (els) => {
    const existing = els[0].dataset.oaField
    const id = existing || `f${++seq}`
    for (const e of els) e.dataset.oaField = id
    return id
  }
  const push = (f) => {
    const label = clean(f.label).replace(REQUIRED_MARK, '')
    fields.push({ ...f, label: label || f.name || 'Untitled field' })
  }
  const seen = new Set()

  // Radio and checkbox groups, by name. Hidden checkboxes behind Yes/No buttons are handled below.
  const groups = new Map()
  for (const el of document.querySelectorAll('input[type=radio], input[type=checkbox]')) {
    if (hiddenByAria(el) && visible(el)) continue
    const key = `${el.type}:${el.name || el.id}`
    if (!el.name && !el.id) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(el)
  }
  for (const [key, els] of groups) {
    const shown = els.filter((e) => visible(e) || (e.labels && e.labels[0] && visible(e.labels[0])))
    if (!shown.length) {
      // Ashby-style Yes/No: a hidden checkbox next to option buttons.
      const box = els[0]
      const buttons = box.parentElement ? [...box.parentElement.querySelectorAll('button')].filter(visible) : []
      if (buttons.length >= 2 && buttons.length <= 6) {
        const id = tag([box, ...buttons])
        buttons.forEach((b, i) => (b.dataset.oaOpt = String(i)))
        const labelEl = containerLabelEl(box, buttons)
        const label = textOf(labelEl)
        push({ id, kind: 'buttons', inputType: 'buttons', name: box.name || box.id, label, required: isRequired(box, label) || markedRequired(labelEl), options: buttons.map(textOf), value: '', maxLength: null })
        els.forEach((e) => seen.add(e))
      }
      continue
    }
    const isRadio = key.startsWith('radio:')
    const id = tag(shown)
    shown.forEach((e, i) => (e.dataset.oaOpt = String(i)))
    shown.forEach((e) => seen.add(e))
    const options = shown.map(optionLabel)
    const group = shown[0].closest('[role=radiogroup], [role=group], fieldset')
    let label = ''
    if (group) {
      const legend = group.querySelector('legend')
      label = (group.getAttribute('aria-labelledby') && byIds(group.getAttribute('aria-labelledby'))) || group.getAttribute('aria-label') || (legend ? textOf(legend) : '')
    }
    if (!isRadio && shown.length === 1) {
      // A single checkbox is its own question: "I agree to the privacy notice".
      const own = options[0]
      const lab = shown[0].labels && shown[0].labels[0]
      const req = isRequired(shown[0], own) || markedRequired(lab) || markedRequired(containerLabelEl(shown[0], shown))
      push({ id, kind: 'checkbox', inputType: 'checkbox', name: shown[0].name || shown[0].id, label: own || label || containerLabel(shown[0], shown), required: req, options: [], value: shown[0].checked ? 'Yes' : '', maxLength: null })
      continue
    }
    const optionEls = shown.map((e) => (e.labels && e.labels[0]) || e)
    const labelEl = label ? null : containerLabelEl(shown[0], optionEls)
    if (!label) label = textOf(labelEl)
    const checked = shown.filter((e) => e.checked).map(optionLabel)
    push({
      id,
      kind: isRadio ? 'radio' : 'checkboxes',
      inputType: isRadio ? 'radio' : 'checkbox',
      name: shown[0].name || shown[0].id,
      label,
      required: shown.some((e) => isRequired(e, label)) || REQUIRED_MARK.test(label) || markedRequired(labelEl) || (group && group.getAttribute('aria-required') === 'true'),
      options,
      value: checked.join('\n'),
      maxLength: null,
    })
  }

  for (const el of document.querySelectorAll('input, select, textarea, [role=combobox]')) {
    if (seen.has(el)) continue
    const tagName = el.tagName.toLowerCase()
    const type = (el.getAttribute('type') || (tagName === 'input' ? 'text' : tagName)).toLowerCase()
    if (['hidden', 'submit', 'button', 'image', 'reset', 'radio', 'checkbox', 'search', 'password'].includes(type)) continue
    if (el.closest('[role=listbox], [role=menu], [role=dialog][aria-modal="false"]')) continue
    if (type === 'file') {
      // File inputs are often visually hidden behind an "Attach" button; they still count.
      if (el.closest('[aria-hidden="true"]') && !el.id && !el.name) continue
      // The <label> is often the "Attach" button; the question is the text around it.
      const own = ownLabel(el)
      const labelEl = containerLabelEl(el, [el, ...(el.labels ? [...el.labels] : [])])
      const around = textOf(labelEl)
      const raw = own && !/^(attach|upload|browse|choose|select)\b/i.test(own) ? own : around || own
      if (/autofill|auto-fill|parse your resume/i.test(raw)) continue
      const label = raw.split(/\s*[*✱]\s*/)[0].replace(/\s+(attach|upload)\b.*$/i, '')
      const required = isRequired(el, raw) || /[*✱]/.test(raw) || markedRequired(labelEl) || el.closest('[aria-required="true"]') !== null
      push({ id: tag([el]), kind: 'file', inputType: 'file', name: el.name || el.id, label, required, options: [], value: el.files && el.files.length ? el.files[0].name : '', maxLength: null })
      continue
    }
    if (!visible(el) || hiddenByAria(el) || el.disabled || el.readOnly) continue
    if (el.tabIndex < 0 && !el.getAttribute('role')) continue
    const label = ownLabel(el) || containerLabel(el, [el]) || clean(el.getAttribute('placeholder'))
    if (!label && !el.name && !el.id) continue
    const id = tag([el])
    const required = isRequired(el, label) || markedRequired((el.labels && el.labels[0]) || null)
    const name = el.name || el.id || ''
    if (tagName === 'select') {
      const options = [...el.options].filter((o) => o.value !== '' && !/^(select|choose|please select|--)/i.test(clean(o.text))).map((o) => clean(o.text))
      push({ id, kind: 'select', inputType: el.multiple ? 'multiselect' : 'select', name, label, required, options, value: el.selectedIndex > 0 ? clean(el.options[el.selectedIndex].text) : '', maxLength: null })
    } else if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list') {
      const listId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns')
      const list = listId ? document.getElementById(listId) : null
      const options = list ? [...list.querySelectorAll('[role=option]')].map(textOf).filter(Boolean) : []
      let current = el.value
      for (let c = el.parentElement, i = 0; !current && c && i < 5; c = c.parentElement, i++) {
        current = textOf(c.querySelector('[class*="single-value" i], [class*="singleValue" i]'))
      }
      push({ id, kind: 'combobox', inputType: 'combobox', name, label, required, options, value: clean(current), maxLength: null })
    } else if (tagName === 'textarea') {
      push({ id, kind: 'textarea', inputType: 'textarea', name, label, required, options: [], value: el.value, maxLength: el.maxLength > 0 ? el.maxLength : null })
    } else {
      push({ id, kind: type === 'date' ? 'date' : type === 'number' ? 'number' : 'text', inputType: type, name, label, required, options: [], value: el.value, maxLength: el.maxLength > 0 ? el.maxLength : null })
    }
  }

  document.documentElement.dataset.oaSeq = String(seq)

  // Things the engine needs besides fields: buttons, errors, and signs of a challenge or a finished form.
  const buttons = [...document.querySelectorAll('button, input[type=submit], input[type=button], a[role=button], [role=button]')]
    .filter((b) => visible(b) && !b.disabled && !b.closest('[role=listbox], [role=menu]'))
    .map((b) => {
      const id = b.dataset.oaButton || `b${++seq}`
      b.dataset.oaButton = id
      return { id, text: clean(b.innerText || b.value || b.getAttribute('aria-label')), type: (b.getAttribute('type') || '').toLowerCase() }
    })
    .filter((b) => b.text)
  document.documentElement.dataset.oaSeq = String(seq)

  const errors = [...document.querySelectorAll('[aria-invalid="true"], [role=alert], .error, .field-error, [class*="error-message" i], [class*="errorMessage" i]')]
    .filter(visible)
    .map(textOf)
    .filter((t) => t && t.length < 300)

  const login = [...document.querySelectorAll('input[type=password]')].some(visible)

  const challenge = [...document.querySelectorAll('iframe')].some((f) => /hcaptcha\.com|recaptcha\/(api2|enterprise)\/bframe|challenges\.cloudflare\.com|arkoselabs/.test(f.src) && visible(f) && f.getBoundingClientRect().height > 100)

  return {
    url: location.href,
    title: document.title,
    fields,
    buttons,
    errors: [...new Set(errors)].slice(0, 20),
    challenge,
    login,
    text: clean(document.body ? document.body.innerText : '').slice(0, 4000),
  }
})()
