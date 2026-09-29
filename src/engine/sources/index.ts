import { adzuna, arbeitnow, himalayas, hn, jooble, reed, remoteok, remotive, themuse, usajobs } from './aggregators'
import { ashby, greenhouse, lever, recruitee, smartrecruiters, workable, workday } from './ats'
import type { SourceAdapter, SourceKind } from './types'

export const ADAPTERS: Partial<Record<SourceKind, SourceAdapter>> = {
  greenhouse,
  lever,
  ashby,
  workday,
  smartrecruiters,
  recruitee,
  workable,
  remotive,
  remoteok,
  arbeitnow,
  themuse,
  himalayas,
  hn,
  adzuna,
  usajobs,
  jooble,
  reed,
}

export function adapterFor(kind: string): SourceAdapter {
  const a = ADAPTERS[kind as SourceKind]
  if (!a) throw new Error(`No adapter for source kind "${kind}"`)
  return a
}

/** Minimum hours between polls for sources with published rate limits. */
export const MIN_INTERVAL_HOURS: Partial<Record<SourceKind, number>> = { remotive: 6, remoteok: 2, arbeitnow: 2, themuse: 4, himalayas: 2, hn: 12, adzuna: 6, usajobs: 6, jooble: 6, reed: 6 }
