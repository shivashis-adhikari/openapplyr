import { z } from 'zod'

const HourMinute = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

export const SettingsSchema = z.object({
  onboarded: z.boolean().default(false),
  paused: z.boolean().default(false),
  region: z.enum(['US', 'CA', 'UK', 'EU', 'IN', 'AU', 'OTHER']).default('US'),
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  density: z.enum(['compact', 'comfortable']).default('compact'),
  backgroundMode: z.boolean().default(true),
  launchAtLogin: z.boolean().default(false),

  budget: z
    .object({
      daily: z.number().min(0).max(1000).default(3),
      monthly: z.number().min(0).max(10000).default(40),
    })
    .default({ daily: 3, monthly: 40 }),

  automation: z
    .object({
      globalDailyApplyCap: z.number().int().min(0).max(200).default(40),
      minGapSeconds: z.number().int().min(5).max(3600).default(20),
      maxGapSeconds: z.number().int().min(5).max(7200).default(90),
      perHostGapSeconds: z.number().int().min(10).max(3600).default(60),
      concurrency: z.number().int().min(1).max(3).default(1),
      trustRampRemaining: z.number().int().min(0).max(20).default(3),
      needsUserTimeoutMinutes: z.number().int().min(1).max(120).default(15),
      browser: z.enum(['auto', 'chrome', 'msedge', 'chromium', 'custom']).default('auto'),
      browserPath: z.string().default(''),
      headless: z.boolean().default(false),
    })
    .default({
      globalDailyApplyCap: 40,
      minGapSeconds: 20,
      maxGapSeconds: 90,
      perHostGapSeconds: 60,
      concurrency: 1,
      trustRampRemaining: 3,
      needsUserTimeoutMinutes: 15,
      browser: 'auto',
      browserPath: '',
      headless: false,
    }),

  discovery: z
    .object({
      targetedIntervalMinutes: z.number().int().min(15).max(1440).default(60),
      registryIntervalHours: z.number().int().min(1).max(72).default(8),
      maxRequestsPerSecond: z.number().min(0.2).max(10).default(3),
      registryEnabled: z.boolean().default(true),
      aggregators: z.record(z.string(), z.boolean()).default({}),
    })
    .default({ targetedIntervalMinutes: 60, registryIntervalHours: 8, maxRequestsPerSecond: 3, registryEnabled: true, aggregators: {} }),

  notifications: z
    .object({
      needsYou: z.boolean().default(true),
      replies: z.boolean().default(true),
      matchesDigest: z.boolean().default(true),
      eveningSummary: z.boolean().default(false),
      quietHours: z.object({ enabled: z.boolean(), start: HourMinute, end: HourMinute }).default({ enabled: true, start: '22:00', end: '07:30' }),
    })
    .default({
      needsYou: true,
      replies: true,
      matchesDigest: true,
      eveningSummary: false,
      quietHours: { enabled: true, start: '22:00', end: '07:30' },
    }),

  mail: z
    .object({
      firstSyncDays: z.number().int().min(1).max(180).default(30),
      keepBodies: z.boolean().default(false),
      aiClassification: z.boolean().default(true),
    })
    .default({ firstSyncDays: 30, keepBodies: false, aiClassification: true }),

  tracker: z
    .object({ ghostAfterDays: z.number().int().min(7).max(180).default(30) })
    .default({ ghostAfterDays: 30 }),

  privacy: z
    .object({ stripContactFromScoring: z.boolean().default(true) })
    .default({ stripContactFromScoring: true }),
})

export type Settings = z.infer<typeof SettingsSchema>
export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({})

/** Deep partial for updates from the UI. */
export type SettingsPatch = { [K in keyof Settings]?: Settings[K] extends object ? Partial<Settings[K]> : Settings[K] }
