import { useState } from 'react'
import { PageHead, RowList, Split } from '../components/layout'
import { Button, Checkbox, Empty, InlineAlert, Section, Segmented, Status } from '../components/ui'
import { useAction, useApi } from '../lib/api'
import { bridge } from '../lib/bridge'
import { ago, dollars, time } from '../lib/format'
import { navigate, useParam } from '../lib/router'
import { useAutoSelect } from '../lib/hooks'
import { t } from '../strings/en'

const TABS = ['runs', 'tasks', 'sources', 'spend'] as const

function RunPane({ id }: { id: number }) {
  const run = useApi('runs.get', { id }, { refetchInterval: (q) => (q.state.data?.status === 'running' ? 1500 : false) })
  const stop = useAction('runs.stop')
  const reply = useAction('runs.reply')
  const again = useAction('applications.run')
  const [answer, setAnswer] = useState('')
  const r = run.data
  if (!r) return null
  const fieldName = r.fieldName
  return (
    <div className="detail">
      <div className="detail-head">
        <h2>
          {r.company}: {r.title}
        </h2>
        <div className="row-wrap meta">
          <span>{t.activity.run.mode[r.mode]}</span>
          <Status tone={r.status === 'failed' ? 'danger' : r.status === 'needs_user' ? 'attention' : r.status === 'running' ? 'info' : undefined}>{t.activity.run.status[r.status]}</Status>
          {r.adapter && <span>{t.activity.adapters[r.adapter] ?? r.adapter}</span>}
          <span>{ago(r.startedAt)}</span>
        </div>
      </div>
      {r.error && <InlineAlert tone="danger">{r.error}</InlineAlert>}
      {r.question && (r.status === 'needs_user' || r.status === 'paused') && (
        <InlineAlert>
          <p>{r.question}</p>
          <form
            className="row"
            style={{ marginTop: 8 }}
            onSubmit={(e) => {
              e.preventDefault()
              reply.mutate({ id, reply: fieldName && answer.trim() ? { kind: 'answer', fieldName, answer: answer.trim(), save: 'all' } : { kind: 'continue' } })
            }}
          >
            {fieldName && <input className="input" aria-label={t.activity.run.answerLabel} value={answer} onChange={(e) => setAnswer(e.target.value)} />}
            <Button size="sm" type="submit">
              {fieldName ? t.activity.run.answer : t.activity.run.continue}
            </Button>
          </form>
        </InlineAlert>
      )}
      <div className="detail-actions">
        {(r.status === 'running' || r.status === 'needs_user') && (
          <Button variant="danger" onPress={() => stop.mutate({ id })}>
            {t.activity.run.stop}
          </Button>
        )}
        {r.status === 'dry_run_done' && r.applicationId && (
          <>
            <Button variant="primary" onPress={() => again.mutate({ id: r.applicationId!, mode: 'submit' })}>
              {t.applications.sendForReal}
            </Button>
            <Button onPress={() => again.mutate({ id: r.applicationId!, mode: 'assisted' })}>{t.applications.fillForMe}</Button>
          </>
        )}
        {r.applicationId && (
          <Button variant="quiet" onPress={() => navigate('/applications', { app: r.applicationId })}>
            {t.activity.openApplication}
          </Button>
        )}
      </div>
      <Section title={t.activity.run.steps}>
        <ol className="steps">
          {r.steps.map((s, i) => (
            <li key={i} data-kind={s.kind}>
              <span className="k">{time(s.at)}</span>
              <span className="k">{s.kind}</span>
              <span>{s.text}</span>
            </li>
          ))}
        </ol>
      </Section>
      {r.evidence.length > 0 && (
        <Section title={t.activity.run.evidence} actions={<Button size="sm" variant="quiet" onPress={() => void bridge.host.reveal(r.evidence[0]!.path)}>{t.common.reveal}</Button>}>
          <ul className="row-wrap">
            {r.evidence.map((e) => (
              <li key={e.name} className="tag">
                {e.name}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  )
}

function Runs() {
  const [runParam, setRun] = useParam('run')
  const list = useApi('runs.list', { filter: 'recent', applicationId: null }, { refetchInterval: 5000 })
  const rows = list.data ?? []
  const selected = runParam ? Number(runParam) : null
  useAutoSelect(rows[0]?.id, selected, setRun)
  if (list.data && rows.length === 0) return <Empty title={t.activity.noRuns} body={t.activity.noRunsBody} />
  return (
    <Split
      list={
        <RowList
          label={t.activity.tabs['runs']!}
          rows={rows.map((r) => ({
            id: r.id,
            textValue: `${r.company} ${r.title}`,
            line1: (
              <>
                <span className="truncate" style={{ flex: 1 }}>
                  {r.company}
                </span>
                <Status tone={r.status === 'failed' ? 'danger' : r.status === 'needs_user' ? 'attention' : r.status === 'running' ? 'info' : undefined}>{t.activity.run.status[r.status]}</Status>
              </>
            ),
            line2: (
              <>
                <span className="truncate">{r.title}</span>
                <span>{ago(r.startedAt)}</span>
              </>
            ),
          }))}
          selected={selected}
          onSelect={(id) => setRun(id)}
        />
      }
      detail={selected ? <RunPane key={selected} id={selected} /> : null}
    />
  )
}

function Tasks() {
  const list = useApi('activity.tasks', { status: 'all', limit: 200 }, { refetchInterval: 5000 })
  const retry = useAction('activity.retryTask')
  const rows = list.data ?? []
  if (list.data && rows.length === 0) return <Empty title={t.activity.tasksEmpty} />
  return (
    <table className="table">
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>{r.label}</td>
            <td>
              <Status tone={r.status === 'failed' ? 'danger' : r.status === 'running' ? 'info' : undefined}>{r.status}</Status>
            </td>
            <td className="meta num">{r.status === 'pending' ? time(r.runAt) : ago(r.finishedAt ?? r.runAt)}</td>
            <td className="meta truncate" style={{ maxWidth: 420 }}>
              {r.lastError}
            </td>
            <td className="right">
              {r.status === 'failed' && (
                <Button size="sm" onPress={() => retry.mutate({ id: r.id })}>
                  {t.activity.retry}
                </Button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Sources() {
  const [onlyProblems, setOnly] = useState(true)
  const list = useApi('activity.sources', { onlyProblems, limit: 300 })
  return (
    <div>
      <div className="toolbar">
        <Checkbox isSelected={onlyProblems} onChange={setOnly}>
          {t.activity.sources.onlyProblems}
        </Checkbox>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>{t.activity.sources.name}</th>
            <th>{t.activity.sources.kind}</th>
            <th className="right">{t.activity.sources.jobs}</th>
            <th>{t.activity.sources.lastOk}</th>
            <th>{t.activity.sources.problem}</th>
          </tr>
        </thead>
        <tbody>
          {(list.data ?? []).map((s) => (
            <tr key={s.id}>
              <td>{s.label}</td>
              <td className="meta">{s.kind}</td>
              <td className="right">{s.jobCount}</td>
              <td className="meta">{ago(s.lastOkAt)}</td>
              <td className="meta truncate" style={{ maxWidth: 380 }}>
                {s.lastError}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Spend() {
  const usage = useApi('ai.usage', { days: 30 })
  const ledger = useApi('activity.ledger', { limit: 200 })
  const u = usage.data
  return (
    <div className="page-pad stack-lg">
      {u && (
        <p className="stats-line">
          <span>
            <b>{dollars(u.today.cost)}</b> today, {u.today.calls} calls
          </span>
          <span>
            <b>{dollars(u.month.cost)}</b> this month, {u.month.calls} calls
          </span>
        </p>
      )}
      {u && u.byTask.length > 0 && (
        <table className="table table-compact">
          <thead>
            <tr>
              <th>{t.activity.spend.task}</th>
              <th className="right">{t.activity.spend.cost}</th>
            </tr>
          </thead>
          <tbody>
            {u.byTask.map((x) => (
              <tr key={x.task}>
                <td>{x.task}</td>
                <td className="right">{dollars(x.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <table className="table table-compact">
        <thead>
          <tr>
            <th>{t.activity.spend.when}</th>
            <th>{t.activity.spend.model}</th>
            <th>{t.activity.spend.task}</th>
            <th className="right">{t.activity.spend.tokens}</th>
            <th className="right">{t.activity.spend.cost}</th>
          </tr>
        </thead>
        <tbody>
          {(ledger.data ?? []).map((r) => (
            <tr key={r.id}>
              <td className="meta">{ago(r.at)}</td>
              <td>{r.model}</td>
              <td>{r.task}</td>
              <td className="right">{(r.inputTokens ?? 0) + (r.outputTokens ?? 0)}</td>
              <td className="right">{r.cost === null ? t.activity.spend.unpriced : dollars(r.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function Activity() {
  const [tabParam, setTab] = useParam('tab')
  const tab = (TABS.includes(tabParam as never) ? tabParam : 'runs') as (typeof TABS)[number]
  return (
    <>
      <PageHead title={t.activity.title}>
        <Segmented label={t.activity.title} value={tab} onChange={(v) => setTab(v)} options={TABS.map((x) => ({ id: x, label: t.activity.tabs[x]! }))} />
      </PageHead>
      <div className="page-body">
        {tab === 'runs' && <Runs />}
        {tab === 'tasks' && <Tasks />}
        {tab === 'sources' && <Sources />}
        {tab === 'spend' && <Spend />}
      </div>
    </>
  )
}
