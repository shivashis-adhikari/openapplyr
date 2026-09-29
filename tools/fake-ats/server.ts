import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Local stand-ins for applicant tracking system forms, used by the apply engine tests and the
 * end-to-end run. They copy the structures real forms use (React-style comboboxes with role=option
 * lists, radio "cards", upload groups labelled through aria-labelledby, a location dropdown, a
 * two-step wizard) and record what was submitted. Nothing here talks to a real site.
 */

export type Submission = { form: string; fields: Record<string, string>; files: string[] }

const page = (title: string, body: string, script = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px system-ui;margin:40px auto;max-width:720px} label,.label{display:block;font-weight:600;margin-top:16px} input,select,textarea{display:block;width:100%;padding:6px;margin-top:4px}
.combo{position:relative}.menu{border:1px solid #999;background:#fff;position:absolute;width:100%;z-index:2}.menu div{padding:6px;cursor:pointer}.menu div:hover{background:#eee}
.required{color:#b00}.error{color:#b00}.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}</style></head>
<body>${body}<script>${script}</script></body></html>`

// A minimal combobox in the style of react-select: an input with role=combobox, options rendered on focus.
const COMBO_SCRIPT = `
document.querySelectorAll('[data-combo]').forEach((input) => {
  const options = JSON.parse(input.dataset.combo)
  const hidden = document.getElementById(input.id + '_value')
  let menu = null
  const close = () => { if (menu) { menu.remove(); menu = null } }
  const open = () => {
    close()
    menu = document.createElement('div'); menu.className = 'menu'; menu.setAttribute('role', 'listbox'); menu.id = input.id + '-listbox'
    const q = input.value.toLowerCase()
    for (const o of options.filter((x) => !q || x.toLowerCase().includes(q))) {
      const d = document.createElement('div'); d.setAttribute('role', 'option'); d.textContent = o
      d.addEventListener('mousedown', (e) => { e.preventDefault(); hidden.value = o; input.value = ''; input.nextElementSibling.textContent = o; close() })
      menu.appendChild(d)
    }
    input.parentElement.appendChild(menu)
  }
  input.addEventListener('focus', open); input.addEventListener('click', open); input.addEventListener('input', open)
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') close() })
  input.addEventListener('blur', () => setTimeout(close, 100))
})
`

const combo = (id: string, label: string, options: string[], required = true) => `
<div class="field"><div class="label" id="${id}-label">${label}${required ? '<span class="required">*</span>' : ''}</div>
<div class="combo"><input id="${id}" role="combobox" aria-labelledby="${id}-label" aria-required="${required}" aria-controls="${id}-listbox" data-combo='${JSON.stringify(options).replace(/'/g, '&#39;')}' autocomplete="off"><div class="select__single-value"></div>
<input type="hidden" name="${id}" id="${id}_value"></div></div>`

const greenhouseForm = () =>
  page(
    'Senior Backend Engineer at Acme',
    `<h1>Senior Backend Engineer</h1><p>Acme builds payments software.</p>
<form id="application" method="post" action="/greenhouse/submit" enctype="multipart/form-data" novalidate>
<label for="first_name">First Name<span class="required">*</span></label><input id="first_name" name="first_name" aria-required="true">
<label for="last_name">Last Name<span class="required">*</span></label><input id="last_name" name="last_name" aria-required="true">
<label for="email">Email<span class="required">*</span></label><input id="email" name="email" type="text" aria-required="true">
<label for="phone">Phone</label><input id="phone" name="phone" type="tel">
<div role="group" aria-labelledby="upload-label-resume" aria-required="true"><div id="upload-label-resume" class="label">Resume/CV<span class="required">*</span></div>
<button type="button" onclick="document.getElementById('resume').click()">Attach</button><label class="visually-hidden" for="resume">Attach</label><input id="resume" name="resume" class="visually-hidden" type="file"></div>
${combo('question_1', 'Are you legally authorized to work in Portugal?', ['Yes', 'No'])}
${combo('question_2', 'Will you now or in the future require sponsorship?', ['Yes', 'No'])}
<label for="question_3">Why do you want to work at Acme?<span class="required">*</span></label><textarea id="question_3" name="question_3" aria-required="true" maxlength="1500"></textarea>
${combo('gender', 'Gender', ['Male', 'Female', "I don't wish to answer"])}
<label><input type="checkbox" name="privacy" required> I acknowledge the privacy notice</label>
<p class="error" id="errors" role="alert" style="display:none"></p>
<button type="submit">Submit application</button></form>`,
    `${COMBO_SCRIPT}
document.getElementById('application').addEventListener('submit', (e) => {
  const missing = ['first_name','last_name','email','question_3'].filter((n) => !document.getElementById(n).value.trim())
  for (const n of ['question_1','question_2','gender']) if (!document.getElementById(n + '_value').value) missing.push(n)
  if (!document.getElementById('resume').files.length) missing.push('resume')
  if (!document.querySelector('[name=privacy]').checked) missing.push('privacy')
  if (missing.length) { e.preventDefault(); const el = document.getElementById('errors'); el.style.display = 'block'; el.textContent = 'Please complete: ' + missing.join(', ') }
})`,
  )

const leverForm = () =>
  page(
    'Acme - Platform Engineer',
    `<h2>Platform Engineer</h2><form id="lever" method="post" action="/lever/submit" enctype="multipart/form-data">
<ul>
<li><label><div class="application-label">Resume/CV <span class="required">✱</span></div><input type="file" name="resume" id="resume-upload-input" style="opacity:0;height:1px"> ATTACH RESUME/CV</label></li>
<li><label><div class="application-label">Full name <span class="required">✱</span></div><input name="name" required></label></li>
<li><label><div class="application-label">Email <span class="required">✱</span></div><input type="email" name="email" required></label></li>
<li><label><div class="application-label">Current location <span class="required">✱</span></div><input id="location-input" name="location" required autocomplete="off"><input type="hidden" name="selectedLocation" id="selected-location">
<div class="dropdown-results" id="loc-results"></div></label></li>
<li><label><div class="application-label">Current company</div><input name="org"></label></li>
<li><label><div class="application-label">LinkedIn URL</div><input name="urls[LinkedIn]"></label></li>
</ul>
<div class="application-question"><div class="application-label">Will you now or in the future require sponsorship for employment visa status? <span class="required">✱</span></div>
<ul><li><label><input type="radio" name="cards[abc][field0]" value="Yes" required> Yes</label></li><li><label><input type="radio" name="cards[abc][field0]" value="No"> No</label></li></ul></div>
<div class="application-question"><div class="application-label">Which languages do you speak? (Check all that apply)</div>
<ul><li><label><input type="checkbox" name="cards[def][field0]" value="English"> English</label></li><li><label><input type="checkbox" name="cards[def][field0]" value="Portuguese"> Portuguese</label></li><li><label><input type="checkbox" name="cards[def][field0]" value="German"> German</label></li></ul></div>
<label><div class="application-label">Additional information</div><textarea name="comments"></textarea></label>
<button type="button" id="btn-submit" onclick="submitLever()">SUBMIT APPLICATION</button></form>`,
    `const cities = ['Lisbon, PRT', 'Lisbon, WI, USA', 'Porto, PRT', 'Berlin, DEU']
const input = document.getElementById('location-input'), results = document.getElementById('loc-results')
input.addEventListener('input', () => {
  results.innerHTML = ''
  const q = input.value.toLowerCase().split(',')[0].trim()
  if (q.length < 2) return
  for (const c of cities.filter((x) => x.toLowerCase().startsWith(q))) {
    const d = document.createElement('div'); d.className = 'dropdown-location'; d.textContent = c
    d.addEventListener('click', () => { input.value = c; document.getElementById('selected-location').value = c; results.innerHTML = '' })
    results.appendChild(d)
  }
})
function submitLever() {
  if (!document.getElementById('selected-location').value) { alert('Pick a location from the list'); return }
  document.getElementById('lever').requestSubmit()
}`,
  )

const wizard = (step: number) =>
  step === 1
    ? page(
        'Apply - Step 1 of 2',
        `<form method="get" action="/wizard/2"><h2>Your details</h2>
<label for="fn">First name *</label><input id="fn" name="fn" required>
<label for="em">Email address *</label><input id="em" name="em" type="email" required>
<button type="submit">Next</button></form>`,
      )
    : page(
        'Apply - Step 2 of 2',
        `<form method="post" action="/wizard/submit"><h2>A few questions</h2>
<input type="hidden" name="fn" value=""><input type="hidden" name="em" value="">
<label for="colour">What is your favourite colour? *</label><input id="colour" name="colour" required>
<label for="notice">What is your notice period?</label><input id="notice" name="notice">
<button type="submit">Submit application</button></form>`,
        `const p = new URLSearchParams(location.search); document.querySelector('[name=fn]').value = p.get('fn') || ''; document.querySelector('[name=em]').value = p.get('em') || ''`,
      )

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

/** Parses multipart or urlencoded bodies enough to record field values and uploaded file names. */
function parseForm(buf: Buffer, type: string): { fields: Record<string, string>; files: string[] } {
  const fields: Record<string, string> = {}
  const files: string[] = []
  const boundary = /boundary=(.+)$/.exec(type)?.[1]
  if (!boundary) {
    for (const [k, v] of new URLSearchParams(buf.toString('utf8'))) fields[k] = fields[k] ? `${fields[k]}; ${v}` : v
    return { fields, files }
  }
  for (const part of buf.toString('latin1').split(`--${boundary}`)) {
    const name = /name="([^"]+)"/.exec(part)?.[1]
    if (!name) continue
    const filename = /filename="([^"]*)"/.exec(part)?.[1]
    const value = part.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, '')
    if (filename !== undefined) {
      if (filename) files.push(filename)
    } else fields[name] = fields[name] ? `${fields[name]}; ${Buffer.from(value, 'latin1').toString('utf8')}` : Buffer.from(value, 'latin1').toString('utf8')
  }
  return { fields, files }
}

export async function startFakeAts(): Promise<{ url: string; submissions: Submission[]; close: () => Promise<void> }> {
  const submissions: Submission[] = []
  const send = (res: ServerResponse, html: string, status = 200) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  }
  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'POST') {
      const form = u.pathname.split('/')[1] ?? 'unknown'
      submissions.push({ form, ...parseForm(await body(req), req.headers['content-type'] ?? '') })
      res.writeHead(303, { location: `/${form}/confirmation` })
      return res.end()
    }
    if (u.pathname.endsWith('/confirmation')) return send(res, page('Application submitted', '<h1>Thank you for applying!</h1><p>Your application has been submitted. We will be in touch.</p>'))
    if (u.pathname === '/greenhouse/jobs/1') return send(res, greenhouseForm())
    if (u.pathname === '/lever/acme/1/apply') return send(res, leverForm())
    if (u.pathname === '/wizard/1') return send(res, wizard(1))
    if (u.pathname === '/wizard/2') return send(res, wizard(2))
    if (u.pathname === '/landing') return send(res, page('Careers at Acme', '<h1>Senior Backend Engineer</h1><p>Join the payments team.</p><a href="/wizard/1">Start your application</a> <a href="/about">About us</a>'))
    // A form behind a CAPTCHA widget. The frame points nowhere, so nothing loads from the network.
    if (u.pathname === '/captcha/1')
      return send(
        res,
        page(
          'Apply',
          `<form method="post" action="/captcha/submit"><label for="fn">First name *</label><input id="fn" name="fn" required>
<label for="em">Email *</label><input id="em" name="em" type="email" required>
<iframe title="hCaptcha" src="about:blank#https://newassets.hcaptcha.com/captcha/v1/challenge" style="width:400px;height:480px;border:1px solid #999"></iframe>
<button type="submit">Submit application</button></form>`,
        ),
      )
    // A careers site that asks for an account before showing the form.
    if (u.pathname === '/login')
      return send(
        res,
        page(
          'Sign in',
          `<h1>Sign in to continue your application</h1><form method="post" action="/login/session"><label for="email">Email</label><input id="email" name="email" type="email">
<label for="pw">Password</label><input id="pw" name="password" type="password"><button type="submit">Sign in</button> <a href="/login/new">Create an account</a></form>`,
        ),
      )
    if (u.pathname === '/closed') return send(res, page('Not found', '<h1>This job is no longer available</h1>'), 404)
    send(res, page('Not found', '<h1>Not found</h1>'), 404)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, submissions, close: () => new Promise((r) => server.close(() => r())) }
}
