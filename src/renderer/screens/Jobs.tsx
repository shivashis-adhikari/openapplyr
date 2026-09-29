import { ArrowSquareOutIcon, PlusIcon, WarningIcon } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import type { JobDetail, JobScore, JobSummary } from '../../shared/domain'
import { PageHead, RowList, Split } from '../components/layout'
import { Posting } from '../components/Posting'
import { Button, Checkbox, Dialogue, Empty, InlineAlert, Menu, Meter, SearchInput, Section, Select, Tag, TextField, Working } from '../components/ui'
import { call, useAction, useApi } from '../lib/api'
import { bridge } from '../lib/bridge'
import { ago, salary } from '../lib/format'
import { navigate, useParam } from '../lib/router'
import { toast } from '../lib/toast'
import { useAutoSelect } from '../lib/hooks'
import { t } from '../strings/en'
import { statusTone } from './ApplicationDetail'

const VIEWS = ['matches', 'new', 'all', 'saved', 'skipped', 'filtered', 'applied'] as const
type View = (typeof VIEWS)[number]

function Breakdown({ score, open, onClose }: { score: JobScore; open: boolean; onClose: () => void }) {
  const b = score.breakdown
  return (
    <Dialogue open={open} onOpenChange={(o) => !o && onClose()} title={t.jobs.breakdown} wide footer={<Button onPress={onClose}>{t.common.close}</Button>}>
      {b && <p>{t.jobs.breakdownParts(b)}</p>}
      {b?.capped && <InlineAlert>{t.jobs.capped}</InlineAlert>}
      {score.judgment?.summary && <p className="muted">{score.judgment.summary}</p>}
      <Requirements score={score} />
    </Dialogue>
  )
}

function Requirements({ score }: { score: JobScore }) {
  const reqs = score.judgment?.requirements ?? []
  if (!reqs.length) return null
  return (
    <div>
      {reqs.map((r, i) => (
        <div key={i} className="req" data-verdict={r.verdict}>
          <span className="v">{t.jobs.verdict[r.verdict]}</span>
          <div>
            <div>
              {r.text} {r.kind === 'nice' && <span className="meta">{t.jobs.niceToHave}</span>}
            </div>
            {r.note && <div className="meta">{r.note}</div>}
          </div>
        </div>
      ))}
    </div>
  )
}

function JobPane({ id, huntId }: { id: number; huntId: number | null }) {
  const job = useApi('jobs.get', { id })
  const [breakdown, setBreakdown] = useState(false)
  const setState = useAction('jobs.setState')
  const prepare = useAction('packages.prepareNow')
  if (job.isError) return <Empty title={t.common.notFound} />
  if (!job.data) return null
  const j: JobDetail = job.data
  const score = j.scores.find((s) => s.huntId === huntId) ?? j.scores.find((s) => s.stage === 'judged') ?? j.scores[0] ?? null
  const skip = (reason: string) => {
    setState.mutate(
      { id: j.id, state: 'skipped', reason: reason as never, huntId: score?.huntId ?? null },
      { onSuccess: () => toast.undo(t.jobs.skipped(j.company), t.common.undo, () => void call('jobs.setState', { id: j.id, state: null })) },
    )
  }
  const warnings = j.signals.filter((s) => s.severity !== 'info')
  return (
    <div className="detail">
      <div className="detail-head">
        <h2>{j.title}</h2>
        <div className="row-wrap meta">
          <span>{j.company}</span>
          {j.location && <span>{j.location}</span>}
          {t.jobs.remote[j.remote] && <Tag>{t.jobs.remote[j.remote]}</Tag>}
          {j.salary && <span className="num">{salary(j.salary)}</span>}
          <span>{j.postedAt ? t.jobs.posted(ago(j.postedAt)) : t.jobs.seen(ago(j.firstSeenAt))}</span>
        </div>
      </div>
      {j.closed && <InlineAlert tone="info">{t.jobs.closed}</InlineAlert>}
      <div className="detail-actions">
        {j.applicationId ? (
          <Button variant="primary" onPress={() => navigate('/applications', { app: j.applicationId })}>
            {t.jobs.openApplication}
          </Button>
        ) : j.packageId ? (
          <Button variant="primary" onPress={() => navigate('/queue', { pkg: j.packageId })}>
            {t.jobs.viewPackage}
          </Button>
        ) : (
          <Button variant="primary" isDisabled={j.closed || prepare.isPending || prepare.isSuccess} onPress={() => prepare.mutate({ jobId: j.id, huntId: score?.huntId ?? null })}>
            {prepare.isSuccess ? t.jobs.preparing : t.jobs.prepare}
          </Button>
        )}
        <Button onPress={() => setState.mutate({ id: j.id, state: j.userState === 'saved' ? null : 'saved' })}>{j.userState === 'saved' ? t.jobs.unsave : t.jobs.save}</Button>
        <Menu
          label={t.jobs.skip}
          trigger={<Button>{t.jobs.skip}</Button>}
          items={Object.entries(t.jobs.skipReasons).map(([k, label]) => ({ id: k, label, onAction: () => skip(k) }))}
        />
        <Button variant="quiet" onPress={() => void bridge.host.openExternal(j.url)}>
          <ArrowSquareOutIcon aria-hidden />
          {t.common.openPosting}
        </Button>
      </div>

      {score && (
        <Section title={score.stage === 'judged' ? t.jobs.score : score.stage === 'filtered' ? t.jobs.filteredBecause : t.jobs.notScored}>
          {score.stage === 'judged' && (
            <div className="row">
              <Meter value={score.score} label={t.jobs.scoreLabel(score.score ?? 0)} onPress={() => setBreakdown(true)} />
              <span className="meta">{score.huntName}</span>
              <Button size="sm" variant="quiet" onPress={() => setBreakdown(true)}>
                {t.jobs.breakdown}
              </Button>
            </div>
          )}
          {score.stage === 'filtered' && (
            <ul className="stack" style={{ gap: 4 }}>
              {score.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          {score.error && <InlineAlert tone="danger">{score.error}</InlineAlert>}
          {score.stage === 'judged' && <Requirements score={score} />}
          <Breakdown score={score} open={breakdown} onClose={() => setBreakdown(false)} />
        </Section>
      )}

      {warnings.length > 0 && (
        <Section title={t.jobs.signals}>
          <ul className="stack" style={{ gap: 6 }}>
            {warnings.map((s) => (
              <li key={s.kind + s.label} className="row" style={{ alignItems: 'flex-start' }}>
                <WarningIcon aria-hidden style={{ color: s.severity === 'block' ? 'var(--danger)' : 'var(--attention)', marginTop: 2, flex: 'none' }} />
                <span>
                  <span className="label">{s.label}.</span> <span className="muted">{s.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title={t.jobs.posting}>
        <Posting html={j.descriptionHtml} md={j.descriptionMd} />
      </Section>
    </div>
  )
}

function AddJob({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [url, setUrl] = useState('')
  const [text, setText] = useState('')
  const [pasting, setPasting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      const { id } = pasting ? await call('jobs.importText', { text, url: url || null }) : await call('jobs.importUrl', { url })
      onClose()
      navigate('/jobs', { view: 'all', job: id })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialogue
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t.jobs.importLink}
      footer={
        <>
          <Button onPress={onClose}>{t.common.cancel}</Button>
          <Button variant="primary" isDisabled={busy || (pasting ? text.length < 80 : !/^https?:\/\//.test(url))} onPress={() => void run()}>
            {t.jobs.add}
          </Button>
        </>
      }
    >
      <TextField label={t.jobs.importLinkLabel} placeholder={t.jobs.importLinkPlaceholder} value={url} onChange={setUrl} autoFocus />
      {pasting ? (
        <TextField label={t.jobs.importTextLabel} multiline tall value={text} onChange={setText} />
      ) : (
        <div>
          <Button size="sm" variant="quiet" onPress={() => setPasting(true)}>
            {t.jobs.importText}
          </Button>
        </div>
      )}
      {busy && <Working text={t.jobs.importing} />}
      {error && <InlineAlert tone="danger">{error}</InlineAlert>}
    </Dialogue>
  )
}

export function Jobs() {
  const [viewParam, setView] = useParam('view')
  const [jobParam, setJob] = useParam('job')
  const [huntParam, setHunt] = useParam('hunt')
  const [addParam, setAdd] = useParam('add')
  const view = (VIEWS.includes(viewParam as View) ? viewParam : 'matches') as View
  const huntId = huntParam ? Number(huntParam) : null
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const [hideWarnings, setHideWarnings] = useState(false)
  const [sort, setSort] = useState<'score' | 'newest'>('score')
  useEffect(() => {
    const h = setTimeout(() => setDebounced(q), 200)
    return () => clearTimeout(h)
  }, [q])
  const hunts = useApi('hunts.list', undefined)
  const list = useApi('jobs.list', { huntId, view, q: debounced, remote: [], employment: [], minScore: 0, hideWarnings, sort, limit: 300, offset: 0 })
  const rows = list.data?.rows ?? []
  const selected = jobParam ? Number(jobParam) : null

  useAutoSelect(rows[0]?.id, selected, setJob)

  const line2 = (j: JobSummary) => (
    <>
      <span className="truncate">{j.company}</span>
      {j.location && <span className="truncate">{j.location}</span>}
      {j.signals.some((s) => s.severity === 'block') && <Tag tone="danger">{j.signals.find((s) => s.severity === 'block')!.label}</Tag>}
      {j.applicationStatus && <Tag tone={statusTone(j.applicationStatus)}>{t.status[j.applicationStatus]}</Tag>}
      {!j.applicationStatus && j.packageStatus && <Tag>{t.queue.status[j.packageStatus]}</Tag>}
    </>
  )

  return (
    <>
      <PageHead title={t.jobs.title}>
        <Button onPress={() => setAdd(1)}>
          <PlusIcon aria-hidden />
          {t.jobs.importLink}
        </Button>
      </PageHead>
      <div className="toolbar">
        <SearchInput label={t.jobs.search} placeholder={t.jobs.searchPlaceholder} value={q} onChange={setQ} />
        <Select
          ariaLabel={t.jobs.allHunts}
          value={huntParam ?? 'all'}
          onChange={(v) => setHunt(v === 'all' ? null : v)}
          options={[{ id: 'all', label: t.jobs.allHunts }, ...(hunts.data ?? []).map((h) => ({ id: String(h.hunt.id), label: h.hunt.name }))]}
          className="toolbar-select"
        />
        <Select ariaLabel={t.common.sort} value={sort} onChange={setSort} options={[{ id: 'score', label: t.jobs.sortScore }, { id: 'newest', label: t.jobs.sortNewest }]} />
        <Checkbox isSelected={hideWarnings} onChange={setHideWarnings}>
          {t.jobs.hideWarnings}
        </Checkbox>
      </div>
      <div className="tabs">
        <div className="tablist" role="tablist" aria-label={t.jobs.title}>
          {VIEWS.map((v) => (
            <a
              key={v}
              role="tab"
              aria-selected={v === view}
              data-selected={v === view || undefined}
              className="tab"
              href={`#/jobs?view=${v}${huntParam ? `&hunt=${huntParam}` : ''}`}
              onClick={(e) => {
                e.preventDefault()
                setView(v)
                setJob(null)
              }}
            >
              {t.jobs.views[v]}
              {list.data && <span className="count num">{list.data.counts[v]}</span>}
            </a>
          ))}
        </div>
      </div>
      <div className="page-body">
        {list.data && rows.length === 0 ? (
          <Empty title={t.jobs.empty} body={view === 'matches' ? t.jobs.emptyMatches : t.jobs.emptyAll} action={<Button onPress={() => navigate('/hunts')}>{t.queue.openHunts}</Button>} />
        ) : (
          <Split
            list={
              <RowList
                label={t.jobs.title}
                rows={rows.map((j) => ({
                  id: j.id,
                  textValue: `${j.title} ${j.company}`,
                  line1: (
                    <>
                      <span className="truncate" style={{ flex: 1 }}>
                        {j.title}
                      </span>
                      <Meter value={j.score} label={t.jobs.scoreLabel(j.score ?? 0)} />
                    </>
                  ),
                  line2: line2(j),
                }))}
                selected={selected}
                onSelect={(id) => setJob(id)}
                onKey={(k, id) => {
                  if (k === 's') void call('jobs.setState', { id: Number(id), state: 'skipped', reason: 'other' })
                }}
              />
            }
            detail={selected ? <JobPane key={selected} id={selected} huntId={huntId} /> : <Empty title={t.jobs.select} />}
          />
        )}
      </div>
      <AddJob open={addParam === '1'} onClose={() => setAdd(null)} />
    </>
  )
}
