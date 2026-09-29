import type { StyleIssue } from '../../shared/domain'

export type StyleKind = 'bullet' | 'summary' | 'letter' | 'email' | 'answer'

/**
 * Phrases recruiters read as AI-written or as filler. Kept in one place so the prompts and the checker agree.
 * Matching is case-insensitive on word boundaries.
 */
export const BANNED_PHRASES = [
  'i am writing to express my interest',
  'i am writing to apply',
  'i am excited to apply',
  'i am thrilled',
  "i'm thrilled",
  'i am eager to',
  'passionate about',
  'proven track record',
  'results-driven',
  'results driven',
  'detail-oriented',
  'team player',
  'fast-paced environment',
  'hit the ground running',
  'synergy',
  'synergies',
  'dynamic team',
  'delve',
  'tapestry',
  'testament to',
  'pivotal',
  'cutting-edge',
  'cutting edge',
  'game-changer',
  'game changer',
  'seamless',
  'seamlessly',
  'i believe i would be a great fit',
  'i believe i am a great fit',
  'would be a great fit',
  'look no further',
  'in today\'s',
  'ever-evolving',
  'ever evolving',
  'navigate the complexities',
  'elevate',
  'unlock',
  'supercharge',
  'embark',
  'honed my skills',
  'wealth of experience',
  'thank you for considering my application',
  'go-getter',
  'self-starter',
  'think outside the box',
  'rockstar',
  'ninja',
]
/** "leverage" is fine as a noun ("negotiation leverage") but not as a verb. */
const LEVERAGE_VERB = /\b(leverag(e|ed|es|ing))\s+(my|our|the|their|his|her|a|an|cutting|modern|existing|new|data|ai|this|these|those)\b/i
const NOT_ONLY = /\bnot only\b[^.]{0,80}\bbut also\b/i
const NOT_JUST = /\b(it['’]s|this is|it is)\s+not\s+just\b/i
const PRONOUN = /\b(i|me|my|mine|we|our|us)\b/i
const IRREGULAR_PAST = new Set([
  'built', 'led', 'ran', 'wrote', 'grew', 'made', 'won', 'cut', 'drove', 'taught', 'set', 'brought', 'sold', 'spoke', 'took', 'rebuilt', 'rewrote', 'held', 'kept', 'met', 'began',
  'chose', 'found', 'gave', 'got', 'saw', 'shipped', 'thought', 'overhauled', 'oversaw', 'undertook', 'drew', 'flew', 'fought', 'hid', 'lent', 'lost', 'paid', 'put', 'shot', 'shut', 'split', 'spun', 'stood', 'struck', 'swept', 'told', 'understood', 'upheld', 'withdrew', 'won', 'bought', 'caught', 'dealt', 'fed', 'felt', 'forecast', 'heard', 'hit', 'laid', 'left', 'meant', 'quit', 'read', 'rode', 'rose', 'sent', 'shook', 'sought', 'spent', 'stole', 'swam', 'sang', 'slept', 'broadcast', 'co-led', 'co-founded', 'co-authored', 'redid', 'redrew', 'reran', 'retook', 'overran', 'outgrew', 'underwent',
])
const PRESENT_VERB = /^(build|lead|run|write|grow|make|own|manage|design|develop|drive|create|maintain|support|deliver|ship|work|partner|mentor|oversee|architect|analy[sz]e|implement|coordinate|operate|plan|handle|help|teach|sell|launch|scale|improve|reduce|increase|define|establish|automate|test|monitor|research|review|advise|serve|train|guide|report|negotiate|organi[sz]e|prepare|produce|process|provide|conduct|collaborate|facilitate|direct)s?$/i

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean)

/** Checks one piece of generated text against the rules for its kind. */
export function styleCheck(text: string, kind: StyleKind, o: { currentRole?: boolean } = {}): StyleIssue[] {
  const issues: StyleIssue[] = []
  const lower = text.toLowerCase()
  const add = (rule: string, excerpt: string, message: string) => issues.push({ rule, excerpt, message })
  for (const phrase of BANNED_PHRASES) {
    const i = lower.search(new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['’]")}\\b`))
    if (i >= 0) add('banned_phrase', text.slice(i, i + phrase.length), `"${text.slice(i, i + phrase.length)}" reads as filler. Say the specific thing instead.`)
  }
  const lev = LEVERAGE_VERB.exec(text)
  if (lev) add('banned_phrase', lev[0], '"Leverage" as a verb reads as filler. Use "use" or name the action.')
  const np = NOT_ONLY.exec(text) ?? NOT_JUST.exec(text)
  if (np) add('parallelism', np[0], 'Drop the "not only... but also" framing and state the point directly.')
  const dashes = (text.match(/—/g) ?? []).length
  if ((kind === 'letter' || kind === 'email' || kind === 'answer') && dashes > 0) add('em_dash', '—', 'Use a comma, colon or period instead of an em dash.')
  if (kind === 'bullet' && dashes > 0) add('em_dash', '—', 'Avoid em dashes in resume lines.')
  const bangs = (text.match(/!/g) ?? []).length
  if ((kind === 'bullet' || kind === 'summary' || kind === 'letter' || kind === 'answer') && bangs > 0) add('exclamation', '!', 'No exclamation marks.')
  if (kind === 'email' && bangs > 1) add('exclamation', '!', 'At most one exclamation mark in an email.')

  if (kind === 'bullet') {
    const first = (words(text)[0] ?? '').toLowerCase().replace(/[^a-z-]/g, '')
    const past = first.endsWith('ed') || IRREGULAR_PAST.has(first)
    const present = PRESENT_VERB.test(first)
    if (o.currentRole ? !(past || present) : !past) add('verb_start', words(text)[0] ?? '', o.currentRole ? 'Start with an action verb.' : 'Start with a past-tense action verb.')
    if (PRONOUN.test(text)) add('pronoun', PRONOUN.exec(text)![0], 'Resume lines leave out "I", "my" and "we".')
    if (words(text).length > 40) add('length', text.slice(0, 40), 'Keep a resume line under 40 words.')
  }
  if (kind === 'letter') {
    const n = words(text).length
    if (n < 150 || n > 320) add('length', `${n} words`, `Cover letters work best at 180 to 280 words; this one has ${n}.`)
    const firstSentence = /^[^.?!]*[.?!]/.exec(text.trim())?.[0] ?? ''
    if (firstSentence.trim().endsWith('?')) add('opening', firstSentence, 'Open with a statement, not a question.')
  }
  if (kind === 'email' && words(text).length > 140) add('length', `${words(text).length} words`, 'Outreach emails should stay under 120 words.')
  return issues
}

/** Resume-level rules: opening verbs repeated more than twice. */
export function resumeStyleCheck(bullets: string[]): StyleIssue[] {
  const counts = new Map<string, number>()
  for (const b of bullets) {
    const v = (words(b)[0] ?? '').toLowerCase()
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  return [...counts]
    .filter(([v, n]) => v && n > 2)
    .map(([v, n]) => ({ rule: 'repeated_verb', excerpt: v, message: `${n} lines start with "${v}". Vary the opening verbs.` }))
}

/** Text for prompts: the same rules the checker enforces, stated as instructions. */
export const STYLE_RULES_FOR_PROMPTS = [
  'Write plainly and specifically, like a competent person writing quickly and honestly.',
  `Never use these phrases: ${BANNED_PHRASES.slice(0, 32).map((p) => `"${p}"`).join(', ')}.`,
  'Do not use "leverage" as a verb, "not only... but also", or "it\'s not just X, it\'s Y".',
  'No em dashes and no exclamation marks.',
].join('\n')
