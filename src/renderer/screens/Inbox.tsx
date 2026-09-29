import { useState } from 'react'
import type { InboxItem } from '../../shared/api/mail'
import { PageHead, RowList, Split } from '../components/layout'
import { Button, Empty, InlineAlert, SearchInput, Section, Segmented, Select, Tag, Working } from '../components/ui'
import { useAction, useApi } from '../lib/api'
import { ago, dateTime } from '../lib/format'
import { navigate, useParam } from '../lib/router'
import { toast } from '../lib/toast'
import { useAutoSelect } from '../lib/hooks'
import { t } from '../strings/en'

const FILTERS = ['review', 'linked', 'all'] as const

function MessagePane({ item }: { item: InboxItem }) {
  const body = useApi('inbox.body', { id: item.id })
  const resolve = useAction('inbox.resolve')
  const dismiss = useAction('inbox.dismiss')
  const apps = useApi('applications.list', { q: '', statuses: [], huntId: null, archived: false })
  const [pick, setPick] = useState<string | null>(null)
  return (
    <div className="detail">
      <div className="detail-head">
        <h2>{item.subject || t.common.none}</h2>
        <div className="row-wrap meta">
          <span>
            {item.fromName ? `${item.fromName} <${item.from}>` : item.from}
          </span>
          <span>{dateTime(item.date)}</span>
          {item.category && <Tag>{t.inbox.category[item.category]}</Tag>}
        </div>
      </div>

      {item.code && (
        <InlineAlert tone="info" actions={<Button size="sm" onPress={() => void navigator.clipboard.writeText(item.code!).then(() => toast.info(t.common.copied))}>{t.common.copy}</Button>}>
          {t.inbox.code}: <span className="mono">{item.code}</span>
        </InlineAlert>
      )}

      <Section title={t.inbox.linkTo}>
        {item.applicationId ? (
          <div className="row">
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault()
                navigate('/applications', { app: item.applicationId })
              }}
            >
              {item.company}: {item.title}
            </a>
          </div>
        ) : (
          <p className="meta">{t.inbox.notLinked}</p>
        )}
        {item.needsReview && (
          <div className="stack">
            {item.suggestions.length > 0 && <span className="label">{t.inbox.suggestions}</span>}
            {item.suggestions.map((s) => (
              <div key={s.applicationId} className="row">
                <span>
                  {s.company}: {s.title}
                </span>
                <span className="spacer" />
                <Button size="sm" onPress={() => resolve.mutate({ id: item.id, applicationId: s.applicationId, status: null })}>
                  {t.inbox.confirm}
                </Button>
                {item.suggestedStatus && (
                  <Button size="sm" variant="primary" onPress={() => resolve.mutate({ id: item.id, applicationId: s.applicationId, status: item.suggestedStatus })}>
                    {t.inbox.confirmAndSet(t.status[item.suggestedStatus]!)}
                  </Button>
                )}
              </div>
            ))}
            <div className="row">
              <Select ariaLabel={t.inbox.linkTo} value={pick} onChange={setPick} options={(apps.data ?? []).map((a) => ({ id: String(a.id), label: `${a.company}: ${a.title}` }))} />
              <Button size="sm" isDisabled={!pick} onPress={() => pick && resolve.mutate({ id: item.id, applicationId: Number(pick), status: item.suggestedStatus })}>
                {t.inbox.confirm}
              </Button>
              <Button size="sm" variant="quiet" onPress={() => dismiss.mutate({ id: item.id })}>
                {t.inbox.dismiss}
              </Button>
            </div>
          </div>
        )}
      </Section>

      <Section title={t.nav.inbox}>
        {body.isPending ? <Working text={t.inbox.loadingBody} /> : body.error ? <p className="pre">{item.snippet}</p> : <p className="pre">{body.data?.text || item.snippet}</p>}
      </Section>
    </div>
  )
}

export function Inbox() {
  const [filterParam, setFilter] = useParam('filter')
  const [msgParam, setMsg] = useParam('message')
  const [q, setQ] = useState('')
  const filter = (FILTERS.includes(filterParam as never) ? filterParam : 'all') as (typeof FILTERS)[number]
  const accounts = useApi('mail.accounts', undefined)
  const list = useApi('inbox.list', { filter, q })
  const sync = useAction('mail.syncNow')
  const rows = list.data ?? []
  const selected = msgParam ? Number(msgParam) : null
  const item = rows.find((r) => r.id === selected)
  useAutoSelect(rows[0]?.id, selected, setMsg)
  const last = Math.max(0, ...(accounts.data ?? []).map((a) => a.lastSyncAt ?? 0))
  const noAccount = accounts.data && accounts.data.length === 0
  return (
    <>
      <PageHead title={t.inbox.title}>
        {last > 0 && <span className="meta">{t.inbox.lastSync(ago(last))}</span>}
        {!noAccount && (
          <Button onPress={() => sync.mutate({ id: null })} isDisabled={sync.isPending}>
            {t.inbox.syncNow}
          </Button>
        )}
        <Segmented label={t.inbox.title} value={filter} onChange={(v) => { setFilter(v); setMsg(null) }} options={FILTERS.map((f) => ({ id: f, label: t.inbox.filters[f]! }))} />
      </PageHead>
      <div className="toolbar">
        <SearchInput label={t.common.search} value={q} onChange={setQ} />
      </div>
      <div className="page-body">
        {noAccount ? (
          <Empty title={t.inbox.emptyAll} body={t.inbox.emptyAllBody} action={<Button variant="primary" onPress={() => navigate('/settings', { tab: 'email' })}>{t.inbox.connect}</Button>} />
        ) : list.data && rows.length === 0 ? (
          <Empty title={filter === 'review' ? t.inbox.empty : t.inbox.emptyAll} body={filter === 'review' ? t.inbox.emptyBody : t.inbox.emptyAllBody} />
        ) : (
          <Split
            list={
              <RowList
                label={t.inbox.title}
                rows={rows.map((m) => ({
                  id: m.id,
                  textValue: `${m.fromName} ${m.subject}`,
                  line1: (
                    <>
                      <span className="truncate" style={{ flex: 1 }}>
                        {m.fromName || m.from}
                      </span>
                      <span className="meta">{ago(m.date)}</span>
                    </>
                  ),
                  line2: (
                    <>
                      {m.category && <Tag tone={m.needsReview ? 'attention' : m.category === 'rejection' ? undefined : m.category === 'interview_request' || m.category === 'offer' ? 'accent' : undefined}>{t.inbox.category[m.category]}</Tag>}
                      <span className="truncate">{m.subject}</span>
                    </>
                  ),
                }))}
                selected={selected}
                onSelect={(id) => setMsg(id)}
              />
            }
            detail={item ? <MessagePane key={item.id} item={item} /> : <Empty title={t.inbox.select} />}
          />
        )}
      </div>
    </>
  )
}
