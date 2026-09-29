import { type ResumeTemplate, bullets, contactItems, dateRange, esc, fontFaces, join2, page } from './shared'
import { sections } from './single'

export const studio: ResumeTemplate = {
  id: 'studio',
  name: 'Studio',
  description: 'Two columns with a side panel for skills and education. Some older ATS read two columns out of order.',
  columns: 2,
  atsSafe: false,
  regions: ['US', 'CA', 'UK', 'EU', 'AU', 'OTHER'],
  render(ctx) {
    const c = ctx.content
    const css = `${fontFaces(ctx.fontsDir, [
      { family: 'Libre Baskerville', file: 'libre-baskerville', weight: 400 },
      { family: 'Source Sans 3', file: 'source-sans-3', weight: 400 },
      { family: 'Source Sans 3', file: 'source-sans-3', weight: 600 },
    ])}
body { font-family: 'Source Sans 3', Arial, sans-serif; font-size: 10pt; line-height: 1.42; color: #1C2420; }
/* The header comes first in the document so parsers read the name and contact details before the side panel. */
.sheet { display: grid; grid-template-columns: 2.25in 1fr; grid-template-rows: auto 1fr; grid-template-areas: 'side head' 'side main'; min-height: 100vh; }
header { grid-area: head; padding: 0.55in 0.5in 0 0.35in; }
aside { grid-area: side; background: #F1EFE8; padding: 0.55in 0.3in 0.5in 0.45in; font-size: 9.3pt; }
main { grid-area: main; padding: 14pt 0.5in 0.5in 0.35in; }
h1 { font-family: 'Libre Baskerville', Georgia, serif; font-weight: 400; font-size: 21pt; line-height: 1.15; color: #0D2D20; }
.headline { margin-top: 4pt; color: #4F6B48; font-weight: 600; }
.contact { margin-top: 6pt; font-size: 9.3pt; color: #5B635E; }
.contact span + span::before { content: '  ·  '; white-space: pre; }
aside h2, main h2 { font-size: 8.2pt; text-transform: uppercase; letter-spacing: .04em; color: #4F6B48; font-weight: 600; margin: 15pt 0 5pt; }
aside li { margin-top: 2pt; }
aside > h2:first-child, main > section:first-child > h2 { margin-top: 0; }
.entry { margin-bottom: 8pt; }
.role { display: flex; justify-content: space-between; gap: 10pt; }
.role .t { font-weight: 600; }
.dates { color: #5B635E; font-size: 9pt; white-space: nowrap; }
.org { color: #5B635E; }
ul.b li { position: relative; padding-left: 10pt; margin-top: 2pt; }
ul.b li::before { content: ''; position: absolute; left: 1pt; top: .62em; width: 3pt; height: 3pt; border-radius: 50%; background: #64865C; }`
    const header = `<header><h1>${esc(c.name)}</h1>${c.headline ? `<div class="headline">${esc(c.headline)}</div>` : ''}<div class="contact">${contactItems(c).map((x) => `<span>${x}</span>`).join('')}</div></header>`
    const aside = `<aside>${c.skills.length ? `<h2>Skills</h2><ul>${c.skills.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
${c.education.length ? `<h2>Education</h2><ul>${c.education.map((e) => `<li><strong>${esc(join2(e.degree, e.field, ' in '))}</strong><br>${esc(e.institution)}${e.end ? `, ${esc(e.end.slice(0, 4))}` : ''}</li>`).join('')}</ul>` : ''}
${c.certifications.length ? `<h2>Certifications</h2><ul>${c.certifications.map((x) => `<li>${esc(x.name)}</li>`).join('')}</ul>` : ''}
${c.languages.length ? `<h2>Languages</h2><ul>${c.languages.map((l) => `<li>${esc(l.fluency ? `${l.name} (${l.fluency})` : l.name)}</li>`).join('')}</ul>` : ''}</aside>`
    const main = `<main>${sections({ ...ctx, content: { ...c, skills: [], education: [], certifications: [], languages: [] } })}</main>`
    return page(ctx, css, `<div class="sheet">${header}${aside}${main}</div>`, `${c.name} Resume`)
  },
}

export const ledger: ResumeTemplate = {
  id: 'ledger',
  name: 'Ledger',
  description: 'Dates in a left column, like a timeline. Reads in order, but some ATS drop the date column.',
  columns: 2,
  atsSafe: false,
  regions: ['US', 'CA', 'UK', 'EU', 'AU', 'OTHER'],
  render(ctx) {
    const c = ctx.content
    const css = `${fontFaces(ctx.fontsDir, [
      { family: 'Source Serif 4', file: 'source-serif-4', weight: 400 },
      { family: 'Source Serif 4', file: 'source-serif-4', weight: 600 },
      { family: 'IBM Plex Sans', file: 'ibm-plex-sans', weight: 400 },
      { family: 'IBM Plex Sans', file: 'ibm-plex-sans', weight: 600 },
    ])}
body { font-family: 'Source Serif 4', Georgia, serif; font-size: 10.2pt; line-height: 1.4; color: #1C2420; padding: 0.55in 0.6in; }
header { display: grid; grid-template-columns: 1.35in 1fr; gap: 14pt; margin-bottom: 8pt; }
h1 { grid-column: 2; font-size: 22pt; font-weight: 600; line-height: 1.1; }
.headline { grid-column: 2; font-family: 'IBM Plex Sans', Arial, sans-serif; color: #4F6B48; font-size: 10pt; margin-top: -8pt; }
.contact { grid-column: 2; font-family: 'IBM Plex Sans', Arial, sans-serif; font-size: 8.8pt; color: #5B635E; margin-top: -8pt; display: flex; flex-wrap: wrap; gap: 0 12pt; }
h2 { font-family: 'IBM Plex Sans', Arial, sans-serif; font-size: 8.2pt; text-transform: uppercase; letter-spacing: .04em; color: #0D2D20; font-weight: 600; margin: 12pt 0 6pt; padding-top: 6pt; border-top: .6pt solid #C9C4B6; }
.row { display: grid; grid-template-columns: 1.35in 1fr; gap: 14pt; margin-bottom: 8pt; break-inside: avoid-page; }
.when { font-family: 'IBM Plex Sans', Arial, sans-serif; font-size: 8.6pt; color: #5B635E; padding-top: 1.5pt; }
.t { font-weight: 600; }
.org { color: #3d3d3a; font-style: normal; }
ul.b li { position: relative; padding-left: 10pt; margin-top: 2pt; }
ul.b li::before { content: ''; position: absolute; left: 1pt; top: .62em; width: 3pt; height: 3pt; border-radius: 50%; background: #64865C; }`
    const row = (when: string, content: string) => `<div class="row"><div class="when">${esc(when)}</div><div>${content}</div></div>`
    const parts: string[] = []
    if (c.summary.text) parts.push(`<h2>Summary</h2>${row('', `<p>${esc(c.summary.text)}</p>`)}`)
    if (c.work.length) parts.push(`<h2>Experience</h2>${c.work.map((w) => row(dateRange(w.start, w.end), `<div class="t">${esc(w.title)}</div><div class="org">${esc(join2(w.company, w.location))}</div>${bullets(w.bullets)}`)).join('')}`)
    if (c.projects.length) parts.push(`<h2>Projects</h2>${c.projects.map((p) => row('', `<div class="t">${esc(p.name)}</div>${bullets(p.bullets)}`)).join('')}`)
    if (c.education.length) parts.push(`<h2>Education</h2>${c.education.map((e) => row(dateRange(e.start, e.end || null).replace(/^ – /, ''), `<div class="t">${esc(join2(e.degree, e.field, ' in '))}</div><div class="org">${esc(e.institution)}</div>`)).join('')}`)
    if (c.skills.length) parts.push(`<h2>Skills</h2>${row('', `<p>${c.skills.map(esc).join(', ')}</p>`)}`)
    if (c.certifications.length) parts.push(`<h2>Certifications</h2>${c.certifications.map((x) => row(x.date, `${esc(x.name)}${x.issuer ? `, ${esc(x.issuer)}` : ''}`)).join('')}`)
    const body = `<header><h1>${esc(c.name)}</h1>${c.headline ? `<div class="headline">${esc(c.headline)}</div>` : ''}<div class="contact">${contactItems(c).map((x) => `<span>${x}</span>`).join('')}</div></header>${parts.join('\n')}`
    return page(ctx, css, body, `${c.name} Resume`)
  },
}

export const cvEu: ResumeTemplate = {
  id: 'cv-eu',
  name: 'CV (UK and Europe)',
  description: 'A4, "Profile" and "Work experience" headings, numeric dates.',
  columns: 1,
  atsSafe: true,
  regions: ['UK', 'EU'],
  render(ctx) {
    const c = ctx.content
    const css = `${fontFaces(ctx.fontsDir, [
      { family: 'Source Sans 3', file: 'source-sans-3', weight: 400 },
      { family: 'Source Sans 3', file: 'source-sans-3', weight: 600 },
    ])}
body { font-family: 'Source Sans 3', Arial, sans-serif; font-size: 10.2pt; line-height: 1.42; color: #1a1d1b; padding: 18mm 18mm 16mm; }
header { display: flex; justify-content: space-between; align-items: flex-start; gap: 18pt; padding-bottom: 8pt; border-bottom: 1.2pt solid #0D2D20; }
h1 { font-size: 20pt; font-weight: 600; color: #0D2D20; line-height: 1.1; }
.headline { color: #4F6B48; margin-top: 2pt; }
.contact { flex: none; max-width: 55%; font-size: 9pt; text-align: right; }
.contact span { display: block; }
.auth { margin-top: 6pt; font-size: 9pt; color: #444; }
h2 { font-size: 11pt; font-weight: 600; color: #0D2D20; margin: 12pt 0 4pt; }
.entry { margin-bottom: 7pt; }
.role { display: flex; justify-content: space-between; gap: 10pt; }
.role .t { font-weight: 600; }
.dates { color: #444; font-size: 9.2pt; white-space: nowrap; }
.org { color: #444; }
ul.b li { position: relative; padding-left: 10pt; margin-top: 2pt; }
ul.b li::before { content: ''; position: absolute; left: 1pt; top: .62em; width: 3pt; height: 3pt; border-radius: 50%; background: #1a1d1b; }`
    const renamed = sections(ctx, { present: 'present', numeric: true }).replace('<h2>Summary</h2>', '<h2>Profile</h2>').replace('<h2>Experience</h2>', '<h2>Work experience</h2>')
    const body = `<header><div><h1>${esc(c.name)}</h1>${c.headline ? `<div class="headline">${esc(c.headline)}</div>` : ''}</div><div class="contact">${contactItems(c).map((x) => `<span>${x}</span>`).join('')}</div></header>${ctx.extras.workAuthorization ? `<p class="auth">${esc(ctx.extras.workAuthorization)}</p>` : ''}${renamed}`
    return page({ ...ctx, pageSize: 'A4' }, css, body, `${c.name} CV`)
  },
}

export const india: ResumeTemplate = {
  id: 'india',
  name: 'Resume (India)',
  description: 'A4, "Professional summary" and "Technical skills", with notice period in personal details.',
  columns: 1,
  atsSafe: true,
  regions: ['IN'],
  render(ctx) {
    const c = ctx.content
    const css = `${fontFaces(ctx.fontsDir, [
      { family: 'IBM Plex Sans', file: 'ibm-plex-sans', weight: 400 },
      { family: 'IBM Plex Sans', file: 'ibm-plex-sans', weight: 600 },
    ])}
body { font-family: 'IBM Plex Sans', Arial, sans-serif; font-size: 9.8pt; line-height: 1.42; color: #1a1d1b; padding: 16mm 16mm 14mm; }
h1 { font-size: 19pt; font-weight: 600; }
.headline { margin-top: 1pt; color: #444; }
.contact { margin-top: 5pt; font-size: 9pt; display: flex; flex-wrap: wrap; gap: 0 12pt; color: #333; }
h2 { font-size: 9.5pt; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; margin: 11pt 0 4pt; padding-bottom: 2pt; border-bottom: .8pt solid #1a1d1b; }
.entry { margin-bottom: 6pt; }
.role { display: flex; justify-content: space-between; gap: 10pt; }
.role .t { font-weight: 600; }
.dates { font-size: 9pt; color: #333; white-space: nowrap; }
.org { color: #333; }
ul.b li { position: relative; padding-left: 10pt; margin-top: 2pt; }
ul.b li::before { content: ''; position: absolute; left: 1pt; top: .62em; width: 3pt; height: 3pt; background: #1a1d1b; }
dl { display: grid; grid-template-columns: 1.4in 1fr; gap: 2pt 10pt; }
dt { color: #444; }`
    const main = sections(ctx)
      .replace('<h2>Summary</h2>', '<h2>Professional summary</h2>')
      .replace('<h2>Experience</h2>', '<h2>Work experience</h2>')
      .replace('<h2>Skills</h2>', '<h2>Technical skills</h2>')
    const details = [
      ['Location', c.contact.location],
      ['Notice period', ctx.extras.noticePeriod ?? ''],
      ['Work authorization', ctx.extras.workAuthorization ?? ''],
    ].filter(([, v]) => v)
    const body = `<header><h1>${esc(c.name)}</h1>${c.headline ? `<div class="headline">${esc(c.headline)}</div>` : ''}<div class="contact">${contactItems(c).map((x) => `<span>${x}</span>`).join('')}</div></header>${main}
${details.length ? `<section><h2>Personal details</h2><dl>${details.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></section>` : ''}`
    return page({ ...ctx, pageSize: 'A4' }, css, body, `${c.name} Resume`)
  },
}
