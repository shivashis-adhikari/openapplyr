import { ArrowSquareOutIcon, XIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import type { ApplicationDetail as Detail, AppStatus, TimelineEvent } from '../../shared/domain'
import { APP_STATUSES } from '../../shared/domain'
import { Button, Empty, FormDialog, IconButton, InlineAlert, Menu, Section, Select, Status, TextField, type Tone, Working } from '../components/ui'
import { useAction, useApi } from '../lib/api'
import { bridge } from '../lib/bridge'
import { ago, date, dateTime } from '../lib/format'
import { navigate } from '../lib/router'
import { useDraft } from '../lib/hooks'
import { t } from '../strings/en'

export const statusTone = (s: AppStatus): Tone =>
  s === 'needs_user' || s === 'applied_unverified' ? 'attention' : s === 'rejected' || s === 'failed' ? 'danger' : s === 'offer' || s === 'accepted' ? 'accent' : s === 'applying' || s === 'screening' || s === 'interviewing' ? 'info' : undefined

function eventText(e: TimelineEvent): string {
  const d = e.data as Record<string, string | number | undefined>
  switch (e.type) {
    case 'status':
      return `${t.status[String(d['to'])] ?? d['to']}${d['note'] ? `: ${d['note']}` : ''}`
    case 'email':
      return `${t.inbox.category[String(d['category'])] ?? t.applications.event['email']}: ${d['subject'] ?? ''}`
    case 'needs_user':
      return String(d['question'] ?? t.applications.event['needs_user'])
    case 'run_failed':
      return `${t.applications.event['run_failed']}: ${d['error'] ?? ''}`
    case 'note':
      return `${t.applications.event['note']}: ${d['text'] ?? ''}`
    default:
      return t.applications.event[e.type] ?? e.type
  }
}
const eventTone = (e: TimelineEvent) => {
  const to = String((e.data as Record<string, unknown>)['to'] ?? '')
  if (e.type === 'applied' || to === 'offer' || to === 'interviewing' || to === 'screening') return 'accent'
  if (e.type === 'run_failed' || to === 'rejected') return 'danger'
  if (e.type === 'needs_user' || e.type === 'dry_run') return 'attention'
  return undefined
}

function RunQuestion({ app }: { app: Detail }) {
  const run = app.runs[0]
  const [value, setValue] = useState('')
  const reply = useAction('runs.reply')
  const again = useAction('applications.run')
  if (!run || !run.question) return null
  const isDry = run.status === 'dry_run_done'
  const lastAsk = { fieldName: run.fieldName }
  return (
    <InlineAlert
      actions={
        isDry ? (
          <>
            <Button size="sm" variant="primary" onPress={() => again.mutate({ id: app.id, mode: 'submit' })}>
              {t.applications.sendForReal}
            </Button>
            <Button size="sm" onPress={() => again.mutate({ id: app.id, mode: 'assisted' })}>
              {t.applications.fillForMe}
            </Button>
          </>
        ) : undefined
      }
    >
      <p>{run.question}</p>
      {!isDry && lastAsk?.fieldName && (
        <form
          className="row"
          style={{ marginTop: 8 }}
          onSubmit={(e) => {
            e.preventDefault()
            if (value.trim()) reply.mutate({ id: run.id, reply: { kind: 'answer', fieldName: lastAsk.fieldName!, answer: value.trim(), save: 'all' } })
          }}
        >
          <input className="input" aria-label={t.activity.run.answerLabel} value={value} onChange={(e) => setValue(e.target.value)} />
          <Button size="sm" type="submit" isDisabled={!value.trim()}>
            {t.activity.run.answer}
          </Button>
        </form>
      )}
      {!isDry && !lastAsk?.fieldName && (
        <Button size="sm" onPress={() => reply.mutate({ id: run.id, reply: { kind: 'continue' } })}>
          {t.activity.run.continue}
        </Button>
      )}
    </InlineAlert>
  )
}

function People({ app }: { app: Detail }) {
  const outreach = useApi('outreach.list', { filter: 'all', applicationId: app.id })
  const discover = useAction('contacts.discover')
  const draft = useAction('outreach.draft', { onSuccess: (r) => navigate('/outreach', { tab: 'drafts', item: r.item.id }) })
  const contacts = discover.data ?? []
  return (
    <Section
      title={t.applications.contacts}
      actions={
        <Button size="sm" isDisabled={discover.isPending} onPress={() => discover.mutate({ applicationId: app.id })}>
          {t.applications.findPeople}
        </Button>
      }
    >
      {discover.isPending && <Working text={t.applications.findPeople} />}
      {(outreach.data ?? []).filter((o) => o.step === 0).map((o) => (
        <div key={o.id} className="row">
          <span className="label">{o.contact.name}</span>
          <span className="meta truncate">{o.contact.title}</span>
          <span className="spacer" />
          <Status tone={o.status === 'failed' ? 'danger' : undefined}>{o.status === 'sent' ? t.outreach.sentAt(ago(o.sentAt)) : t.outreach.tabs[o.status === 'draft' ? 'drafts' : 'scheduled']}</Status>
          <Button size="sm" variant="quiet" onPress={() => navigate('/outreach', { tab: o.status === 'sent' ? 'sent' : o.status === 'draft' ? 'drafts' : 'scheduled', item: o.id })}>
            {t.common.open}
          </Button>
        </div>
      ))}
      {contacts.map((c) => (
        <div key={c.id} className="row">
          <span className="label">{c.name}</span>
          <span className="meta truncate">
            {c.title} {c.email && `· ${c.email}`}
          </span>
          <span className="spacer" />
          <Menu
            label={t.outreach.draftNew}
            trigger={<Button size="sm">{t.outreach.draftNew}</Button>}
            items={(['recruiter_intro', 'hiring_manager', 'referral', 'follow_up'] as const).map((p) => ({ id: p, label: t.outreach.purpose[p]!, onAction: () => draft.mutate({ applicationId: app.id, contactId: c.id, purpose: p }) }))}
          />
        </div>
      ))}
    </Section>
  )
}

export function ApplicationPanel({ id, onClose }: { id: number; onClose: () => void }) {
  const app = useApi('applications.get', { id })
  const setStatus = useAction('applications.setStatus')
  const update = useAction('applications.update')
  const archive = useAction('applications.archive', { onSuccess: onClose })
  const again = useAction('applications.run')
  const [notes, setNotes] = useDraft(app.data?.notes ?? '')
  if (app.isError) return <Empty title={t.common.notFound} />
  const a = app.data
  if (!a) return null
  return (
    <div className="detail">
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="detail-head" style={{ flex: 1 }}>
          <h2>{a.title}</h2>
          <div className="row-wrap meta">
            <span>{a.company}</span>
            <Status tone={statusTone(a.status)}>{t.status[a.status]}</Status>
            {a.appliedAt && <span>{t.applications.applied(date(a.appliedAt))}</span>}
            {a.method && <span>{t.applications.via[a.method] ?? a.method}</span>}
            {a.huntName && <span>{a.huntName}</span>}
          </div>
        </div>
        <IconButton label={t.common.close} icon={<XIcon aria-hidden />} onPress={onClose} />
      </div>

      <RunQuestion app={a} />

      <div className="detail-actions">
        <Select
          ariaLabel={t.applications.setStatus}
          value={a.status}
          onChange={(s) => setStatus.mutate({ ids: [a.id], status: s })}
          options={APP_STATUSES.map((s) => ({ id: s, label: t.status[s]! }))}
        />
        {(a.status === 'failed' || a.status === 'queued') && <Button onPress={() => again.mutate({ id: a.id })}>{t.applications.runAgain}</Button>}
        {a.status === 'applied_unverified' && <Button onPress={() => setStatus.mutate({ ids: [a.id], status: 'applied' })}>{t.applications.markApplied}</Button>}
        {a.url && (
          <Button variant="quiet" onPress={() => void bridge.host.openExternal(a.url!)}>
            <ArrowSquareOutIcon aria-hidden />
            {t.common.openPosting}
          </Button>
        )}
        <span className="spacer" />
        <Button variant="quiet" onPress={() => archive.mutate({ ids: [a.id], archived: !a.archived })}>
          {a.archived ? t.applications.unarchive : t.applications.archive}
        </Button>
      </div>

      {a.interviews.length > 0 && (
        <Section title={t.applications.interviews}>
          {a.interviews.map((i) => (
            <div key={i.id} className="row">
              <span className="label">{t.prep.interviewKind[i.kind]}</span>
              <span className="meta">{i.startsAt ? dateTime(i.startsAt) : ''}</span>
              <span className="spacer" />
              {i.link && (
                <Button size="sm" onPress={() => void bridge.host.openExternal(i.link!)}>
                  {t.prep.join}
                </Button>
              )}
              <Button size="sm" variant="quiet" onPress={() => navigate('/prep', { tab: 'interviews', app: a.id })}>
                {t.prep.prepFor(a.company)}
              </Button>
            </div>
          ))}
        </Section>
      )}

      <Section title={t.applications.notes}>
        <TextField aria-label={t.applications.notes} multiline value={notes} onChange={setNotes} placeholder={t.applications.notesPlaceholder} onBlur={() => notes !== a.notes && update.mutate({ id: a.id, notes })} />
      </Section>

      <Section title={t.applications.timeline}>
        <ol className="timeline">
          {a.timeline.map((e) => (
            <li key={e.id} data-tone={eventTone(e)}>
              <span className="when" title={new Date(e.at).toLocaleString()}>
                {date(e.at)}
              </span>
              <span className="mark" aria-hidden />
              <span>
                {eventText(e)} <span className="muted">({t.applications.source[e.source] ?? e.source})</span>
              </span>
            </li>
          ))}
        </ol>
      </Section>

      {(a.resumeId || a.coverLetterId) && (
        <Section title={t.applications.documents}>
          <div className="row">
            {a.resumeId && (
              <Button size="sm" onPress={() => navigate('/documents', { tab: 'resumes', resume: a.resumeId })}>
                {t.queue.resume}
              </Button>
            )}
            {a.packageId && (
              <Button size="sm" variant="quiet" onPress={() => navigate('/queue', { filter: 'done', pkg: a.packageId })}>
                {t.queue.answers}
              </Button>
            )}
          </div>
        </Section>
      )}

      <Section
        title={t.applications.evidence}
        actions={
          a.evidenceDir ? (
            <Button size="sm" variant="quiet" onPress={() => void bridge.host.reveal(a.evidenceDir!)}>
              {t.common.reveal}
            </Button>
          ) : undefined
        }
      >
        {a.confirmation ? (
          <p>
            <span className="label">{t.applications.confirmation}:</span> {a.confirmation.text}
          </p>
        ) : (
          !a.evidenceDir && <p className="meta">{t.applications.evidenceNone}</p>
        )}
        {a.runs.length > 0 && (
          <ul className="stack" style={{ gap: 4 }}>
            {a.runs.map((r) => (
              <li key={r.id} className="row">
                <span>{t.activity.run.mode[r.mode]}</span>
                <Status tone={r.status === 'failed' ? 'danger' : r.status === 'needs_user' ? 'attention' : undefined}>{t.activity.run.status[r.status]}</Status>
                <span className="meta">{ago(r.startedAt)}</span>
                <span className="spacer" />
                <Button size="sm" variant="quiet" onPress={() => navigate('/activity', { tab: 'runs', run: r.id })}>
                  {t.activity.run.steps}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <People app={a} />
    </div>
  )
}

/** Adds an application made outside OpenApplyr, so tracking and results include it. */
export function AddApplication({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [company, setCompany] = useState('')
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const [status, setStatusValue] = useState<AppStatus>('applied')
  const [appliedOn, setAppliedOn] = useState(new Date().toISOString().slice(0, 10))
  const [channel, setChannel] = useState<'ats' | 'email' | 'referral' | 'other'>('ats')
  const add = useAction('applications.add', {
    onSuccess: (r) => {
      onClose()
      navigate('/applications', { app: r.id })
    },
  })
  return (
    <FormDialog open={open} onClose={onClose} title={t.applications.addTitle} onSubmit={() => add.mutate({ company, title, url: /^https?:\/\//.test(url) ? url : null, status, appliedAt: appliedOn ? new Date(`${appliedOn}T12:00:00`).getTime() : null, channel })} submitLabel={t.applications.add} valid={!!company.trim() && !!title.trim()}>
      <div className="grid-2">
        <TextField label={t.applications.fields.company} value={company} onChange={setCompany} autoFocus />
        <TextField label={t.applications.fields.title} value={title} onChange={setTitle} />
      </div>
      <TextField label={t.applications.fields.url} value={url} onChange={setUrl} placeholder="https://" />
      <div className="grid-3">
        <Select label={t.applications.fields.status} value={status} onChange={setStatusValue} options={APP_STATUSES.map((s) => ({ id: s, label: t.status[s]! }))} />
        <TextField label={t.applications.fields.appliedOn} type="date" value={appliedOn} onChange={setAppliedOn} />
        <Select label={t.applications.fields.channel} value={channel} onChange={setChannel} options={(['ats', 'email', 'referral', 'other'] as const).map((c) => ({ id: c, label: t.applications.channels[c]! }))} />
      </div>
    </FormDialog>
  )
}
