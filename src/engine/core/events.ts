/**
 * Invalidation bus. Modules emit a topic when their data changes; the renderer refetches.
 * Emissions within a short window are coalesced so a poll that inserts 500 jobs sends one event.
 */
export const TOPICS = [
  'answers',
  'applications',
  'contacts',
  'documents',
  'engine',
  'hunts',
  'interviews',
  'jobs',
  'mail',
  'notifications',
  'outreach',
  'packages',
  'prep',
  'profile',
  'providers',
  'runs',
  'settings',
  'sources',
  'tasks',
  'usage',
] as const
export type Topic = (typeof TOPICS)[number]

type Listener = (topic: Topic, data?: unknown) => void

export class Bus {
  private readonly listeners = new Set<Listener>()
  private readonly pendingTopics = new Set<Topic>()
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly coalesceMs = 120) {}

  /** Coalesced change notification (no payload). */
  changed(...topics: Topic[]): void {
    for (const t of topics) this.pendingTopics.add(t)
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      const topics = [...this.pendingTopics]
      this.pendingTopics.clear()
      for (const t of topics) this.deliver(t)
    }, this.coalesceMs)
  }

  /** Immediate event with a payload (for example live run progress). */
  emit(topic: Topic, data: unknown): void {
    this.deliver(topic, data)
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private deliver(topic: Topic, data?: unknown): void {
    for (const l of this.listeners) {
      try {
        l(topic, data)
      } catch {
        /* a broken listener must not stop the others */
      }
    }
  }
}
