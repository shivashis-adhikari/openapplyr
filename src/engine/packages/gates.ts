import type { FactLockIssue, Gate, HuntConfig, PreparedAnswer, ResumeContent, ReviewIssue, Signal, StyleIssue } from '../../shared/domain'
import { blocksAutopilot } from '../jobs/signals'

export type GateInput = {
  score: number | null
  config: Pick<HuntConfig, 'autopilotThreshold' | 'generatedAnswersInAutopilot' | 'reviewer'>
  signals: Signal[]
  closed: boolean
  answers: PreparedAnswer[]
  resume: { content: ResumeContent; factLock: FactLockIssue[]; review: ReviewIssue[] } | null
  letterIssues: StyleIssue[]
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * Everything that must hold before a package is sent without review.
 * Pacing (caps, cooldowns, active hours) is not a gate: approved packages wait for their slot.
 */
export function computeGates(g: GateInput): Gate[] {
  const gates: Gate[] = []
  const add = (id: string, ok: boolean, label: string, detail: string) => gates.push({ id, ok, label, detail })

  add('open', !g.closed, 'Posting open', g.closed ? 'The posting has closed.' : 'Still accepting applications.')

  const threshold = g.config.autopilotThreshold
  add('score', g.score !== null && g.score >= threshold, 'Match score', g.score === null ? 'Not scored.' : `${Math.round(g.score)}; autopilot needs ${threshold}.`)

  const blocking = blocksAutopilot(g.signals)
  add('signals', blocking.length === 0, 'Posting checks', blocking.length ? blocking.map((s) => s.label).join('; ') : 'No warning signs.')

  const missing = g.answers.filter((a) => a.needsUser)
  add('answers', missing.length === 0, 'Required answers', missing.length ? `${plural(missing.length, 'question needs', 'questions need')} your answer.` : 'Every required question has an answer.')

  const generated = g.answers.filter((a) => a.source === 'generated' && a.kind === 'open')
  const genOk = generated.length === 0 || g.config.generatedAnswersInAutopilot
  add('generated', genOk, 'Written answers', generated.length === 0 ? 'None needed.' : genOk ? `${plural(generated.length, 'answer', 'answers')} written from your profile.` : `${plural(generated.length, 'answer was', 'answers were')} written for you. This hunt asks you to read them first.`)

  if (g.resume) {
    const flagged = [...g.resume.content.work.flatMap((w) => w.bullets), ...g.resume.content.projects.flatMap((p) => p.bullets)].filter((b) => b.flagged).length
    const issues = g.resume.factLock.length
    add('factlock', issues === 0 && flagged === 0, 'Resume facts', issues ? `${plural(issues, 'claim does', 'claims do')} not match your profile.` : flagged ? `${plural(flagged, 'line was', 'lines were')} reverted to your original wording.` : 'Every line matches your profile.')
    if (g.config.reviewer) {
      const unsupported = g.resume.review.filter((r) => r.kind === 'unsupported')
      add('review', unsupported.length === 0, 'Second read', unsupported.length ? unsupported[0]!.message : 'No unsupported claims found.')
    }
  } else {
    add('factlock', false, 'Resume facts', 'No resume is attached.')
  }

  add('style', g.letterIssues.length === 0, 'Cover letter wording', g.letterIssues.length ? g.letterIssues[0]!.message : 'Passes the style check.')
  return gates
}

export const gatesPass = (gates: Gate[]) => gates.every((x) => x.ok)
