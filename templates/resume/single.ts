import { type ResumeTemplate, type TemplateContext, bullets, contactItems, dateRange, esc, fontFaces, join2, page } from './shared'

function sections(ctx: TemplateContext, o: { present?: string; numeric?: boolean; roleLayout?: 'split' | 'inline' } = {}): string {
  const c = ctx.content
  const out: string[] = []
  if (c.summary.text) out.push(`<section><h2>Summary</h2><p class="summary">${esc(c.summary.text)}</p></section>`)
  if (c.work.length) {
    out.push(
      `<section><h2>Experience</h2>${c.work
        .map(
          (w) => `<div class="entry">
  <div class="role"><span class="t">${esc(w.title)}</span><span class="dates">${esc(dateRange(w.start, w.end, o))}</span></div>
  <div class="org">${esc(join2(w.company, w.location))}</div>
  ${bullets(w.bullets)}
</div>`,
        )
        .join('')}</section>`,
    )
  }
  if (c.projects.length) {
    out.push(
      `<section><h2>Projects</h2>${c.projects
        .map((p) => `<div class="entry"><div class="role"><span class="t">${esc(p.name)}</span><span class="dates">${esc(p.url.replace(/^https?:\/\//, ''))}</span></div>${bullets(p.bullets)}</div>`)
        .join('')}</section>`,
    )
  }
  if (c.education.length) {
    out.push(
      `<section><h2>Education</h2>${c.education
        .map(
          (e) => `<div class="entry"><div class="role"><span class="t">${esc(join2(e.degree, e.field, ' in '))}</span><span class="dates">${esc(dateRange(e.start, e.end || null, o).replace(/^ – /, ''))}</span></div>
  <div class="org">${esc(e.institution)}${e.grade ? `, ${esc(e.grade)}` : ''}</div></div>`,
        )
        .join('')}</section>`,
    )
  }
  if (c.skills.length) out.push(`<section><h2>Skills</h2><p class="skills">${c.skills.map(esc).join(', ')}</p></section>`)
  if (c.certifications.length) out.push(`<section><h2>Certifications</h2><ul class="plain">${c.certifications.map((x) => `<li>${esc(x.name)}${x.issuer ? `, ${esc(x.issuer)}` : ''}${x.date ? ` (${esc(x.date)})` : ''}</li>`).join('')}</ul></section>`)
  if (c.languages.length) out.push(`<section><h2>Languages</h2><p>${c.languages.map((l) => esc(l.fluency ? `${l.name} (${l.fluency})` : l.name)).join(', ')}</p></section>`)
  return out.join('\n')
}

const BULLET_DOT = `ul.b li { position: relative; padding-left: 11pt; margin-top: 2.2pt; }
ul.b li::before { content: ''; position: absolute; left: 2pt; top: 0.6em; width: 3pt; height: 3pt; border-radius: 50%; background: currentColor; opacity: .75; }`

export const classic: ResumeTemplate = {
  id: 'classic',
  name: 'Classic',
  description: 'Serif, centered header, small-caps headings. Reads well everywhere.',
  columns: 1,
  atsSafe: true,
  regions: ['US', 'CA', 'UK', 'EU', 'IN', 'AU', 'OTHER'],
  render(ctx) {
    const c = ctx.content
    const css = `${fontFaces(ctx.fontsDir, [
      { family: 'Source Serif 4', file: 'source-serif-4', weight: 400 },
      { family: 'Source Serif 4', file: 'source-serif-4', weight: 400, style: 'italic' },
      { family: 'Source Serif 4', file: 'source-serif-4', weight: 600 },
    ])}
body { font-family: 'Source Serif 4', Georgia, serif; font-size: 10.4pt; line-height: 1.38; color: #1d1d1b; padding: 0.6in 0.72in; }
header { text-align: center; margin-bottom: 10pt; }
h1 { font-size: 21pt; font-weight: 600; letter-spacing: .01em; }
.headline { font-style: italic; font-size: 11pt; color: #3d3d3a; margin-top: 1pt; }
.contact { font-size: 9.4pt; color: #3d3d3a; margin-top: 5pt; }
.contact span + span::before { content: '·'; margin: 0 6pt; color: #8a8a85; }
h2 { font-size: 10.5pt; font-weight: 600; font-variant: small-caps; letter-spacing: .04em; border-bottom: .6pt solid #9a9a94; padding-bottom: 1.5pt; margin: 11pt 0 5pt; }
.entry { margin-bottom: 7pt; }
.role { display: flex; justify-content: space-between; align-items: baseline; gap: 12pt; }
.role .t { font-weight: 600; }
.dates { font-size: 9.4pt; color: #3d3d3a; white-space: nowrap; font-variant-numeric: tabular-nums; }
.org { font-style: italic; color: #3d3d3a; }
${BULLET_DOT}
.summary, .skills { margin-top: 1pt; }
ul.plain li { margin-top: 1.5pt; }`
    const body = `<header><h1>${esc(c.name)}</h1>${c.headline ? `<div class="headline">${esc(c.headline)}</div>` : ''}<div class="contact">${contactItems(c).map((x) => `<span>${x}</span>`).join('')}</div></header>${sections(ctx)}`
    return page(ctx, css, body, `${c.name} Resume`)
  },
}

export const modern: ResumeTemplate = {
  id: 'modern',
  name: 'Modern',
  description: 'Sans serif, left-aligned, quiet green accents.',
  columns: 1,
  atsSafe: true,
  regions: ['US', 'CA', 'UK', 'EU', 'IN', 'AU', 'OTHER'],
  render(ctx) {
    const c = ctx.content
    const css = `${fontFaces(ctx.fontsDir, [
      { family: 'IBM Plex Sans', file: 'ibm-plex-sans', weight: 400 },
      { family: 'IBM Plex Sans', file: 'ibm-plex-sans', weight: 500 },
      { family: 'IBM Plex Sans', file: 'ibm-plex-sans', weight: 600 },
    ])}
body { font-family: 'IBM Plex Sans', Arial, sans-serif; font-size: 9.8pt; line-height: 1.45; color: #1C2420; padding: 0.55in 0.62in; }
header { margin-bottom: 8pt; }
h1 { font-size: 23pt; font-weight: 600; color: #0D2D20; letter-spacing: -.01em; line-height: 1.1; }
.headline { font-size: 11pt; color: #4F6B48; margin-top: 3pt; font-weight: 500; }
.contact { margin-top: 7pt; font-size: 8.8pt; color: #4b534e; display: flex; flex-wrap: wrap; gap: 1pt 13pt; }
h2 { font-size: 8.2pt; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: #4F6B48; margin: 13pt 0 5pt; }
.entry { margin-bottom: 8pt; }
.role { display: flex; justify-content: space-between; align-items: baseline; gap: 12pt; }
.role .t { font-weight: 600; font-size: 10.2pt; }
.dates { font-size: 8.8pt; color: #5B635E; white-space: nowrap; font-variant-numeric: tabular-nums; }
.org { color: #4b534e; }
ul.b li { position: relative; padding-left: 11pt; margin-top: 2.4pt; }
ul.b li::before { content: ''; position: absolute; left: 1pt; top: .74em; width: 5pt; height: 1.1pt; background: #64865C; }
ul.plain li { margin-top: 1.5pt; }`
    const body = `<header><h1>${esc(c.name)}</h1>${c.headline ? `<div class="headline">${esc(c.headline)}</div>` : ''}<div class="contact">${contactItems(c).map((x) => `<span>${x}</span>`).join('')}</div></header>${sections(ctx)}`
    return page(ctx, css, body, `${c.name} Resume`)
  },
}

export const compact: ResumeTemplate = {
  id: 'compact',
  name: 'Compact',
  description: 'Tighter spacing to keep long experience on one page.',
  columns: 1,
  atsSafe: true,
  regions: ['US', 'CA', 'UK', 'EU', 'IN', 'AU', 'OTHER'],
  render(ctx) {
    const c = ctx.content
    const css = `${fontFaces(ctx.fontsDir, [
      { family: 'Source Sans 3', file: 'source-sans-3', weight: 400 },
      { family: 'Source Sans 3', file: 'source-sans-3', weight: 600 },
      { family: 'Source Sans 3', file: 'source-sans-3', weight: 700 },
    ])}
body { font-family: 'Source Sans 3', Arial, sans-serif; font-size: 9.6pt; line-height: 1.3; color: #1a1a1a; padding: 0.42in 0.5in; }
header { display: flex; justify-content: space-between; align-items: flex-end; gap: 16pt; border-bottom: 1pt solid #1a1a1a; padding-bottom: 5pt; }
h1 { font-size: 18pt; font-weight: 700; line-height: 1.05; }
.headline { font-size: 10pt; color: #444; }
.contact { font-size: 8.8pt; text-align: right; color: #333; }
.contact span { display: block; }
h2 { font-size: 9.2pt; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; margin: 8pt 0 3pt; }
.entry { margin-bottom: 5pt; }
.role { display: flex; justify-content: space-between; gap: 10pt; }
.role .t { font-weight: 600; }
.dates { font-size: 8.8pt; color: #333; white-space: nowrap; }
.org { color: #333; }
${BULLET_DOT}
ul.b li { margin-top: 1pt; }
ul.plain li { margin-top: 1pt; }`
    const body = `<header><div><h1>${esc(c.name)}</h1>${c.headline ? `<div class="headline">${esc(c.headline)}</div>` : ''}</div><div class="contact">${contactItems(c).map((x) => `<span>${x}</span>`).join('')}</div></header>${sections(ctx)}`
    return page(ctx, css, body, `${c.name} Resume`)
  },
}

export const technical: ResumeTemplate = {
  id: 'technical',
  name: 'Technical',
  description: 'Skills up front, monospace tool names, projects prominent.',
  columns: 1,
  atsSafe: true,
  regions: ['US', 'CA', 'UK', 'EU', 'IN', 'AU', 'OTHER'],
  render(ctx) {
    const c = ctx.content
    const css = `${fontFaces(ctx.fontsDir, [
      { family: 'IBM Plex Sans', file: 'ibm-plex-sans', weight: 400 },
      { family: 'IBM Plex Sans', file: 'ibm-plex-sans', weight: 600 },
      { family: 'IBM Plex Mono', file: 'ibm-plex-mono', weight: 400 },
    ])}
body { font-family: 'IBM Plex Sans', Arial, sans-serif; font-size: 9.7pt; line-height: 1.42; color: #16191a; padding: 0.5in 0.6in; }
h1 { font-size: 20pt; font-weight: 600; }
.headline { color: #3f4648; margin-top: 1pt; }
.contact { font-family: 'IBM Plex Mono', monospace; font-size: 8.4pt; color: #3f4648; margin-top: 5pt; display: flex; flex-wrap: wrap; gap: 0 12pt; }
.stack { margin-top: 9pt; font-family: 'IBM Plex Mono', monospace; font-size: 8.6pt; line-height: 1.6; }
h2 { font-size: 9pt; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; margin: 12pt 0 4pt; padding-bottom: 2pt; border-bottom: .6pt solid #c9ccc9; }
.entry { margin-bottom: 7pt; }
.role { display: flex; justify-content: space-between; gap: 12pt; }
.role .t { font-weight: 600; }
.dates { font-family: 'IBM Plex Mono', monospace; font-size: 8.4pt; color: #3f4648; white-space: nowrap; }
.org { color: #3f4648; }
${BULLET_DOT}
.skills { font-family: 'IBM Plex Mono', monospace; font-size: 8.6pt; }`
    const skillsFirst = { ...ctx, content: { ...c, skills: [] } }
    const body = `<header><h1>${esc(c.name)}</h1>${c.headline ? `<div class="headline">${esc(c.headline)}</div>` : ''}<div class="contact">${contactItems(c).map((x) => `<span>${x}</span>`).join('')}</div></header>
${c.skills.length ? `<section><h2>Skills</h2><p class="stack">${c.skills.map(esc).join(' · ')}</p></section>` : ''}
${sections(skillsFirst)}`
    return page(ctx, css, body, `${c.name} Resume`)
  },
}

export { sections }
