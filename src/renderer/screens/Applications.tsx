import { DotsThreeIcon, DownloadSimpleIcon, PlusIcon, UploadSimpleIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import type { Analytics, ImportPreview } from '../../shared/api/applications'
import type { ApplicationSummary, AppStatus } from '../../shared/domain'
import { PageHead } from '../components/layout'
import { Button, Checkbox, Empty, FormDialog, IconButton, InlineAlert, Menu, SearchInput, Section, Segmented, Select, Status } from '../components/ui'
import { call, useAction, useApi } from '../lib/api'
import { bridge } from '../lib/bridge'
import { ago, date, dollars, pct } from '../lib/format'
import { useParam } from '../lib/router'
import { toast } from '../lib/toast'
import { t } from '../strings/en'
import { AddApplication, ApplicationPanel, statusTone } from './ApplicationDetail'

const COLUMNS: { id: string; statuses: AppStatus[]; drop: AppStatus | null }[] = [
  { id: 'active', statuses: ['queued', 'applying', 'needs_user', 'failed'], drop: null },
  { id: 'applied', statuses: ['applied', 'applied_unverified', 'ghosted'], drop: 'applied' },
  { id: 'screening', statuses: ['screening'], drop: 'screening' },
  { id: 'interviewing', statuses: ['interviewing'], drop: 'interviewing' },
  { id: 'offer', statuses: ['offer', 'accepted'], drop: 'offer' },
  { id: 'closed', statuses: ['rejected', 'withdrawn', 'declined'], drop: 'rejected' },
]

function Board({ rows, onOpen }: { rows: ApplicationSummary[]; onOpen: (id: number) => void }) {
  const setStatus = useAction('applications.setStatus')
  const [over, setOver] = useState<string | null>(null)
  const move = (id: number, to: AppStatus) => setStatus.mutate({ ids: [id], status: to })
  return (
    <div className="board">
      {COLUMNS.map((c) => {
        const items = rows.filter((r) => c.statuses.includes(r.status))
        return (
          <section
            key={c.id}
            className="board-col"
            aria-label={t.applications.columns[c.id]}
            data-drop-target={over === c.id && !!c.drop}
            onDragOver={(e) => {
              if (!c.drop) return
              e.preventDefault()
              setOver(c.id)
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => {
              setOver(null)
              const id = Number(e.dataTransfer.getData('text/plain'))
              if (c.drop && id) move(id, c.drop)
            }}
          >
            <h3>
              {t.applications.columns[c.id]} <span className="num">{items.length}</span>
            </h3>
            <div className="board-items">
              {items.map((a) => (
                <div
                  key={a.id}
                  className="board-card"
                  tabIndex={0}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('text/plain', String(a.id))}
                  onClick={() => onOpen(a.id)}
                  onKeyDown={(e) => e.key === 'Enter' && onOpen(a.id)}
                  aria-label={`${a.company}, ${a.title}, ${t.status[a.status]}`}
                >
                  <div className="row">
                    <span className="co truncate" style={{ flex: 1 }}>
                      {a.company}
                    </span>
                    <Menu
                      label={t.applications.moveTo}
                      trigger={<IconButton size="sm" label={t.applications.moveTo} icon={<DotsThreeIcon aria-hidden />} />}
                      items={COLUMNS.filter((x) => x.drop && x.id !== c.id).map((x) => ({ id: x.id, label: `${t.applications.moveTo} ${t.applications.columns[x.id]!.toLowerCase()}`, onAction: () => move(a.id, x.drop!) }))}
                    />
                  </div>
                  <div className="t truncate">{a.title}</div>
                  <div className="row meta">
                    {c.statuses.length > 1 && <Status tone={statusTone(a.status)}>{t.status[a.status]}</Status>}
                    <span className="spacer" />
                    <span>{ago(a.lastActivityAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

type SortKey = 'company' | 'status' | 'appliedAt' | 'lastActivityAt'

function Table({ rows, onOpen }: { rows: ApplicationSummary[]; onOpen: (id: number) => void }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'lastActivityAt', dir: -1 })
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const setStatus = useAction('applications.setStatus')
  const archive = useAction('applications.archive')
  const sorted = [...rows].sort((a, b) => {
    const va = a[sort.key] ?? 0
    const vb = b[sort.key] ?? 0
    return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir
  })
  const head = (key: SortKey, label: string) => (
    <th aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="btn btn-quiet btn-sm" onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : -1 }))}>
        {label}
      </button>
    </th>
  )
  const ids = [...checked]
  return (
    <div>
      {checked.size > 0 && (
        <div className="toolbar">
          <span className="label">{t.common.selected(ids.length)}</span>
          <Menu
            label={t.applications.setStatus}
            trigger={<Button size="sm">{t.applications.setStatus}</Button>}
            items={(['applied', 'screening', 'interviewing', 'offer', 'rejected', 'withdrawn'] as AppStatus[]).map((s) => ({ id: s, label: t.status[s]!, onAction: () => setStatus.mutate({ ids, status: s }) }))}
          />
          <Button size="sm" onPress={() => archive.mutate({ ids, archived: true }, { onSuccess: () => setChecked(new Set()) })}>
            {t.applications.archive}
          </Button>
        </div>
      )}
      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 32 }}>
              <Checkbox aria-label={t.common.selectAll} isSelected={checked.size === rows.length && rows.length > 0} onChange={(on) => setChecked(on ? new Set(rows.map((r) => r.id)) : new Set())}>
                <span className="visually-hidden">{t.common.selectAll}</span>
              </Checkbox>
            </th>
            {head('company', t.applications.fields.company)}
            <th>{t.applications.fields.title}</th>
            {head('status', t.applications.fields.status)}
            {head('appliedAt', t.applications.fields.appliedOn)}
            {head('lastActivityAt', t.applications.fields.lastActivity)}
            <th>{t.applications.fields.hunt}</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((a) => (
            <tr key={a.id} data-href data-selected={checked.has(a.id) || undefined} onClick={(e) => !(e.target as HTMLElement).closest('label, button') && onOpen(a.id)}>
              <td>
                <Checkbox aria-label={`${a.company} ${a.title}`} isSelected={checked.has(a.id)} onChange={(on) => setChecked((s) => { const n = new Set(s); if (on) n.add(a.id); else n.delete(a.id); return n })}>
                  <span className="visually-hidden">{a.company}</span>
                </Checkbox>
              </td>
              <td className="label">{a.company}</td>
              <td className="truncate" style={{ maxWidth: 320 }}>
                {a.title}
              </td>
              <td>
                <Status tone={statusTone(a.status)}>{t.status[a.status]}</Status>
              </td>
              <td className="num">{date(a.appliedAt)}</td>
              <td className="num meta">{ago(a.lastActivityAt)}</td>
              <td className="meta">{a.huntName}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Rates({ title, rows }: { title: string; rows: Analytics['byChannel'] }) {
  if (!rows.length) return null
  return (
    <Section title={title}>
      <table className="table table-compact">
        <thead>
          <tr>
            <th>{t.analytics.group}</th>
            <th className="right">{t.analytics.applied}</th>
            <th className="right">{t.analytics.responded}</th>
            <th className="right">{t.analytics.rate}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.key}</td>
              <td className="right">{r.applied}</td>
              <td className="right">{r.responded}</td>
              <td className="right">{pct(r.rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  )
}

function Results() {
  const [range, setRange] = useState<'30d' | '90d' | 'all'>('90d')
  const a = useApi('analytics.summary', { range }).data
  if (!a) return null
  const stages: [string, number][] = [
    ['applied', a.applied],
    ['responded', a.responded],
    ['screen', a.screen],
    ['interview', a.interview],
    ['offer', a.offer],
  ]
  const maxWeek = Math.max(1, ...a.weekly.map((w) => w.applied))
  return (
    <div className="page-narrow stack-lg" style={{ maxWidth: 1040 }}>
      <Segmented label={t.analytics.title} value={range} onChange={setRange} options={(['30d', '90d', 'all'] as const).map((r) => ({ id: r, label: t.analytics.range[r]! }))} />
      <Section title={t.analytics.funnel}>
        <div className="funnel">
          {stages.map(([k, n]) => (
            <div key={k} style={{ display: 'contents' }}>
              <span>{t.analytics.stages[k]}</span>
              <div className="bar-wide">
                <i style={{ width: `${a.applied ? (n / a.applied) * 100 : 0}%` }} />
              </div>
              <span className="right">{k === 'applied' ? n : t.analytics.of(n, a.applied)}</span>
            </div>
          ))}
        </div>
        <p className="stats-line">
          <span>{t.analytics.median(a.medianDaysToResponse)}</span>
          <span>{t.analytics.ghosted(a.ghosted, a.applied)}</span>
        </p>
      </Section>
      <Section title={t.analytics.notes}>{a.notes.length ? a.notes.map((n) => <p key={n}>{n}</p>) : <p className="meta">{t.analytics.notesEmpty}</p>}</Section>
      <Section title={t.analytics.weekly}>
        <div className="chart" role="img" aria-label={a.weekly.map((w) => `${date(w.week)}: ${w.applied} applied, ${w.responses} responses`).join('; ')}>
          {a.weekly.map((w) => (
            <div key={w.week} className="col" title={`${date(w.week)}: ${w.applied} / ${w.responses}`}>
              <i style={{ height: `${(w.applied / maxWeek) * 100}%` }} />
              <span>{date(w.week)}</span>
            </div>
          ))}
        </div>
        <table className="table table-compact">
          <thead>
            <tr>
              <th>{t.analytics.weekly}</th>
              <th className="right">{t.analytics.weeklyApplied}</th>
              <th className="right">{t.analytics.weeklyResponses}</th>
              <th className="right">{t.analytics.spend}</th>
            </tr>
          </thead>
          <tbody>
            {[...a.weekly].reverse().slice(0, 6).map((w) => (
              <tr key={w.week}>
                <td>{date(w.week)}</td>
                <td className="right">{w.applied}</td>
                <td className="right">{w.responses}</td>
                <td className="right">{dollars(w.spend)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <div className="grid-2">
        <Rates title={t.analytics.byChannel} rows={a.byChannel} />
        <Rates title={t.analytics.byDays} rows={a.byDaysAfterPosting} />
        <Rates title={t.analytics.byTemplate} rows={a.byTemplate} />
        <Rates title={t.analytics.byHunt} rows={a.byHunt} />
      </div>
      <Section title={t.analytics.spend}>
        <p className="stats-line">
          <span>{t.analytics.spendTotal(dollars(a.spend.total))}</span>
          {a.spend.perApplication !== null && <span>{t.analytics.spendPer(dollars(a.spend.perApplication))}</span>}
        </p>
      </Section>
    </div>
  )
}

function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [path, setPath] = useState<string | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [mapping, setMapping] = useState<ImportPreview['mapping']>({})
  const run = useAction('applications.import', {
    onSuccess: (r) => {
      toast.info(t.applications.importDone(r))
      onClose()
    },
  })
  const choose = async () => {
    const [p] = await bridge.host.pickFile({ extensions: ['csv'] })
    if (!p) return
    setPath(p)
    const pv = await call('applications.importPreview', { path: p })
    setPreview(pv)
    setMapping(pv.mapping)
  }
  return (
    <FormDialog open={open} onClose={onClose} title={t.applications.importTitle} wide submitLabel={preview ? t.applications.importRun(preview.rows) : t.applications.import} valid={!!path && !!mapping.company && !!mapping.title} onSubmit={() => path && run.mutate({ path, mapping })}>
      <p className="muted">{t.applications.importBody}</p>
      <div>
        <Button onPress={() => void choose()}>{t.applications.importChoose}</Button>
      </div>
      {preview && (
        <div className="grid-2">
          {(['company', 'title', 'status', 'appliedAt', 'url', 'notes'] as const).map((f) => (
            <Select
              key={f}
              label={t.applications.importField[f]}
              value={mapping[f] ?? '__none'}
              onChange={(v) => setMapping((m) => ({ ...m, [f]: v === '__none' ? undefined : v }))}
              options={[{ id: '__none', label: t.applications.notMapped }, ...preview.headers.map((h) => ({ id: h, label: h }))]}
            />
          ))}
        </div>
      )}
      {run.error && <InlineAlert tone="danger">{run.error.message}</InlineAlert>}
    </FormDialog>
  )
}

export function Applications() {
  const [viewParam, setView] = useParam('view')
  const [appParam, setApp] = useParam('app')
  const [addParam, setAdd] = useParam('add')
  const [importing, setImporting] = useState(false)
  const [archived, setArchived] = useState(false)
  const [q, setQ] = useState('')
  const view = viewParam === 'table' || viewParam === 'results' ? viewParam : 'board'
  const list = useApi('applications.list', { q, statuses: [], huntId: null, archived })
  const rows = list.data ?? []
  const exportAs = async (format: 'csv' | 'json') => {
    const path = await bridge.host.saveFile({ defaultPath: `applications.${format}`, extensions: [format] })
    if (path) await call('applications.export', { format, path })
  }
  return (
    <>
      <PageHead title={t.applications.title}>
        <Segmented
          label={t.applications.title}
          value={view}
          onChange={(v) => setView(v)}
          options={[
            { id: 'board', label: t.applications.board },
            { id: 'table', label: t.applications.table },
            { id: 'results', label: t.applications.analytics },
          ]}
        />
        <Menu
          label={t.applications.export}
          trigger={
            <Button>
              <DownloadSimpleIcon aria-hidden />
              {t.applications.export}
            </Button>
          }
          items={[
            { id: 'csv', label: t.applications.exportCsv, onAction: () => void exportAs('csv') },
            { id: 'json', label: t.applications.exportJson, onAction: () => void exportAs('json') },
          ]}
        />
        <Button onPress={() => setImporting(true)}>
          <UploadSimpleIcon aria-hidden />
          {t.applications.import}
        </Button>
        <Button variant="primary" onPress={() => setAdd(1)}>
          <PlusIcon aria-hidden />
          {t.applications.add}
        </Button>
      </PageHead>
      {view !== 'results' && (
        <div className="toolbar">
          <SearchInput label={t.applications.search} value={q} onChange={setQ} />
          <Checkbox isSelected={archived} onChange={setArchived}>
            {t.applications.showArchived}
          </Checkbox>
        </div>
      )}
      <div className="page-body" style={{ position: 'relative', display: 'flex' }}>
        <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
          {view === 'results' ? (
            <Results />
          ) : list.data && rows.length === 0 && !q ? (
            <Empty title={t.applications.empty} body={t.applications.emptyBody} action={<Button onPress={() => setAdd(1)}>{t.applications.add}</Button>} />
          ) : view === 'table' ? (
            <Table rows={rows} onOpen={(id) => setApp(id)} />
          ) : (
            <Board rows={rows} onOpen={(id) => setApp(id)} />
          )}
        </div>
        {appParam && view !== 'results' && (
          <aside style={{ width: 'min(560px, 48%)', borderLeft: '1px solid var(--border)', overflow: 'auto', background: 'var(--surface)' }} aria-label={t.applications.title}>
            <ApplicationPanel key={appParam} id={Number(appParam)} onClose={() => setApp(null)} />
          </aside>
        )}
      </div>
      <AddApplication open={addParam === '1'} onClose={() => setAdd(null)} />
      <ImportDialog open={importing} onClose={() => setImporting(false)} />
    </>
  )
}
