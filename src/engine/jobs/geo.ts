import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { JobLocation, Remote } from '../../shared/domain'
import { fold } from '../util/text'

type City = { name: string; country: string; admin1: string; lat: number; lon: number; pop: number }

let cities: Map<string, City[]> | null = null
let dataDir = join(process.cwd(), 'data')

/** Where data/cities.json lives (the resources folder in packaged builds). */
export function setDataDir(dir: string): void {
  dataDir = dir
  cities = null
}

function gazetteer(): Map<string, City[]> {
  if (cities) return cities
  const raw = JSON.parse(readFileSync(join(dataDir, 'cities.json'), 'utf8')) as { rows: [string, string, string, string, number, number, number][] }
  cities = new Map()
  for (const [name, ascii, country, admin1, lat, lon, pop] of raw.rows) {
    const c: City = { name, country, admin1, lat, lon, pop }
    for (const key of new Set([fold(name), fold(ascii || name)])) {
      const list = cities.get(key)
      if (list) list.push(c)
      else cities.set(key, [c])
    }
  }
  return cities
}

// Countries: every ISO 3166 code via Intl, plus common aliases.
const COUNTRY_BY_NAME = new Map<string, string>()
const COUNTRY_CODES = new Set<string>()
{
  const names = new Intl.DisplayNames(['en'], { type: 'region' })
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b)
      let name: string | undefined
      try {
        name = names.of(code)
      } catch {
        name = undefined
      }
      // Deprecated codes (UK, SU, YU) share a name with the current one; only the current code counts.
      if (name && name !== code && !/^Unknown/.test(name) && new Intl.Locale(`und-${code}`).region === code) {
        COUNTRY_BY_NAME.set(fold(name), code)
        COUNTRY_CODES.add(code)
      }
    }
  }
  const aliases: Record<string, string> = {
    usa: 'US', 'u.s.': 'US', 'u.s.a.': 'US', us: 'US', 'united states of america': 'US', america: 'US',
    uk: 'GB', 'u.k.': 'GB', england: 'GB', scotland: 'GB', wales: 'GB', 'northern ireland': 'GB', 'great britain': 'GB', britain: 'GB',
    uae: 'AE', 'south korea': 'KR', korea: 'KR', 'czech republic': 'CZ', holland: 'NL', deutschland: 'DE', 'the netherlands': 'NL',
    russia: 'RU', vietnam: 'VN', turkey: 'TR', turkiye: 'TR', 'ivory coast': 'CI', 'hong kong sar': 'HK', macau: 'MO',
  }
  for (const [k, v] of Object.entries(aliases)) COUNTRY_BY_NAME.set(k, v)
}

const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
  LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
  MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
}
const CA_PROVINCES: Record<string, string> = {
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick', NL: 'Newfoundland and Labrador', NS: 'Nova Scotia',
  ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec', SK: 'Saskatchewan', NT: 'Northwest Territories', NU: 'Nunavut', YT: 'Yukon',
}
const REGION_NAME = new Map<string, { country: string; name: string }>()
for (const [code, name] of Object.entries(US_STATES)) {
  REGION_NAME.set(fold(name), { country: 'US', name })
  REGION_NAME.set(code.toLowerCase(), { country: 'US', name })
}
for (const [code, name] of Object.entries(CA_PROVINCES)) {
  REGION_NAME.set(fold(name), { country: 'CA', name })
  REGION_NAME.set(code.toLowerCase(), { country: 'CA', name })
}
// Two-letter codes that are also common words or country codes must not be read as states on their own.
const AMBIGUOUS_REGION_CODES = new Set(['in', 'or', 'me', 'hi', 'ok', 'de', 'la', 'ma', 'pa', 'co', 'id', 'al', 'ga', 'mt', 'ne', 'on', 'pe'])

const CITY_ALIASES: Record<string, string> = {
  nyc: 'new york city', 'new york': 'new york city', sf: 'san francisco', 'sf bay area': 'san francisco', 'bay area': 'san francisco',
  'san francisco bay area': 'san francisco', la: 'los angeles', bangalore: 'bengaluru', gurgaon: 'gurugram', bombay: 'mumbai',
  'washington dc': 'washington', 'washington d.c.': 'washington', dc: 'washington', 'd.c.': 'washington', 'greater london': 'london',
  'tel aviv': 'tel aviv', 'tel-aviv': 'tel aviv', 'ho chi minh': 'ho chi minh city', saigon: 'ho chi minh city', 'new delhi': 'new delhi',
  'frankfurt am main': 'frankfurt am main', frankfurt: 'frankfurt am main', munchen: 'munich', 'the hague': 'the hague', 'st. louis': 'saint louis',
}

/** Remote regions as country sets, for matching "Remote (EMEA)" against a user's countries. */
const EU = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']
const EUROPE = [...EU, 'GB', 'CH', 'NO', 'IS', 'LI', 'UA', 'RS', 'BA', 'ME', 'MK', 'AL', 'MD']
export const REGIONS: Record<string, string[]> = {
  eu: EU,
  europe: EUROPE,
  emea: [...EUROPE, 'AE', 'SA', 'IL', 'TR', 'EG', 'ZA', 'NG', 'KE', 'MA', 'QA', 'KW', 'BH', 'OM', 'JO', 'GH', 'TN'],
  'north america': ['US', 'CA', 'MX'],
  namer: ['US', 'CA', 'MX'],
  americas: ['US', 'CA', 'MX', 'BR', 'AR', 'CL', 'CO', 'PE', 'UY', 'CR', 'PA', 'EC', 'GT', 'DO'],
  latam: ['MX', 'BR', 'AR', 'CL', 'CO', 'PE', 'UY', 'CR', 'PA', 'EC', 'GT', 'DO', 'BO', 'PY', 'VE', 'SV', 'HN', 'NI'],
  'latin america': ['MX', 'BR', 'AR', 'CL', 'CO', 'PE', 'UY', 'CR', 'PA', 'EC', 'GT', 'DO', 'BO', 'PY', 'VE', 'SV', 'HN', 'NI'],
  apac: ['AU', 'NZ', 'SG', 'JP', 'KR', 'IN', 'ID', 'MY', 'PH', 'TH', 'VN', 'HK', 'TW', 'CN', 'PK', 'BD', 'LK'],
  asia: ['SG', 'JP', 'KR', 'IN', 'ID', 'MY', 'PH', 'TH', 'VN', 'HK', 'TW', 'CN', 'PK', 'BD', 'LK', 'NP'],
  anz: ['AU', 'NZ'],
  dach: ['DE', 'AT', 'CH'],
  nordics: ['SE', 'NO', 'DK', 'FI', 'IS'],
  benelux: ['BE', 'NL', 'LU'],
  uk: ['GB'],
}
const GLOBAL = /\b(anywhere|worldwide|global(ly)?|international|any location|all locations|world ?wide)\b/i

export function countryCode(text: string): string | null {
  const t = fold(text).replace(/\.$/, '')
  if (!t) return null
  const byName = COUNTRY_BY_NAME.get(t)
  if (byName) return byName
  if (/^[a-z]{2}$/.test(t) && COUNTRY_CODES.has(t.toUpperCase()) && !AMBIGUOUS_REGION_CODES.has(t)) return t.toUpperCase()
  return null
}

export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}

function findCity(name: string, country: string | null, region: string | null): City | null {
  const key = CITY_ALIASES[fold(name)] ?? fold(name)
  const all = gazetteer().get(key)
  if (!all?.length) return null
  let list = all
  if (country) list = list.filter((c) => c.country === country)
  if (region) {
    const inRegion = list.filter((c) => fold(c.admin1) === fold(region))
    if (inRegion.length) list = inRegion
  }
  if (!list.length) return null
  return list.reduce((a, b) => (b.pop > a.pop ? b : a))
}

export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(h))
}

/** Resolves one place such as "Austin, TX", "London, UK", "Bengaluru, Karnataka, India" or "Germany". */
export function resolvePlace(text: string, countryHint: string | null = null): JobLocation {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  const parts = cleaned.split(',').map((p) => p.trim()).filter(Boolean)
  let country: string | null = null
  let region: string | null = null
  const rest: string[] = []
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]!
    if (!country && i === parts.length - 1 && countryCode(p)) {
      country = countryCode(p)
      continue
    }
    const r = REGION_NAME.get(fold(p))
    if (!region && r && (i > 0 || parts.length === 1) && (!AMBIGUOUS_REGION_CODES.has(fold(p)) || i > 0)) {
      region = r.name
      country ??= r.country
      continue
    }
    rest.unshift(p)
  }
  if (!country && countryHint) country = countryHint
  const cityName = rest[0] ?? ''
  const city = cityName ? findCity(cityName, country, region) : null
  if (city) {
    return { text: cleaned, city: city.name, region: region ?? (city.admin1 || null), country: city.country, lat: city.lat, lon: city.lon }
  }
  if (cityName && !country && !region) {
    // A lone word might be a country ("Germany") or a region ("EMEA").
    const c = countryCode(cityName)
    if (c) return { text: cleaned, city: null, region: null, country: c, lat: null, lon: null }
  }
  return { text: cleaned, city: cityName && !region && !country ? null : cityName || null, region, country, lat: null, lon: null }
}

export type ParsedLocation = { locations: JobLocation[]; remote: Remote; remoteCountries: string[]; remoteGlobal: boolean }

/**
 * Parses posting location text into places, the workplace type, and which countries a remote role accepts.
 * Examples: "Remote (US/Canada)", "Hybrid - 3 days in NYC", "London, UK; Remote", "Berlin or Munich, Germany".
 */
export function parseLocation(text: string | null | undefined, hint: { remote?: Remote | undefined; country?: string | null | undefined } = {}): ParsedLocation {
  const raw = (text ?? '').replace(/\s+/g, ' ').trim()
  let remote: Remote = hint.remote ?? 'unknown'
  const remoteCountries = new Set<string>()
  let remoteGlobal = false
  if (/\bhybrid\b/i.test(raw)) remote = 'hybrid'
  else if (/\b(remote|work from home|wfh|distributed|telecommute|virtual)\b/i.test(raw) || GLOBAL.test(raw)) remote = hint.remote === 'hybrid' ? 'hybrid' : 'remote'
  else if (raw && remote === 'unknown') remote = 'onsite'

  const segments = raw
    .replace(/\((.*?)\)/g, '; $1;')
    .split(/\s*(?:;|\||\n|\s\/\s|\bor\b|•)\s*/i)
    .flatMap((s) => (/^[^,]*\/[^,]*$/.test(s) && !/\bhttps?:/.test(s) ? s.split('/') : [s]))
    .map((s) =>
      s
        .replace(/\b(fully |100% )?(remote|hybrid|on-?site|in-?office|office|work from home|wfh|distributed|telecommute|virtual)\b(\s*(first|friendly|only|eligible|possible|option(al)?))?/gi, ' ')
        .replace(/\b\d+\s*(days?|x)\s*(a|per)?\s*(week|wk)?\b/gi, ' ')
        .replace(/\b(in|within|based|from|only|anywhere in|must (live|reside) in|time ?zones?|multiple locations|locations?)\b/gi, ' ')
        .replace(/[-–—:]+/g, ' ')
        .replace(/\s+,/g, ',')
        .replace(/^[\s,]+|[\s,]+$/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim(),
    )
    .filter((s) => s.length > 1)

  const locations: JobLocation[] = []
  for (const seg of segments) {
    const key = fold(seg)
    if (GLOBAL.test(seg)) {
      remoteGlobal = true
      continue
    }
    const region = REGIONS[key]
    if (region) {
      for (const c of region) remoteCountries.add(c)
      continue
    }
    const loc = resolvePlace(seg, hint.country ?? null)
    if (!loc.country && !loc.city && !loc.region) continue
    if (remote === 'remote' && !loc.city) {
      if (loc.country) remoteCountries.add(loc.country)
      continue
    }
    locations.push(loc)
    if (remote === 'remote' && loc.country) remoteCountries.add(loc.country)
  }
  if (remote === 'remote' && remoteCountries.size === 0 && hint.country) remoteCountries.add(hint.country)
  return { locations, remote, remoteCountries: [...remoteCountries], remoteGlobal }
}
