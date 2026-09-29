import { PlusIcon, TrashIcon } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import type { MockSession, OfferRow } from '../../shared/api/prep'
import { INTERVIEW_KINDS } from '../../shared/api/prep'
import { PageHead, RowList, Split } from '../components/layout'
import { Button, Empty, FormDialog, IconButton, InlineAlert, Section, Segmented, Select, TextField, Working } from '../components/ui'
import { call, useAction, useApi } from '../lib/api'
import { bridge } from '../lib/bridge'
import { dateTime, money } from '../lib/format'
import { useParam } from '../lib/router'
import { t } from '../strings/en'

const TABS = ['interviews', 'practice', 'stories', 'offers', 'career'] as const

function PrepWorkspace({ applicationId }: { applicationId: number }) {
  const prep = useApi('prep.get', { applicationId })
  const [kind, setKind] = useState<(typeof INTERVIEW_KINDS)[number]>('technical')
  const gen = useAction('prep.generate')
  const p = prep.data
  if (!p) return null
  return (
    <div className="stack-lg">
      <Section
        title={t.prep.brief}
        actions={
          <Button size="sm" isDisabled={gen.isPending} onPress={() => gen.mutate({ applicationId, part: 'brief' })}>
            {t.prep.briefMake}
          </Button>
        }
      >
        {gen.isPending && gen.variables?.part === 'brief' && <Working text={t.prep.briefWriting} />}
        {p.brief ? (
          p.brief.sections.map((s) => (
            <div key={s.heading} className="stack" style={{ gap: 4 }}>
              <span className="label">{s.heading}</span>
              <ul className="stack" style={{ gap: 4 }}>
                {s.points.map((pt, i) => (
                  <li key={i}>
                    {pt.text}{' '}
                    {pt.source === 'posting' ? (
                      <span className="meta">({t.jobs.posting.toLowerCase()})</span>
                    ) : (
                      <a
                        href={pt.source}
                        className="meta"
                        onClick={(e) => {
                          e.preventDefault()
                          void bridge.host.openExternal(pt.source)
                        }}
                      >
                        ({t.common.source.toLowerCase()})
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))
        ) : (
          <p className="meta">{t.prep.briefNone}</p>
        )}
      </Section>
      <Section
        title={t.prep.questions}
        actions={
          <div className="row">
            <Select ariaLabel={t.prep.practice.kind} value={kind} onChange={setKind} options={INTERVIEW_KINDS.map((k) => ({ id: k, label: t.prep.interviewKind[k]! }))} />
            <Button size="sm" isDisabled={gen.isPending} onPress={() => gen.mutate({ applicationId, part: 'questions', kind })}>
              {t.prep.questionsMake}
            </Button>
          </div>
        }
      >
        {gen.isPending && gen.variables?.part === 'questions' && <Working text={t.prep.questionsWriting} />}
        <ol className="stack" style={{ gap: 8, listStyle: 'decimal', paddingLeft: 20 }}>
          {p.likely.map((q, i) => (
            <li key={i}>
              {q.question} <span className="meta">{q.why}</span>
            </li>
          ))}
        </ol>
      </Section>
      {p.ask.length > 0 && (
        <Section title={t.prep.ask}>
          <ul className="stack" style={{ gap: 4 }}>
            {p.ask.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </Section>
      )}
      {p.checklist.length > 0 && (
        <Section title={t.prep.checklist}>
          <ul className="stack" style={{ gap: 4 }}>
            {p.checklist.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  )
}

function InterviewDialog({ onClose }: { onClose: () => void }) {
  const apps = useApi('applications.list', { q: '', statuses: [], huntId: null, archived: false })
  const [app, setApp] = useState<string | null>(null)
  const [when, setWhen] = useState('')
  const [minutes, setMinutes] = useState('45')
  const [kind, setKind] = useState<(typeof INTERVIEW_KINDS)[number]>('recruiter')
  const [link, setLink] = useState('')
  const [people, setPeople] = useState('')
  const save = useAction('interviews.save', { onSuccess: onClose })
  const start = when ? new Date(when).getTime() : null
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t.prep.addInterview}
      submitLabel={t.common.save}
      valid={!!app && !!start}
      onSubmit={() => save.mutate({ applicationId: Number(app), startsAt: start, endsAt: start ? start + Number(minutes) * 60_000 : null, kind, link: /^https?:\/\//.test(link) ? link : null, location: null, interviewers: people.split(',').map((x) => x.trim()).filter(Boolean), notes: '' })}
    >
      <Select label={t.prep.fields.application} value={app} onChange={setApp} options={(apps.data ?? []).map((a) => ({ id: String(a.id), label: `${a.company}: ${a.title}` }))} />
      <div className="grid-3">
        <TextField label={t.prep.fields.when} type="datetime-local" value={when} onChange={setWhen} />
        <TextField label={t.prep.fields.duration} type="number" value={minutes} onChange={setMinutes} />
        <Select label={t.prep.fields.kind} value={kind} onChange={setKind} options={INTERVIEW_KINDS.map((k) => ({ id: k, label: t.prep.interviewKind[k]! }))} />
      </div>
      <TextField label={t.prep.fields.link} value={link} onChange={setLink} placeholder="https://" />
      <TextField label={t.prep.fields.interviewers} help={t.prep.fields.interviewersHelp} value={people} onChange={setPeople} />
    </FormDialog>
  )
}

function Interviews() {
  const [appParam, setApp] = useParam('app')
  const [adding, setAdding] = useState(false)
  const list = useApi('interviews.list', { range: 'all' })
  const rows = list.data ?? []
  const [since] = useState(() => Date.now() - 2 * 3600_000)
  const upcoming = rows.filter((i) => (i.startsAt ?? 0) > since)
  useEffect(() => {
    if (!appParam && upcoming[0]?.applicationId) setApp(upcoming[0].applicationId)
  }, [appParam, upcoming, setApp])
  return (
    <>
      {list.data && rows.length === 0 ? (
        <Empty title={t.prep.noInterviews} body={t.prep.noInterviewsBody} action={<Button onPress={() => setAdding(true)}>{t.prep.addInterview}</Button>} />
      ) : (
        <Split
          list={
            <div>
              <div className="toolbar">
                <Button size="sm" onPress={() => setAdding(true)}>
                  <PlusIcon aria-hidden />
                  {t.prep.addInterview}
                </Button>
              </div>
              <RowList
                label={t.prep.tabs['interviews']!}
                rows={rows.map((i) => ({
                  id: i.applicationId ?? `i${i.id}`,
                  textValue: `${i.company} ${i.title}`,
                  line1: <span className="truncate">{i.company}</span>,
                  line2: (
                    <>
                      <span>{t.prep.interviewKind[i.kind]}</span>
                      <span>{i.startsAt ? dateTime(i.startsAt) : ''}</span>
                    </>
                  ),
                }))}
                selected={appParam}
                onSelect={(id) => !id.startsWith('i') && setApp(id)}
              />
            </div>
          }
          detail={appParam ? <div className="detail"><PrepWorkspace key={appParam} applicationId={Number(appParam)} /></div> : null}
        />
      )}
      {adding && <InterviewDialog onClose={() => setAdding(false)} />}
    </>
  )
}

function Practice() {
  const [sessionId, setSession] = useState<number | null>(null)
  const [kind, setKind] = useState<(typeof INTERVIEW_KINDS)[number]>('behavioral')
  const [app, setApp] = useState<string>('none')
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const sessions = useApi('mock.list', undefined)
  const apps = useApi('applications.list', { q: '', statuses: [], huntId: null, archived: false })
  // The latest reply from the engine wins over the cached list until the list refreshes.
  const [latest, setSessionData] = useState<MockSession | null>(null)
  const session = latest && latest.id === sessionId ? latest : ((sessions.data ?? []).find((s) => s.id === sessionId) ?? null)
  const start = async () => {
    setBusy(true)
    try {
      const s = await call('mock.start', { applicationId: app === 'none' ? null : Number(app), kind })
      setSession(s.id)
      setSessionData(s)
    } finally {
      setBusy(false)
    }
  }
  const send = async () => {
    if (!session || !answer.trim()) return
    setBusy(true)
    try {
      setSessionData(await call('mock.answer', { id: session.id, answer }))
      setAnswer('')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="page-narrow stack-lg">
      <div className="row-wrap">
        <Select label={t.prep.practice.kind} value={kind} onChange={setKind} options={INTERVIEW_KINDS.map((k) => ({ id: k, label: t.prep.interviewKind[k]! }))} />
        <Select label={t.prep.practice.forApp} value={app} onChange={setApp} options={[{ id: 'none', label: t.prep.practice.general }, ...(apps.data ?? []).map((a) => ({ id: String(a.id), label: `${a.company}: ${a.title}` }))]} />
        <div style={{ alignSelf: 'flex-end' }}>
          <Button variant="primary" isDisabled={busy} onPress={() => void start()}>
            {t.prep.practice.start}
          </Button>
        </div>
      </div>
      {!session && (sessions.data ?? []).length === 0 && <Empty title={t.prep.practice.empty} body={t.prep.practice.emptyBody} />}
      {!session && (sessions.data ?? []).length > 0 && (
        <ul className="panel">
          {sessions.data!.map((s) => (
            <li key={s.id} className="worklist-item" data-tone="muted" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
              <span>{s.title}</span>
              <Button size="sm" onPress={() => setSession(s.id)}>
                {t.common.open}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {session && (
        <div className="stack-lg">
          {session.messages.map((m, i) => (
            <div key={i} className="stack" style={{ gap: 8 }}>
              <p className={m.role === 'interviewer' ? 'label' : 'pre'}>{m.text}</p>
              {m.feedback && (
                <div className="well stack">
                  <div className="grid-2">
                    {(['structure', 'specificity', 'relevance', 'length'] as const).map((k) => (
                      <div key={k}>
                        <span className="label">
                          {t.prep.practice.scores[k]} {m.feedback![k].score}/5
                        </span>
                        <div className="meta">{m.feedback![k].note}</div>
                      </div>
                    ))}
                  </div>
                  <div>
                    <span className="label">{t.prep.practice.stronger}</span>
                    <p className="pre">{m.feedback.stronger}</p>
                  </div>
                </div>
              )}
            </div>
          ))}
          {busy && <Working text={t.prep.practice.thinking} />}
          <TextField label={t.prep.practice.answer} placeholder={t.prep.practice.answerPlaceholder} multiline tall value={answer} onChange={setAnswer} />
          <div className="row">
            <Button variant="primary" isDisabled={!answer.trim() || busy} onPress={() => void send()}>
              {t.prep.practice.send}
            </Button>
            <Button variant="quiet" onPress={() => setSession(null)}>
              {t.common.back}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function Stories() {
  const list = useApi('stories.list', undefined)
  const draft = useAction('stories.draft')
  const save = useAction('stories.save')
  const del = useAction('stories.delete')
  const rows = list.data ?? []
  return (
    <div className="page-narrow stack-lg">
      <div className="row">
        <Button variant={rows.length ? 'secondary' : 'primary'} isDisabled={draft.isPending} onPress={() => draft.mutate(undefined)}>
          {t.prep.stories.draft}
        </Button>
        <Button onPress={() => save.mutate({ title: t.prep.stories.add, situation: '', task: '', action: '', result: '', tags: [] })}>{t.prep.stories.add}</Button>
      </div>
      {draft.isPending && <Working text={t.prep.stories.drafting} />}
      {list.data && rows.length === 0 && <Empty title={t.prep.stories.empty} body={t.prep.stories.emptyBody} />}
      {rows.map((s) => (
        <details key={s.id} className="panel panel-pad">
          <summary className="row">
            <span className="label" style={{ flex: 1 }}>
              {s.title}
            </span>
            <span className="meta">{s.tags.join(', ')}</span>
            <IconButton size="sm" label={t.common.delete} icon={<TrashIcon aria-hidden />} onPress={() => del.mutate({ id: s.id })} />
          </summary>
          <div className="stack" style={{ marginTop: 12 }}>
            {(['title', 'situation', 'task', 'action', 'result'] as const).map((k) => (
              <TextField key={k} label={t.prep.stories.fields[k]} multiline={k !== 'title'} defaultValue={s[k]} onBlur={(e) => {
                const v = (e.target as HTMLInputElement).value
                if (v !== s[k]) save.mutate({ id: s.id, title: s.title, situation: s.situation, task: s.task, action: s.action, result: s.result, tags: s.tags, [k]: v })
              }} />
            ))}
          </div>
        </details>
      ))}
    </div>
  )
}

function OfferDialog({ offer, onClose }: { offer: OfferRow | 'new'; onClose: () => void }) {
  const o = offer === 'new' ? null : offer.data
  const [d, setD] = useState({ company: o?.company ?? '', title: o?.title ?? '', currency: o?.currency ?? 'USD', base: String(o?.base ?? ''), bonusPct: String(o?.bonusPct ?? 0), signOn: String(o?.signOn ?? 0), equityValue: String(o?.equityValue ?? 0), vestingYears: String(o?.vestingYears ?? 4), cliffMonths: String(o?.cliffMonths ?? 12), benefits: o?.benefits ?? '', location: o?.location ?? '', deadline: o?.deadline ?? '' })
  const save = useAction('offers.save', { onSuccess: onClose })
  const f = t.prep.offers.fields
  const num = (s: string) => Number(s.replace(/[^\d.]/g, '')) || 0
  return (
    <FormDialog
      open
      onClose={onClose}
      title={o ? o.company : t.prep.offers.add}
      wide
      submitLabel={t.common.save}
      valid={!!d.company.trim() && num(d.base) > 0}
      onSubmit={() => save.mutate({ ...(offer !== 'new' ? { id: offer.id } : {}), applicationId: offer !== 'new' ? offer.applicationId : null, data: { company: d.company, title: d.title, currency: d.currency.toUpperCase().slice(0, 3) || 'USD', base: num(d.base), bonusPct: num(d.bonusPct), signOn: num(d.signOn), equityValue: num(d.equityValue), vestingYears: num(d.vestingYears), cliffMonths: Math.round(num(d.cliffMonths)), benefits: d.benefits, location: d.location, deadline: d.deadline } })}
    >
      <div className="grid-3">
        <TextField label={f.company} value={d.company} onChange={(v) => setD({ ...d, company: v })} />
        <TextField label={f.title} value={d.title} onChange={(v) => setD({ ...d, title: v })} />
        <TextField label={f.currency} value={d.currency} maxLength={3} onChange={(v) => setD({ ...d, currency: v })} />
        <TextField label={f.base} inputMode="numeric" value={d.base} onChange={(v) => setD({ ...d, base: v })} />
        <TextField label={f.bonus} inputMode="decimal" value={d.bonusPct} onChange={(v) => setD({ ...d, bonusPct: v })} />
        <TextField label={f.signOn} inputMode="numeric" value={d.signOn} onChange={(v) => setD({ ...d, signOn: v })} />
        <TextField label={f.equity} inputMode="numeric" value={d.equityValue} onChange={(v) => setD({ ...d, equityValue: v })} />
        <TextField label={f.vesting} inputMode="numeric" value={d.vestingYears} onChange={(v) => setD({ ...d, vestingYears: v })} />
        <TextField label={f.cliff} inputMode="numeric" value={d.cliffMonths} onChange={(v) => setD({ ...d, cliffMonths: v })} />
      </div>
      <div className="grid-2">
        <TextField label={f.location} value={d.location} onChange={(v) => setD({ ...d, location: v })} />
        <TextField label={f.deadline} type="date" value={d.deadline} onChange={(v) => setD({ ...d, deadline: v })} />
      </div>
      <TextField label={f.benefits} multiline value={d.benefits} onChange={(v) => setD({ ...d, benefits: v })} />
    </FormDialog>
  )
}

function Offers() {
  const list = useApi('offers.list', undefined)
  const [editing, setEditing] = useState<OfferRow | 'new' | null>(null)
  const [target, setTarget] = useState('')
  const negotiate = useAction('offers.negotiate')
  const rows = list.data ?? []
  return (
    <div className="page-narrow stack-lg" style={{ maxWidth: 1040 }}>
      <div>
        <Button onPress={() => setEditing('new')}>
          <PlusIcon aria-hidden />
          {t.prep.offers.add}
        </Button>
      </div>
      {list.data && rows.length === 0 ? (
        <Empty title={t.prep.offers.empty} body={t.prep.offers.emptyBody} />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{t.prep.offers.fields.company}</th>
              <th className="right">{t.prep.offers.fields.base}</th>
              <th className="right">{t.prep.offers.firstYear}</th>
              <th className="right">{t.prep.offers.averageYear}</th>
              <th>{t.prep.offers.fields.deadline}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id} data-href onClick={(e) => !(e.target as HTMLElement).closest('button') && setEditing(o)}>
                <td className="label">
                  {o.data.company} <span className="meta">{o.data.title}</span>
                </td>
                <td className="right">{money(o.data.base, o.data.currency, false)}</td>
                <td className="right">{money(o.firstYear, o.data.currency, false)}</td>
                <td className="right">{money(o.averageYear, o.data.currency, false)}</td>
                <td>{o.data.deadline}</td>
                <td className="right">
                  <Button size="sm" onPress={() => negotiate.mutate({ id: o.id, target })}>
                    {t.prep.offers.negotiate}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.length > 0 && <TextField label={t.prep.offers.target} placeholder={t.prep.offers.targetPlaceholder} value={target} onChange={setTarget} />}
      {negotiate.isPending && <Working text={t.prep.offers.drafting} />}
      {negotiate.data && (
        <div className="panel panel-pad stack">
          {negotiate.data.issues.map((i) => (
            <InlineAlert key={i.excerpt}>{i.message}</InlineAlert>
          ))}
          <p className="label">{negotiate.data.subject}</p>
          <p className="pre">{negotiate.data.body}</p>
          <div>
            <Button size="sm" onPress={() => void navigator.clipboard.writeText(`${negotiate.data!.subject}\n\n${negotiate.data!.body}`)}>
              {t.common.copy}
            </Button>
          </div>
        </div>
      )}
      {editing && <OfferDialog offer={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function Career() {
  const gap = useApi('career.skillsGap', { huntId: null })
  const explore = useApi('career.explore', undefined)
  const [topic, setTopic] = useState('')
  const post = useAction('career.linkedinPost')
  return (
    <div className="page-narrow stack-lg" style={{ maxWidth: 1040 }}>
      <Section title={t.prep.career.gap}>
        {gap.data && gap.data.rows.length ? (
          <>
            <p className="meta">{t.prep.career.gapBody(gap.data.jobs)}</p>
            <div className="funnel" style={{ gridTemplateColumns: '180px minmax(0,1fr) 140px' }}>
              {gap.data.rows.slice(0, 12).map((r) => (
                <div key={r.term} style={{ display: 'contents' }}>
                  <span>{r.term}</span>
                  <div className="bar-wide">
                    <i style={{ width: `${(r.missing / Math.max(1, r.jobs)) * 100}%` }} />
                  </div>
                  <span className="meta">{t.prep.career.gapRow(r.missing, r.jobs)}</span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="meta">{t.prep.career.gapEmpty}</p>
        )}
      </Section>
      <Section title={t.prep.career.explore}>
        <p className="meta">{t.prep.career.exploreBody}</p>
        {explore.data && explore.data.length ? (
          <table className="table table-compact">
            <tbody>
              {explore.data.map((r) => (
                <tr key={r.title}>
                  <td className="label">{r.title}</td>
                  <td className="meta">{r.postings}</td>
                  <td>
                    {t.prep.career.youHave}: {r.have.join(', ') || t.common.none}
                  </td>
                  <td className="meta">
                    {t.prep.career.youLack}: {r.missing.slice(0, 5).join(', ') || t.common.none}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="meta">{t.prep.career.exploreEmpty}</p>
        )}
      </Section>
      <Section title={t.prep.career.post}>
        <TextField label={t.prep.career.postTopic} placeholder={t.prep.career.postPlaceholder} value={topic} onChange={setTopic} />
        <div>
          <Button isDisabled={topic.trim().length < 10 || post.isPending} onPress={() => post.mutate({ topic })}>
            {t.prep.career.postWrite}
          </Button>
        </div>
        {post.data && (
          <div className="panel panel-pad stack">
            {post.data.issues.map((i) => (
              <InlineAlert key={i.excerpt}>{i.message}</InlineAlert>
            ))}
            <p className="pre">{post.data.text}</p>
            <div>
              <Button size="sm" onPress={() => void navigator.clipboard.writeText(post.data!.text)}>
                {t.common.copy}
              </Button>
            </div>
          </div>
        )}
      </Section>
    </div>
  )
}

export function Prep() {
  const [tabParam, setTab] = useParam('tab')
  const tab = (TABS.includes(tabParam as never) ? tabParam : 'interviews') as (typeof TABS)[number]
  return (
    <>
      <PageHead title={t.prep.title}>
        <Segmented label={t.prep.title} value={tab} onChange={(v) => setTab(v)} options={TABS.map((x) => ({ id: x, label: t.prep.tabs[x]! }))} />
      </PageHead>
      <div className="page-body">
        {tab === 'interviews' && <Interviews />}
        {tab === 'practice' && <Practice />}
        {tab === 'stories' && <Stories />}
        {tab === 'offers' && <Offers />}
        {tab === 'career' && <Career />}
      </div>
    </>
  )
}
