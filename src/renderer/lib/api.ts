import { QueryClient, type UseQueryOptions, useMutation, useQuery } from '@tanstack/react-query'
import type { ProcInput, ProcName, ProcOutput } from '../../shared/api'
import { EngineError } from '../../shared/bridge'
import type { WireError } from '../../shared/host'
import { bridge } from './bridge'
import { toast } from './toast'

export async function call<N extends ProcName>(name: N, input: ProcInput<N>): Promise<ProcOutput<N>> {
  try {
    return (await bridge.call(name, input)) as ProcOutput<N>
  } catch (e) {
    throw e instanceof Error ? e : new EngineError(e as WireError)
  }
}

export const queryClient = new QueryClient({
  defaultOptions: {
    // Local data: always fresh until the engine says it changed.
    queries: { staleTime: Infinity, retry: false, refetchOnWindowFocus: false },
  },
})

/** Reads through the engine; refreshed when the engine announces a change to a related topic. */
export function useApi<N extends ProcName>(name: N, input: ProcInput<N>, opts: Omit<UseQueryOptions<ProcOutput<N>, Error>, 'queryKey' | 'queryFn'> = {}) {
  return useQuery<ProcOutput<N>, Error>({ queryKey: [name, input], queryFn: () => call(name, input), ...opts })
}

/** A call that changes something. Errors show as a toast unless the caller handles them. */
export function useAction<N extends ProcName>(name: N, opts: { onSuccess?: (out: ProcOutput<N>, input: ProcInput<N>) => void; quiet?: boolean } = {}) {
  return useMutation<ProcOutput<N>, Error, ProcInput<N>>({
    mutationFn: (input) => call(name, input),
    onSuccess: (out, input) => opts.onSuccess?.(out, input),
    onError: (e) => {
      if (!opts.quiet) toast.error(e.message)
    },
  })
}

// Engine change topics -> the procedures whose results they can change.
const TOPIC_PROCS: Record<string, string[]> = {
  jobs: ['jobs.', 'hunts.', 'today.', 'app.status', 'career.'],
  packages: ['packages.', 'today.', 'app.status'],
  applications: ['applications.', 'analytics.', 'today.', 'app.status', 'runs.', 'offers.'],
  runs: ['runs.', 'today.', 'app.status', 'applications.'],
  mail: ['mail.', 'inbox.', 'today.', 'app.status', 'applications.'],
  outreach: ['outreach.', 'contacts.', 'today.', 'app.status', 'applications.get'],
  contacts: ['contacts.', 'outreach.'],
  documents: ['resumes.', 'letters.', 'packages.get', 'templates.'],
  profile: ['profile.', 'today.'],
  hunts: ['hunts.', 'jobs.', 'today.'],
  providers: ['ai.', 'today.', 'app.status'],
  usage: ['ai.usage', 'activity.ledger', 'app.status', 'analytics.'],
  sources: ['sources.', 'activity.sources', 'integrations.'],
  tasks: ['activity.tasks', 'app.status', 'packages.list', 'today.'],
  settings: ['settings.', 'app.status'],
  answers: ['answers.', 'packages.get'],
  interviews: ['interviews.', 'today.', 'applications.get'],
  prep: ['prep.', 'stories.', 'mock.'],
  engine: [''],
}

export function listenForChanges(): () => void {
  const offTopics = bridge.subscribe('*', (msg) => {
    const { topic } = msg as { topic: string }
    const prefixes = TOPIC_PROCS[topic]
    if (!prefixes) return
    void queryClient.invalidateQueries({ predicate: (q) => prefixes.some((p) => String(q.queryKey[0]).startsWith(p)) })
  })
  // After an engine restart everything may have moved on.
  const offConn = bridge.onConnection((up) => {
    if (up) void queryClient.invalidateQueries()
  })
  return () => {
    offTopics()
    offConn()
  }
}
