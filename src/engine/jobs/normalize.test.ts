import { describe, expect, it } from 'vitest'
import { cleanTitle, companyKey, contractTypeOf, employmentOf, isStaffingAgency, seniorityOf, titleKey } from './classify'
import { countryCode, distanceKm, parseLocation, resolvePlace } from './geo'
import { annualize, formatSalary, parseSalary } from './salary'

describe('parseSalary', () => {
  it.each([
    ['The base salary range is $120,000 - $150,000 per year.', { min: 120000, max: 150000, currency: 'USD', period: 'year' }],
    ['Compensation: $120k–$150k + equity', { min: 120000, max: 150000, currency: 'USD', period: 'year' }],
    ['Salary: 120-150k USD', { min: 120000, max: 150000, currency: 'USD', period: 'year' }],
    ['Gehalt: €60.000 – €75.000 brutto pro Jahr', { min: 60000, max: 75000, currency: 'EUR', period: 'year' }],
    ['£45,000 to £55,000 per annum', { min: 45000, max: 55000, currency: 'GBP', period: 'year' }],
    ['CTC: ₹18-24 LPA', { min: 1800000, max: 2400000, currency: 'INR', period: 'year' }],
    ['Budget 12,00,000 - 18,00,000 INR per annum', { min: 1200000, max: 1800000, currency: 'INR', period: 'year' }],
    ['Pay rate: $45 - $60 an hour on W2', { min: 45, max: 60, currency: 'USD', period: 'hour' }],
    ['Hourly rate $85/hr', { min: 85, max: null, currency: 'USD', period: 'hour' }],
    ['CAD 100K - 130K annually', { min: 100000, max: 130000, currency: 'CAD', period: 'year' }],
    ['Salary up to $200,000', { min: null, max: 200000, currency: 'USD', period: 'year' }],
    ['$8,000 - $10,000 per month', { min: 8000, max: 10000, currency: 'USD', period: 'month' }],
  ])('%s', (text, expected) => {
    expect(parseSalary(text)).toMatchObject(expected)
  })

  it.each([
    'We raised $50M in our Series B led by great investors.',
    'Benefits include a 401(k) with 4% match and 20 days off.',
    'Join a team of 120 engineers across 3 offices.',
    'Competitive salary and equity.',
    '',
  ])('ignores non-salary numbers: %s', (text) => {
    expect(parseSalary(text)).toBeNull()
  })

  it('annualizes and formats', () => {
    const s = parseSalary('$50 - $60 per hour')!
    expect(annualize(s)).toEqual({ min: 104000, max: 124800 })
    expect(formatSalary(parseSalary('$120,000 - $150,000 per year'))).toBe('$120K–$150K/yr')
  })
})

describe('locations', () => {
  it('resolves cities with regions and countries', () => {
    expect(resolvePlace('Austin, TX')).toMatchObject({ city: 'Austin', region: 'Texas', country: 'US' })
    expect(resolvePlace('London, UK')).toMatchObject({ city: 'London', country: 'GB' })
    expect(resolvePlace('London, Ontario, Canada')).toMatchObject({ city: 'London', country: 'CA' })
    expect(resolvePlace('Bangalore, India')).toMatchObject({ city: 'Bengaluru', country: 'IN' })
    expect(resolvePlace('NYC')).toMatchObject({ city: 'New York City', country: 'US' })
    expect(resolvePlace('Germany')).toMatchObject({ city: null, country: 'DE' })
    expect(resolvePlace('Portland, OR')).toMatchObject({ city: 'Portland', region: 'Oregon' })
  })

  it('does not read ambiguous two-letter words as countries or states', () => {
    expect(countryCode('in')).toBeNull()
    expect(countryCode('IN')).toBeNull()
    expect(countryCode('India')).toBe('IN')
    expect(countryCode('USA')).toBe('US')
  })

  it.each([
    ['Remote (US/Canada)', 'remote', ['US', 'CA'], false],
    ['Remote - EMEA', 'remote', 'emea', false],
    ['Remote, Anywhere', 'remote', [], true],
    ['Hybrid - 3 days in NYC', 'hybrid', [], false],
    ['San Francisco, CA', 'onsite', [], false],
    ['US-Remote', 'remote', ['US'], false],
    ['Remote in United States', 'remote', ['US'], false],
  ] as const)('%s', (text, remote, countries, global) => {
    const p = parseLocation(text)
    expect(p.remote).toBe(remote)
    if (countries === 'emea') expect(p.remoteCountries).toContain('DE')
    else expect([...p.remoteCountries].sort()).toEqual([...countries].sort())
    expect(p.remoteGlobal).toBe(global)
  })

  it('splits multiple places', () => {
    const p = parseLocation('London, UK; Berlin, Germany')
    expect(p.locations.map((l) => l.city)).toEqual(['London', 'Berlin'])
    const q = parseLocation('Toronto, ON / Vancouver, BC')
    expect(q.locations.map((l) => l.country)).toEqual(['CA', 'CA'])
  })

  it('keeps the office city for hybrid roles and uses hints', () => {
    const p = parseLocation('Hybrid - 3 days in NYC')
    expect(p.locations[0]).toMatchObject({ city: 'New York City', country: 'US' })
    expect(parseLocation('', { remote: 'remote', country: 'DE' }).remoteCountries).toEqual(['DE'])
    expect(parseLocation(null).remote).toBe('unknown')
  })

  it('computes distances', () => {
    const sf = resolvePlace('San Francisco, CA')
    const oak = resolvePlace('Oakland, CA')
    expect(distanceKm({ lat: sf.lat!, lon: sf.lon! }, { lat: oak.lat!, lon: oak.lon! })).toBeLessThan(20)
  })
})

describe('titles and classification', () => {
  it('cleans display titles and builds comparison keys', () => {
    expect(cleanTitle('Senior Backend Engineer (Remote)')).toBe('Senior Backend Engineer')
    expect(cleanTitle('Softwareentwickler (m/w/d)')).toBe('Softwareentwickler')
    expect(cleanTitle('Product Designer - Remote - US')).toBe('Product Designer')
    expect(titleKey('Sr. SWE II')).toBe('senior software engineer ii')
  })

  it.each([
    ['Software Engineer Intern', 'intern'],
    ['Junior Frontend Developer', 'junior'],
    ['Associate Product Manager', 'junior'],
    ['Associate Director, Finance', 'director'],
    ['Software Engineer II', 'mid'],
    ['Senior Data Scientist', 'senior'],
    ['Staff Engineer', 'staff'],
    ['Principal Architect', 'principal'],
    ['Engineering Manager', 'manager'],
    ['Product Manager', null],
    ['Tech Lead, Payments', 'lead'],
    ['Director of Engineering', 'director'],
    ['VP of Sales', 'executive'],
    ['Backend Engineer', null],
    ['Software Engineer L5', 'senior'],
  ] as const)('seniority of %s is %s', (title, level) => {
    expect(seniorityOf(title)).toBe(level)
  })

  it('detects employment and contract types', () => {
    expect(employmentOf('Full-time')).toBe('full_time')
    expect(employmentOf('Contract')).toBe('contract')
    expect(employmentOf('Intern')).toBe('internship')
    expect(employmentOf('', 'This is a contract role, W2 only, 6 months.')).toBe('contract')
    expect(employmentOf('', 'Great team.')).toBe('full_time')
    expect(contractTypeOf('Open to C2C candidates')).toBe('c2c')
    expect(contractTypeOf('W2 contract, hourly')).toBe('w2')
    expect(contractTypeOf('Full-time with benefits')).toBeNull()
  })

  it('detects staffing agencies and normalizes company names', () => {
    expect(isStaffingAgency('Apex Staffing Group')).toBe(true)
    expect(isStaffingAgency('Acme', 'We are hiring on behalf of our client, a fintech')).toBe(true)
    expect(isStaffingAgency('Stripe')).toBe(false)
    expect(companyKey('Acme, Inc.')).toBe(companyKey('ACME Incorporated'))
    expect(companyKey('Northwind Payments GmbH')).toBe('northwind payments')
  })
})
