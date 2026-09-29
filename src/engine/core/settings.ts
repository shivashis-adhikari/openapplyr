import { type Settings, type SettingsPatch, SettingsSchema } from '../../shared/settings'
import type { Db } from './db'
import type { Bus } from './events'

/** Settings live in one JSON row, validated on every read so an old or hand-edited file can't break the app. */
export class SettingsStore {
  private cache: Settings | null = null
  private readonly listeners = new Set<(s: Settings) => void>()

  constructor(
    private readonly db: Db,
    private readonly bus: Bus,
  ) {}

  get(): Settings {
    if (this.cache) return this.cache
    const row = this.db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'app'")
    let raw: unknown = {}
    try {
      raw = row ? JSON.parse(row.value) : {}
    } catch {
      raw = {}
    }
    const parsed = SettingsSchema.safeParse(raw)
    this.cache = parsed.success ? parsed.data : SettingsSchema.parse({})
    return this.cache
  }

  update(patch: SettingsPatch): Settings {
    const current = this.get()
    const merged: Record<string, unknown> = { ...current }
    for (const [k, v] of Object.entries(patch)) {
      const cur = (current as Record<string, unknown>)[k]
      merged[k] = v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' ? { ...cur, ...v } : v
    }
    const next = SettingsSchema.parse(merged)
    this.db.run("INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
      JSON.stringify(next),
    ])
    this.cache = next
    this.bus.changed('settings')
    for (const l of this.listeners) l(next)
    return next
  }

  onChange(listener: (s: Settings) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
