import { CheckCircleIcon, WarningIcon } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import type { PackageDetail, PreparedAnswer } from '../../shared/domain'
import { DocPreview } from '../components/DocPreview'
import { PageHead, RowList, Split } from '../components/layout'
import { Button, Empty, InlineAlert, Menu, Meter, Section, Segmented, Select, Status, Tag, TextField, Working } from '../components/ui'
import { call, useAction, useApi } from '../lib/api'
import { dollars } from '../lib/format'
import { navigate, useParam } from '../lib/router'
import { toast } from '../lib/toast'
import { useAutoSelect, useDraft } from '../lib/hooks'
import { t } from '../strings/en'

const FILTERS = ['queue', 'approved', 'done'] as const

function AnswerRow({ pkgId, a, editable }: { pkgId: number; a: PreparedAnswer; editable: boolean }) {
  const [value, setValue] = useDraft(a.answer)
  const [save, setSave] = useState<'no' | 'all' | 'company'>(a.kind === 'open' ? 'no' : 'all')
  const update = useAction('packages.updateAnswer')
  const commit = (v: string) => {
    if (v !== a.answer) update.mutate({ id: pkgId, fieldName: a.fieldName, answer: v, save })
  }
  const control = !editable ? (
    <span className="pre">{a.answer || '–'}</span>
  ) : a.options.length ? (
    <Select
      ariaLabel={a.question}
      value={a.options.includes(value) ? value : null}
      onChange={(v) => {
        setValue(v)
        commit(v)
      }}
      options={a.options.map((o) => ({ id: o, label: o }))}
    />
  ) : a.kind === 'file' ? (
    <span className="meta">{a.answer === 'cover_letter' ? t.queue.coverLetter : t.queue.resume}</span>
  ) : (
    <TextField aria-label={a.question} value={value} onChange={setValue} onBlur={() => commit(value)} multiline={a.kind === 'open' || value.length > 80} />
  )
  return (
    <div className="answer-row" data-needs={a.needsUser}>
      <div className="stack" style={{ gap: 2 }}>
        <span className="q">
          {a.question}
          {a.required ? ' *' : ''}
        </span>
        <span className="src">{a.needsUser ? t.queue.needsAnswer(1) : t.queue.answerSource[a.source]}</span>
      </div>
      <div className="stack" style={{ gap: 6 }}>
        {control}
        {editable && a.kind !== 'file' && (a.needsUser || a.source === 'user') && (
          <Select ariaLabel={t.queue.saveFor['all']!} value={save} onChange={setSave} options={(['all', 'company', 'no'] as const).map((k) => ({ id: k, label: t.queue.saveFor[k]! }))} />
        )}
      </div>
    </div>
  )
}

function Gates({ p }: { p: PackageDetail }) {
  return (
    <div className="gates">
      {p.gates.map((g) => (
        <div key={g.id} className="gate" data-ok={g.ok}>
          {g.ok ? <CheckCircleIcon aria-hidden /> : <WarningIcon aria-hidden />}
          <div>
            <div className="gl">{g.label}</div>
            <div className="gd">{g.detail}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

function ResumePart({ id }: { id: number }) {
  const resume = useApi('resumes.get', { id })
  const html = useApi('resumes.html', { id })
  const r = resume.data
  if (!r) return null
  const flagged = r.content.work.flatMap((w) => w.bullets).filter((b) => b.flagged)
  return (
    <Section
      title={t.queue.resume}
      actions={
        <Button size="sm" variant="quiet" onPress={() => navigate('/documents', { tab: 'resumes', resume: id })}>
          {t.queue.editResume}
        </Button>
      }
    >
      {flagged.length > 0 && <InlineAlert>{t.documents.flagged}</InlineAlert>}
      {html.data && <DocPreview html={html.data.html} title={r.name} />}
      <div className="grid-3">
        <div className="stack" style={{ gap: 6 }}>
          <span className="meta">{t.queue.keywordsPresent}</span>
          <div className="row-wrap">{r.keywords.present.map((k) => <Tag key={k} tone="accent">{k}</Tag>)}</div>
        </div>
        <div className="stack" style={{ gap: 6 }}>
          <span className="meta">{t.queue.keywordsMissing}</span>
          <div className="row-wrap">{r.keywords.inProfileNotResume.map((k) => <Tag key={k} tone="attention">{k}</Tag>)}</div>
        </div>
        <div className="stack" style={{ gap: 6 }}>
          <span className="meta">{t.queue.keywordsAbsent}</span>
          <div className="row-wrap">{r.keywords.notInProfile.map((k) => <Tag key={k}>{k}</Tag>)}</div>
        </div>
      </div>
      <div className="stack" style={{ gap: 6 }}>
        <span className="label">{t.queue.reviewer}</span>
        {r.review.length === 0 ? (
          <span className="meta">{t.queue.reviewerNone}</span>
        ) : (
          <ul className="stack" style={{ gap: 6 }}>
            {r.review.map((i, n) => (
              <li key={n}>
                <span className="label">{i.location}:</span> {i.message} <span className="muted">{i.suggestion}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  )
}

function LetterPart({ id, editable }: { id: number; editable: boolean }) {
  const letter = useApi('letters.get', { id })
  const [body, setBody] = useDraft(letter.data?.body ?? '')
  const update = useAction('letters.update')
  if (!letter.data) return null
  return (
    <Section title={t.queue.coverLetter}>
      {letter.data.issues.map((i) => (
        <InlineAlert key={i.rule + i.excerpt}>
          {i.message} <span className="muted">({i.excerpt})</span>
        </InlineAlert>
      ))}
      {editable ? (
        <TextField aria-label={t.queue.coverLetter} multiline tall value={body} onChange={setBody} onBlur={() => body !== letter.data!.body && update.mutate({ id, body })} inputClassName="prose" />
      ) : (
        <p className="pre">{letter.data.body}</p>
      )}
    </Section>
  )
}

function PackagePane({ id }: { id: number }) {
  const pkg = useApi('packages.get', { id })
  const approve = useAction('packages.approve', { onSuccess: () => toast.info(t.queue.approved(pkg.data?.company ?? '')) })
  const skip = useAction('packages.skip')
  const regenerate = useAction('packages.regenerate')
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, [role=listbox]') || e.metaKey || e.ctrlKey) return
      if (e.key === 'a' && pkg.data?.status === 'ready' && !pkg.data.needsUser) approve.mutate({ id })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [id, pkg.data, approve])
  if (pkg.isError) return <Empty title={t.common.notFound} />
  const p = pkg.data
  if (!p) return null
  const editable = p.status === 'ready'
  const needs = p.answers.filter((a) => a.needsUser).length
  return (
    <div className="detail">
      <div className="detail-head">
        <h2>{p.title}</h2>
        <div className="row-wrap meta">
          <span>{p.company}</span>
          {p.score !== null && <Meter value={p.score} label={t.jobs.scoreLabel(p.score)} onPress={() => navigate('/jobs', { view: 'all', job: p.jobId })} />}
          {p.huntName && <span>{p.huntName}</span>}
          <Status tone={p.status === 'failed' ? 'danger' : p.status === 'ready' ? undefined : 'info'}>{t.queue.status[p.status]}</Status>
          {p.cost > 0 && <span>{t.queue.cost(dollars(p.cost))}</span>}
        </div>
      </div>

      {p.status === 'preparing' && <Working text={t.queue.preparing} />}
      {p.status === 'failed' && (
        <InlineAlert tone="danger" actions={<Button size="sm" onPress={() => regenerate.mutate({ id })}>{t.common.retry}</Button>}>
          {t.queue.failed}: {p.error}
        </InlineAlert>
      )}
      {p.error && p.status !== 'failed' && <InlineAlert>{p.error}</InlineAlert>}

      {editable && (
        <div className="detail-actions">
          <Button variant="primary" kbd="A" isDisabled={needs > 0 || approve.isPending} onPress={() => approve.mutate({ id })}>
            {t.queue.approve}
          </Button>
          <Button isDisabled={needs > 0 || approve.isPending} onPress={() => approve.mutate({ id, mode: 'assisted' })}>
            {t.queue.approveAssisted}
          </Button>
          <Menu label={t.queue.skip} trigger={<Button kbd="S">{t.queue.skip}</Button>} items={Object.entries(t.jobs.skipReasons).map(([k, label]) => ({ id: k, label, onAction: () => skip.mutate({ id, reason: k as never }) }))} />
          <Button variant="quiet" onPress={() => regenerate.mutate({ id })}>
            {t.queue.regenerate}
          </Button>
          {needs > 0 && <Status tone="attention">{t.queue.needsAnswer(needs)}</Status>}
        </div>
      )}

      {p.gates.length > 0 && (
        <Section title={t.queue.gates}>
          <Gates p={p} />
        </Section>
      )}

      {p.status !== 'preparing' && (
        <Section title={t.queue.answers}>
          <p className="meta">{p.form ? (p.form.source === 'cached' ? t.queue.answersCached(p.form.count) : t.queue.answersFromApi(p.form.count)) : t.queue.answersNone}</p>
          {p.answers.length > 0 && (
            <div>
              {[...p.answers]
                .sort((a, b) => Number(b.needsUser) - Number(a.needsUser))
                .map((a) => (
                  <AnswerRow key={a.fieldName} pkgId={id} a={a} editable={editable} />
                ))}
            </div>
          )}
        </Section>
      )}

      {p.resumeId && <ResumePart id={p.resumeId} />}
      {p.coverLetterId ? <LetterPart id={p.coverLetterId} editable={editable} /> : p.status !== 'preparing' && <Section title={t.queue.coverLetter}><p className="meta">{t.queue.noLetter}</p></Section>}
    </div>
  )
}

export function Queue() {
  const [filterParam, setFilter] = useParam('filter')
  const [pkgParam, setPkg] = useParam('pkg')
  const filter = (FILTERS.includes(filterParam as never) ? filterParam : 'queue') as (typeof FILTERS)[number]
  const list = useApi('packages.list', { filter }, { refetchInterval: filter === 'queue' ? 15_000 : false })
  const rows = list.data ?? []
  const selected = pkgParam ? Number(pkgParam) : null
  const [checked, setChecked] = useState<Set<string>>(new Set())
  useAutoSelect(rows[0]?.id, selected, setPkg)
  const approveMany = async () => {
    const r = await call('packages.approveMany', { ids: [...checked].map(Number) })
    setChecked(new Set())
    toast.info(t.queue.approvedMany(r.approved.length, r.failed.length, r.failed[0]?.message ?? ''))
  }
  return (
    <>
      <PageHead title={t.queue.title}>
        {checked.size > 1 && (
          <Button variant="primary" onPress={() => void approveMany()}>
            {t.queue.approveMany(checked.size)}
          </Button>
        )}
        <Segmented label={t.queue.title} value={filter} onChange={(v) => { setFilter(v); setPkg(null) }} options={FILTERS.map((f) => ({ id: f, label: t.queue.filters[f]! }))} />
      </PageHead>
      <div className="page-body">
        {list.data && rows.length === 0 ? (
          <Empty title={t.queue.empty} body={t.queue.emptyBody} action={<Button onPress={() => navigate('/hunts')}>{t.queue.openHunts}</Button>} />
        ) : (
          <Split
            list={
              <RowList
                label={t.queue.title}
                multiple={filter === 'queue'}
                checked={checked}
                onChecked={setChecked}
                rows={rows.map((p) => ({
                  id: p.id,
                  textValue: `${p.title} ${p.company}`,
                  line1: (
                    <>
                      <span className="truncate" style={{ flex: 1 }}>
                        {p.title}
                      </span>
                      <Meter value={p.score} label={t.jobs.scoreLabel(p.score ?? 0)} />
                    </>
                  ),
                  line2: (
                    <>
                      <span className="truncate">{p.company}</span>
                      {p.status !== 'ready' && <Tag tone={p.status === 'failed' ? 'danger' : undefined}>{t.queue.status[p.status]}</Tag>}
                      {p.needsUser > 0 && <Tag tone="attention">{t.queue.needsAnswer(p.needsUser)}</Tag>}
                    </>
                  ),
                }))}
                selected={selected}
                onSelect={(id) => setPkg(id)}
                onKey={(k, id) => {
                  if (k === 's') void call('packages.skip', { id: Number(id), reason: null })
                }}
              />
            }
            detail={selected ? <PackagePane key={selected} id={selected} /> : <Empty title={t.queue.select} />}
          />
        )}
      </div>
    </>
  )
}
