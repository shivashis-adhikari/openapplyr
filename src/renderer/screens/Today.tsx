import { CalendarIcon, CheckCircleIcon, CircleIcon, EnvelopeIcon, PaperPlaneTiltIcon, QuestionIcon, TrayIcon, WarningCircleIcon, WarningIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import type { TodayItem } from '../../shared/api/core'
import { PageHead } from '../components/layout'
import { Button, Empty, Section } from '../components/ui'
import { useAction, useApi } from '../lib/api'
import { bridge } from '../lib/bridge'
import { ago, dateTime } from '../lib/format'
import { navigate } from '../lib/router'
import { t } from '../strings/en'

const ICON: Record<TodayItem['kind'], typeof WarningIcon> = {
  question: QuestionIcon,
  dry_run: CheckCircleIcon,
  failed: WarningCircleIcon,
  unverified: WarningIcon,
  package: TrayIcon,
  package_answers: QuestionIcon,
  package_failed: WarningCircleIcon,
  mail: EnvelopeIcon,
  outbox: PaperPlaneTiltIcon,
  mail_auth: WarningCircleIcon,
}
const TONE: Record<TodayItem['kind'], 'attention' | 'danger' | 'muted'> = {
  question: 'attention',
  dry_run: 'attention',
  failed: 'danger',
  unverified: 'attention',
  package: 'muted',
  package_answers: 'attention',
  package_failed: 'danger',
  mail: 'attention',
  outbox: 'muted',
  mail_auth: 'danger',
}

function whatFor(i: TodayItem): string {
  const w = t.today.item[i.kind]
  return typeof w === 'function' ? w(i.detail) : w
}

/** A question from a paused or waiting run, answered in place. */
function AnswerInline({ item }: { item: TodayItem }) {
  const [value, setValue] = useState('')
  const reply = useAction('runs.reply')
  const fieldName = item.fieldName
  const challenge = !fieldName
  if (!item.runId) return null
  if (challenge)
    return (
      <Button size="sm" onPress={() => reply.mutate({ id: item.runId!, reply: { kind: 'continue' } })}>
        {t.activity.run.continue}
      </Button>
    )
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault()
        if (value.trim() && fieldName) reply.mutate({ id: item.runId!, reply: { kind: 'answer', fieldName, answer: value.trim(), save: 'all' } })
      }}
    >
      <input className="input" aria-label={t.activity.run.answerLabel} value={value} onChange={(e) => setValue(e.target.value)} style={{ width: 220 }} />
      <Button size="sm" type="submit" isDisabled={!value.trim() || reply.isPending}>
        {t.activity.run.answer}
      </Button>
    </form>
  )
}

function Item({ item }: { item: TodayItem }) {
  const Icon = ICON[item.kind]
  const run = useAction('applications.run')
  const setStatus = useAction('applications.setStatus')
  const open = () => {
    switch (item.kind) {
      case 'question':
      case 'dry_run':
      case 'failed':
      case 'unverified':
        return navigate('/applications', { app: item.id })
      case 'package':
      case 'package_answers':
      case 'package_failed':
        return navigate('/queue', { pkg: item.id })
      case 'mail':
        return navigate('/inbox', { filter: 'review', message: item.id })
      case 'outbox':
        return navigate('/outreach', { tab: 'drafts', item: item.id })
      case 'mail_auth':
        return navigate('/settings', { tab: 'email' })
    }
  }
  // Only failures, mail and account problems carry a detail worth a second line.
  const detail = ['failed', 'package_failed', 'mail', 'mail_auth'].includes(item.kind) ? item.detail : ''
  return (
    <li className="worklist-item" data-tone={TONE[item.kind]}>
      <Icon aria-hidden />
      <div className="stack" style={{ gap: 2 }}>
        <span className="what">{item.title}</span>
        <span className="why">
          {whatFor(item)}
          {detail && item.kind !== 'question' ? `: ${detail}` : ''}
        </span>
        {item.kind === 'question' && <span className="why">{item.detail}</span>}
      </div>
      <div className="row">
        {item.kind === 'question' && <AnswerInline item={item} />}
        {item.kind === 'dry_run' && (
          <Button size="sm" variant="primary" onPress={() => run.mutate({ id: item.id, mode: 'submit' })}>
            {t.applications.sendForReal}
          </Button>
        )}
        {item.kind === 'failed' && (
          <Button size="sm" onPress={() => run.mutate({ id: item.id })}>
            {t.applications.runAgain}
          </Button>
        )}
        {item.kind === 'unverified' && (
          <Button size="sm" onPress={() => setStatus.mutate({ ids: [item.id], status: 'applied' })}>
            {t.applications.markApplied}
          </Button>
        )}
        <Button size="sm" variant="quiet" onPress={open}>
          {t.common.open}
        </Button>
      </div>
    </li>
  )
}

export function Today() {
  const today = useApi('today.summary', undefined, { refetchInterval: 60_000 })
  const d = today.data
  if (!d) return <PageHead title={t.today.title} />
  const setup = (['model', 'profile', 'hunt', 'mail'] as const).filter((k) => !d.setup[k])
  const setupRoute: Record<(typeof setup)[number], () => void> = {
    model: () => navigate('/settings', { tab: 'models' }),
    profile: () => navigate('/documents', { tab: 'profile' }),
    hunt: () => navigate('/hunts', { hunt: 'new' }),
    mail: () => navigate('/settings', { tab: 'email' }),
  }
  return (
    <>
      <PageHead title={t.today.title}>
        <p className="stats-line" aria-label={t.today.title}>
          {t.today.counts(d.counts).map((c) => (
            <span key={c}>
              <b>{c.split(' ')[0]}</b> {c.split(' ').slice(1).join(' ')}
            </span>
          ))}
        </p>
      </PageHead>
      <div className="page-body">
        <div className="page-narrow stack-lg" style={{ maxWidth: 960 }}>
          {setup.length > 0 && (
            <Section title={t.today.setupTitle}>
              <ul className="panel">
                {setup.map((k) => (
                  <li key={k} className="worklist-item" data-tone="muted">
                    <CircleIcon aria-hidden />
                    <div className="stack" style={{ gap: 2 }}>
                      <span className="what">{t.today.setup[k]}</span>
                      <span className="why">{t.today.setupWhy[k]}</span>
                    </div>
                    <Button size="sm" variant={k === setup[0] ? 'primary' : 'secondary'} onPress={setupRoute[k]}>
                      {t.common.open}
                    </Button>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section title={t.today.needsYou}>
            {d.items.length === 0 ? (
              <Empty title={t.today.nothing} body={t.today.nothingBody} />
            ) : (
              <ul className="panel">
                {d.items.map((i) => (
                  <Item key={`${i.kind}:${i.id}`} item={i} />
                ))}
              </ul>
            )}
          </Section>

          {d.interviews.length > 0 && (
            <Section title={t.today.upcoming}>
              <ul className="panel">
                {d.interviews.map((i) => (
                  <li key={i.id} className="worklist-item" data-tone="muted">
                    <CalendarIcon aria-hidden />
                    <div className="stack" style={{ gap: 2 }}>
                      <span className="what">
                        {i.company}: {i.title}
                      </span>
                      <span className="why">
                        {t.prep.interviewKind[i.kind] ?? i.kind}, {dateTime(i.startsAt)} ({ago(i.startsAt)})
                      </span>
                    </div>
                    <div className="row">
                      {i.link && (
                        <Button size="sm" onPress={() => void bridge.host.openExternal(i.link!)}>
                          {t.today.join}
                        </Button>
                      )}
                      {i.applicationId && (
                        <Button size="sm" variant="quiet" onPress={() => navigate('/prep', { tab: 'interviews', app: i.applicationId })}>
                          {t.prep.prepFor(i.company)}
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      </div>
    </>
  )
}
