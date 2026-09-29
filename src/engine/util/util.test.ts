import { describe, expect, it } from 'vitest'
import { csvObjects, parseCsv, toCsv } from './csv'
import { decodeEntities, htmlToMarkdown, htmlToText } from './html'
import { coverage, fold, isPresent, monthsBetween, normalizeMonth } from './text'
import { makeZip } from '../test/harness'
import { readZip } from './zip'

describe('readZip', () => {
  it('reads deflated entries and filters by name', () => {
    const zip = makeZip({ 'Positions.csv': 'a,b\n1,2', 'Skills.csv': 'Name\nGo' })
    const all = readZip(zip)
    expect(all.map((e) => e.name)).toEqual(['Positions.csv', 'Skills.csv'])
    expect(all[1]!.data.toString()).toBe('Name\nGo')
    expect(readZip(zip, (n) => n.startsWith('Skills')).length).toBe(1)
  })
  it('rejects non-zip input', () => {
    expect(() => readZip(Buffer.from('hello world, definitely not a zip file'))).toThrow(/Not a ZIP/)
  })
})

describe('csv', () => {
  it('parses quotes, doubled quotes, embedded newlines, CRLF and BOM', () => {
    const text = '﻿Name,Description\r\n"Acme, Inc.","Line one\nline ""two"""\r\nBeta,plain\r\n'
    expect(parseCsv(text)).toEqual([
      ['Name', 'Description'],
      ['Acme, Inc.', 'Line one\nline "two"'],
      ['Beta', 'plain'],
    ])
  })
  it('skips preamble lines until the expected header', () => {
    const text = 'Notes:\n"This export was generated..."\n\nFirst Name,Last Name\nAna,Silva\n'
    expect(csvObjects(text, 'First Name')).toEqual([{ 'First Name': 'Ana', 'Last Name': 'Silva' }])
  })
  it('escapes output and neutralizes formula injection', () => {
    expect(toCsv([['=HYPERLINK("x")', 'a,b', 'ok']])).toBe(`"'=HYPERLINK(""x"")","a,b",ok\r\n`)
  })
})

describe('dates', () => {
  it.each([
    ['Jan 2020', '2020-01'],
    ['September 2019', '2019-09'],
    ['Sept. 2019', '2019-09'],
    ['03/2021', '2021-03'],
    ['2021-3', '2021-03'],
    ['2021-03-15', '2021-03'],
    ['2018', '2018'],
    ['sometime', ''],
    ['13/2020', ''],
  ])('normalizeMonth(%s) = %s', (input, out) => expect(normalizeMonth(input)).toBe(out))

  it('recognizes present and counts months inclusively', () => {
    expect(isPresent('Present')).toBe(true)
    expect(isPresent('2020')).toBe(false)
    expect(monthsBetween('2020-01', '2020-12')).toBe(12)
    expect(monthsBetween('2020', '2021')).toBe(13)
  })
})

describe('text', () => {
  it('folds accents and punctuation for comparison', () => {
    expect(fold('  Café—Ops, Inc.! ')).toBe('cafe ops inc.')
    expect(coverage('Led a team of 5', 'I led a team of 5 engineers')).toBe(1)
    expect(coverage('Managed budgets', 'Wrote code')).toBe(0)
  })
})

describe('html', () => {
  it('converts escaped Greenhouse HTML to Markdown with lists and headings', () => {
    const escaped = '&lt;h2&gt;About&lt;/h2&gt;&lt;p&gt;We build &amp;amp; ship.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Go&lt;/li&gt;&lt;li&gt;&lt;strong&gt;SQL&lt;/strong&gt;&lt;/li&gt;&lt;/ul&gt;'
    expect(htmlToMarkdown(escaped)).toBe('### About\n\nWe build & ship.\n\n- Go\n- **SQL**')
  })
  it('drops scripts, keeps links, decodes numeric entities', () => {
    const md = htmlToMarkdown('<p>Apply <a href="https://x.com/j">here</a><script>alert(1)</script> &#8212; now</p>')
    expect(md).toBe('Apply [here](https://x.com/j) — now')
    expect(htmlToText('<p><b>Bold</b> <a href="https://a.b">link</a></p>')).toBe('Bold link')
    expect(decodeEntities('&#x1F600;&bogus;')).toBe('😀&bogus;')
  })
})
