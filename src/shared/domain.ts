import { z } from 'zod'

// ---------------------------------------------------------------------------
// Profile (the fact bank). Every item has a stable id so tailored documents can cite it.

const str = z.string().default('')

export const BulletSchema = z.object({ id: z.string(), text: z.string() })
export type Bullet = z.infer<typeof BulletSchema>

export const WorkSchema = z.object({
  id: z.string(),
  company: z.string(),
  title: z.string(),
  location: str,
  /** YYYY-MM or YYYY */
  start: str,
  /** null means current role */
  end: z.string().nullable().default(null),
  summary: str,
  bullets: z.array(BulletSchema).default([]),
  skills: z.array(z.string()).default([]),
})
export type Work = z.infer<typeof WorkSchema>

export const EducationSchema = z.object({
  id: z.string(),
  institution: z.string(),
  degree: str,
  field: str,
  start: str,
  end: str,
  grade: str,
  bullets: z.array(BulletSchema).default([]),
})
export type Education = z.infer<typeof EducationSchema>

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: str,
  description: str,
  bullets: z.array(BulletSchema).default([]),
  skills: z.array(z.string()).default([]),
})
export type Project = z.infer<typeof ProjectSchema>

export const SkillSchema = z.object({ name: z.string(), years: z.number().nullable().default(null), category: str })
export type Skill = z.infer<typeof SkillSchema>

export const CertificationSchema = z.object({ id: z.string(), name: z.string(), issuer: str, date: str, url: str })
export const LanguageSchema = z.object({ name: z.string(), fluency: str })
export const AwardSchema = z.object({ id: z.string(), title: z.string(), awarder: str, date: str, summary: str })
export const LinkSchema = z.object({ label: z.string(), url: z.string() })

export const MoneySchema = z.object({
  amount: z.number().nonnegative(),
  currency: z.string().length(3),
  period: z.enum(['year', 'month', 'hour']),
})
export type Money = z.infer<typeof MoneySchema>

export const WorkAuthSchema = z.object({
  country: z.string().length(2),
  authorized: z.boolean(),
  needsSponsorship: z.boolean(),
})

/** EEO answers: an empty string means "decline to self-identify". */
export const EeoSchema = z.object({ gender: str, race: str, hispanic: str, veteran: str, disability: str, pronouns: str })

export const JobSearchSchema = z.object({
  workAuthorization: z.array(WorkAuthSchema).default([]),
  noticePeriod: str,
  earliestStart: str,
  currentCompensation: MoneySchema.nullable().default(null),
  expectedCompensation: MoneySchema.nullable().default(null),
  relocation: z.enum(['yes', 'no', 'maybe']).default('maybe'),
  clearance: str,
  dealbreakers: z.array(z.string()).default([]),
  over18: z.boolean().nullable().default(null),
  driversLicense: z.boolean().nullable().default(null),
  willingToTravel: str,
  eeo: EeoSchema.default({ gender: '', race: '', hispanic: '', veteran: '', disability: '', pronouns: '' }),
})

export const ProfileSchema = z.object({
  basics: z
    .object({
      name: str,
      email: str,
      phone: str,
      headline: str,
      summary: str,
      location: z.object({ city: str, region: str, country: str }).default({ city: '', region: '', country: '' }),
      links: z.array(LinkSchema).default([]),
    })
    .default({ name: '', email: '', phone: '', headline: '', summary: '', location: { city: '', region: '', country: '' }, links: [] }),
  work: z.array(WorkSchema).default([]),
  education: z.array(EducationSchema).default([]),
  projects: z.array(ProjectSchema).default([]),
  skills: z.array(SkillSchema).default([]),
  certifications: z.array(CertificationSchema).default([]),
  languages: z.array(LanguageSchema).default([]),
  awards: z.array(AwardSchema).default([]),
  jobSearch: JobSearchSchema.default(JobSearchSchema.parse({})),
})
export type Profile = z.infer<typeof ProfileSchema>
export const EMPTY_PROFILE: Profile = ProfileSchema.parse({})

// ---------------------------------------------------------------------------
// Jobs

export const REMOTE = ['onsite', 'hybrid', 'remote', 'unknown'] as const
export type Remote = (typeof REMOTE)[number]
export const SENIORITY = ['intern', 'junior', 'mid', 'senior', 'staff', 'principal', 'lead', 'manager', 'director', 'executive'] as const
export type Seniority = (typeof SENIORITY)[number]
export const EMPLOYMENT = ['full_time', 'part_time', 'contract', 'internship', 'temporary'] as const
export type Employment = (typeof EMPLOYMENT)[number]
export const CONTRACT = ['w2', '1099', 'c2c'] as const
export type ContractType = (typeof CONTRACT)[number]

export type JobLocation = { text: string; city: string | null; region: string | null; country: string | null; lat: number | null; lon: number | null }
export type Salary = { min: number | null; max: number | null; currency: string | null; period: 'year' | 'month' | 'hour' | null; text: string }

export const SIGNAL_KINDS = [
  'scam',
  'ghost',
  'stale',
  'ai_policy',
  'instructions',
  'clearance',
  'no_sponsorship',
  'sponsorship',
  'h1b_history',
  'staffing',
  'closed',
] as const
export type SignalKind = (typeof SIGNAL_KINDS)[number]
export type Signal = { kind: SignalKind; severity: 'block' | 'warn' | 'info'; label: string; detail: string }

export type JobSummary = {
  id: number
  title: string
  company: string
  companyId: number | null
  location: string
  remote: Remote
  salary: Salary | null
  postedAt: number | null
  firstSeenAt: number
  source: string
  ats: string | null
  score: number | null
  huntId: number | null
  signals: Signal[]
  userState: 'saved' | 'skipped' | null
  applicationStatus: AppStatus | null
  packageStatus: PackageStatus | null
  closed: boolean
}

export type Requirement = {
  text: string
  kind: 'must' | 'nice'
  weight: 1 | 2 | 3
  verdict: 'met' | 'partial' | 'missing'
  evidence: string[]
  note: string
}

export type Judgment = {
  requirements: Requirement[]
  seniorityFit: 'far_below' | 'below' | 'match' | 'above' | 'far_above'
  seniorityNote: string
  domainFit: 0 | 1 | 2
  domainNote: string
  logistics: string[]
  dealbreakers: string[]
  keywords: string[]
  embeddedInstructions: string[]
  aiPolicy: 'none' | 'restricts' | 'requires_disclosure'
  summary: string
}

export type ScoreBreakdown = { must: number; nice: number; seniority: number; domain: number; capped: boolean; total: number }

export type JobScore = {
  huntId: number
  huntName: string
  stage: 'filtered' | 'prefiltered' | 'judged' | 'error' | 'pending'
  passed: boolean
  reasons: string[]
  score: number | null
  breakdown: ScoreBreakdown | null
  judgment: Judgment | null
  error: string | null
}

export type JobDetail = JobSummary & {
  url: string
  applyUrl: string | null
  descriptionHtml: string | null
  descriptionMd: string
  employmentType: Employment | null
  contractType: ContractType | null
  seniority: Seniority | null
  locations: JobLocation[]
  repostCount: number
  lastSeenAt: number
  scores: JobScore[]
  companyInfo: { id: number | null; name: string; domain: string | null; ats: string | null; openRoles: number; h1b: H1bStats | null; watched: boolean; blocked: boolean }
  applicationId: number | null
  packageId: number | null
}

export type H1bStats = { approvals: number; denials: number; years: string }

// ---------------------------------------------------------------------------
// Hunts

export const HuntConfigSchema = z.object({
  titles: z.array(z.string().min(1)).default([]),
  titleSynonyms: z.array(z.string()).default([]),
  excludeKeywords: z.array(z.string()).default([]),
  places: z
    .array(z.object({ label: z.string(), city: z.string().nullable(), country: z.string().nullable(), lat: z.number().nullable(), lon: z.number().nullable(), radiusKm: z.number().min(0).max(500) }))
    .default([]),
  workplace: z.object({ onsite: z.boolean(), hybrid: z.boolean(), remote: z.boolean() }).default({ onsite: true, hybrid: true, remote: true }),
  remoteCountries: z.array(z.string().length(2)).default([]),
  employment: z.array(z.enum(EMPLOYMENT)).default(['full_time']),
  contract: z.array(z.enum(CONTRACT)).default([]),
  seniority: z.array(z.enum(SENIORITY)).default([]),
  salaryFloor: MoneySchema.nullable().default(null),
  includeUnknownSalary: z.boolean().default(true),
  companiesInclude: z.array(z.string()).default([]),
  companiesExclude: z.array(z.string()).default([]),
  excludeStaffing: z.boolean().default(true),
  requireSponsorship: z.boolean().default(false),
  postedWithinDays: z.number().int().min(1).max(365).default(30),
  queueThreshold: z.number().min(0).max(100).default(65),
  autopilotThreshold: z.number().min(0).max(100).default(80),
  companyCooldown: z.object({ max: z.number().int().min(1).max(20), days: z.number().int().min(1).max(365) }).default({ max: 2, days: 30 }),
  dailyApplyCap: z.number().int().min(0).max(100).default(15),
  dailyScoreCap: z.number().int().min(0).max(2000).default(200),
  activeHours: z.object({ start: z.string(), end: z.string() }).default({ start: '08:00', end: '21:00' }),
  coverLetter: z.enum(['always', 'when_accepted', 'never']).default('when_accepted'),
  template: z.string().default('classic'),
  reviewer: z.boolean().default(true),
  generatedAnswersInAutopilot: z.boolean().default(false),
  outreach: z
    .object({ enabled: z.boolean(), autopilot: z.boolean(), dailyCap: z.number().int().min(0).max(50), followUpDays: z.array(z.number().int().min(1).max(30)).max(3) })
    .default({ enabled: false, autopilot: false, dailyCap: 10, followUpDays: [4, 7] }),
})
export type HuntConfig = z.infer<typeof HuntConfigSchema>
export type HuntMode = 'manual' | 'review' | 'autopilot'
export type Hunt = { id: number; name: string; mode: HuntMode; active: boolean; baseResumeId: number | null; config: HuntConfig; createdAt: number; lastRunAt: number | null }
export type HuntStats = { huntId: number; matched: number; queued: number; appliedToday: number; filteredOut: number; spendToday: number }

// ---------------------------------------------------------------------------
// Documents

export type ResumeLine = { sourceIds: string[]; text: string; flagged?: string }
export type ResumeContent = {
  name: string
  headline: string
  contact: { email: string; phone: string; location: string; links: { label: string; url: string }[] }
  summary: { text: string; factIds: string[] }
  work: { workId: string; company: string; title: string; location: string; start: string; end: string | null; bullets: ResumeLine[] }[]
  education: { id: string; institution: string; degree: string; field: string; start: string; end: string; grade: string }[]
  projects: { id: string; name: string; url: string; bullets: ResumeLine[] }[]
  skills: string[]
  certifications: { name: string; issuer: string; date: string }[]
  languages: { name: string; fluency: string }[]
}

export type FactLockIssue = { location: string; kind: 'number' | 'entity' | 'citation' | 'structure'; token: string; message: string }
export type StyleIssue = { rule: string; excerpt: string; message: string }
export type ReviewIssue = { kind: 'unsupported' | 'missed_match' | 'weak' | 'generic'; location: string; message: string; suggestion: string }

export type ResumeSummary = { id: number; kind: 'base' | 'tailored'; name: string; jobId: number | null; templateId: string; updatedAt: number; hasPdf: boolean }
export type ResumeDetail = ResumeSummary & {
  content: ResumeContent
  pageSize: 'Letter' | 'A4'
  pdfPath: string | null
  docxPath: string | null
  factLock: FactLockIssue[]
  review: ReviewIssue[]
  keywords: { present: string[]; inProfileNotResume: string[]; notInProfile: string[] }
}

export type TemplateInfo = { id: string; name: string; description: string; columns: 1 | 2; atsSafe: boolean; regions: string[] }

// ---------------------------------------------------------------------------
// Answers and packages

export type AnswerKind = 'fact' | 'computed' | 'open' | 'legal' | 'eeo' | 'salary' | 'choice' | 'file' | 'contact' | 'consent'
export type AnswerSource = 'profile' | 'bank' | 'computed' | 'generated' | 'user' | 'default'

export type PreparedAnswer = {
  fieldName: string
  question: string
  key: string | null
  kind: AnswerKind
  required: boolean
  options: string[]
  answer: string
  source: AnswerSource
  confidence: number
  needsUser: boolean
}

export type Gate = { id: string; ok: boolean; label: string; detail: string }
export type PackageStatus = 'preparing' | 'ready' | 'approved' | 'skipped' | 'expired' | 'failed' | 'applied'

export type PackageSummary = {
  id: number
  jobId: number
  huntId: number | null
  huntName: string | null
  title: string
  company: string
  score: number | null
  status: PackageStatus
  gatesFailed: number
  needsUser: number
  createdAt: number
  cost: number
}

export type PackageDetail = PackageSummary & {
  resumeId: number | null
  coverLetterId: number | null
  coverLetter: string | null
  coverLetterIssues: StyleIssue[]
  answers: PreparedAnswer[]
  /** Where the form's questions came from, or null when they are read during the run. */
  form: { source: 'api' | 'cached' | 'standard'; count: number } | null
  gates: Gate[]
  signals: Signal[]
  error: string | null
}

// ---------------------------------------------------------------------------
// Applications and runs

export const APP_STATUSES = [
  'queued',
  'applying',
  'needs_user',
  'applied',
  'applied_unverified',
  'failed',
  'screening',
  'interviewing',
  'offer',
  'accepted',
  'declined',
  'rejected',
  'withdrawn',
  'ghosted',
] as const
export type AppStatus = (typeof APP_STATUSES)[number]

export type ApplicationSummary = {
  id: number
  jobId: number | null
  company: string
  title: string
  status: AppStatus
  channel: string
  method: string | null
  appliedAt: number | null
  lastActivityAt: number
  huntName: string | null
  archived: boolean
  url: string | null
}

export type TimelineEvent = { id: number; type: string; at: number; source: string; data: Record<string, unknown> }

export type RunStep = { at: number; kind: 'info' | 'fill' | 'click' | 'upload' | 'navigate' | 'ask' | 'error' | 'evidence' | 'agent'; text: string }
export type RunMode = 'submit' | 'dry_run' | 'assisted'
export type RunStatus = 'running' | 'needs_user' | 'submitted' | 'ready' | 'failed' | 'stopped' | 'paused' | 'dry_run_done'
export type RunSummary = {
  id: number
  applicationId: number | null
  jobId: number | null
  title: string
  company: string
  adapter: string | null
  mode: RunMode
  status: RunStatus
  question: string | null
  /** The form field the question is about, when it is one (not a CAPTCHA or sign-in step). */
  fieldName: string | null
  error: string | null
  startedAt: number
  endedAt: number | null
}
export type RunDetail = RunSummary & { steps: RunStep[]; evidence: { name: string; path: string }[] }

export type ApplicationDetail = ApplicationSummary & {
  notes: string
  confirmation: { text: string; url: string; screenshot: string | null } | null
  evidenceDir: string | null
  timeline: TimelineEvent[]
  runs: RunSummary[]
  resumeId: number | null
  coverLetterId: number | null
  packageId: number | null
  contacts: { id: number; name: string; title: string | null; email: string | null }[]
  interviews: Interview[]
}

export type Interview = {
  id: number
  applicationId: number | null
  startsAt: number | null
  endsAt: number | null
  kind: 'recruiter' | 'technical' | 'behavioral' | 'onsite' | 'final' | 'other'
  location: string | null
  link: string | null
  interviewers: string[]
  notes: string
  company: string
  title: string
}
