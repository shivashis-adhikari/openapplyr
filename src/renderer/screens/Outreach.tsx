import { PlusIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import type { ContactInfo, OutreachItem } from '../../shared/api/outreach'
import { PageHead, RowList, Split } from '../components/layout'
import { Button, Checkbox, Dialogue, Empty, FormDialog, InlineAlert, SearchInput, Section, Segmented, Status, Tag, TextField } from '../components/ui'
import { useAction, useApi } from '../lib/api'
import { ago, dateTime } from '../lib/format'
import { navigate, useParam } from '../lib/router'
import { useAutoSelect, useDraft } from '../lib/hooks'
import { t } from '../strings/en'

const TABS = ['drafts', 'scheduled', 'sent', 'contacts'] as const
type Tab = (typeof TABS)[number]

function Thread({ item }: { item: OutreachItem }) {
  const all = useApi('outreach.list', { filter: 'all', applicationId: item.applicationId })
  const steps = (all.data ?? []).filter((o) => o.threadKey === item.threadKey && o.id !== item.id)
  if (!steps.length) return null
  return (
    <Section title={t.outreach.followUps(steps.length)}>
      {steps.map((s) => (
        <details key={s.id} className="well">
          <summary className="row">
            <span className="label">{t.outreach.step(s.step)}</span>
            <span className="meta">{s.status === 'sent' ? t.outreach.sentAt(ago(s.sentAt)) : s.scheduledAt ? t.outreach.scheduledFor(dateTime(s.scheduledAt)) : ''}</span>
            <span className="spacer" />
            <Status tone={s.status === 'cancelled' || s.status === 'failed' ? 'danger' : undefined}>{s.status === 'cancelled' ? s.error ?? '' : ''}</Status>
          </summary>
          <p className="pre" style={{ marginTop: 8 }}>
            {s.body}
          </p>
        </details>
      ))}
    </Section>
  )
}

function MessagePane({ id }: { id: number }) {
  const list = useApi('outreach.list', { filter: 'all', applicationId: null })
  const item = list.data?.find((o) => o.id === id)
  const [subject, setSubject] = useDraft(item?.subject ?? '')
  const [body, setBody] = useDraft(item?.body ?? '')
  const [confirm, setConfirm] = useState(false)
  const mail = useApi('mail.accounts', undefined)
  const update = useAction('outreach.update')
  const approve = useAction('outreach.approve')
  const cancel = useAction('outreach.cancel')
  const sendNow = useAction('outreach.sendNow', { onSuccess: () => setConfirm(false) })
  if (!item) return list.data ? <Empty title={t.common.notFound} /> : null
  const editable = item.status === 'draft' || item.status === 'scheduled'
  const save = () => {
    if (subject !== item.subject || body !== item.body) update.mutate({ id, subject, body })
  }
  return (
    <div className="detail">
      <div className="detail-head">
        <h2>{t.outreach.purpose[item.purpose] ?? item.purpose}</h2>
        <div className="row-wrap meta">
          <span>
            {t.outreach.to} {item.contact.name}
            {item.contact.title ? `, ${item.contact.title}` : ''}
          </span>
          {item.contact.email && <span>{item.contact.email}</span>}
          <Tag tone={item.contact.emailStatus === 'guessed' ? 'attention' : undefined}>{t.outreach.emailStatus[item.contact.emailStatus] ?? item.contact.emailStatus}</Tag>
          {item.company && (
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault()
                if (item.applicationId) navigate('/applications', { app: item.applicationId })
              }}
            >
              {item.company}
              {item.jobTitle ? `: ${item.jobTitle}` : ''}
            </a>
          )}
        </div>
      </div>
      {mail.data && mail.data.length === 0 && <InlineAlert actions={<Button size="sm" onPress={() => navigate('/settings', { tab: 'email' })}>{t.inbox.connect}</Button>}>{t.outreach.noMail}</InlineAlert>}
      {item.error && <InlineAlert tone={item.status === 'failed' ? 'danger' : 'attention'}>{item.error}</InlineAlert>}
      {editable ? (
        <div className="stack">
          <TextField label={t.outreach.subject} value={subject} onChange={setSubject} onBlur={save} />
          <TextField label={t.outreach.body} multiline tall value={body} onChange={setBody} onBlur={save} />
          <Checkbox isSelected={item.attachResume} onChange={(v) => update.mutate({ id, attachResume: v })}>
            {t.outreach.attachResume}
          </Checkbox>
          <div className="detail-actions">
            {item.status === 'draft' && (
              <Button variant="primary" onPress={() => approve.mutate({ ids: [id] })}>
                {t.outreach.approve}
              </Button>
            )}
            <Button onPress={() => setConfirm(true)} isDisabled={!mail.data?.length}>
              {t.outreach.sendNow}
            </Button>
            <Button variant="danger" onPress={() => cancel.mutate({ ids: [id] })}>
              {t.outreach.cancel}
            </Button>
            {item.scheduledAt && item.status === 'scheduled' && <span className="meta">{t.outreach.scheduledFor(dateTime(item.scheduledAt))}</span>}
          </div>
        </div>
      ) : (
        <div className="stack">
          <p className="label">{item.subject}</p>
          <p className="pre">{item.body}</p>
          {item.sentAt && <p className="meta">{t.outreach.sentAt(dateTime(item.sentAt))}</p>}
        </div>
      )}
      <Thread item={item} />
      <Dialogue
        open={confirm}
        onOpenChange={setConfirm}
        title={t.outreach.sendNow}
        footer={
          <>
            <Button onPress={() => setConfirm(false)}>{t.common.cancel}</Button>
            <Button variant="primary" onPress={() => sendNow.mutate({ id })}>
              {t.outreach.sendNow}
            </Button>
          </>
        }
      >
        <p>{t.outreach.sendConfirm(item.contact.name)}</p>
      </Dialogue>
    </div>
  )
}

function ContactDialog({ contact, onClose }: { contact: ContactInfo | 'new'; onClose: () => void }) {
  const c = contact === 'new' ? null : contact
  const [name, setName] = useState(c?.name ?? '')
  const [title, setTitle] = useState(c?.title ?? '')
  const [email, setEmail] = useState(c?.email ?? '')
  const [company, setCompany] = useState(c?.company ?? '')
  const [linkedin, setLinkedin] = useState(c?.linkedinUrl ?? '')
  const [notes, setNotes] = useState(c?.notes ?? '')
  const save = useAction('contacts.save', { onSuccess: onClose })
  return (
    <FormDialog
      open
      onClose={onClose}
      title={c ? c.name : t.outreach.contacts.add}
      submitLabel={t.common.save}
      valid={!!name.trim()}
      onSubmit={() => save.mutate({ ...(c ? { id: c.id } : {}), name, title: title || null, email: email || null, company: company || null, linkedinUrl: linkedin || null, notes })}
    >
      <div className="grid-2">
        <TextField label={t.outreach.contacts.fields.name} value={name} onChange={setName} autoFocus />
        <TextField label={t.outreach.contacts.fields.title} value={title} onChange={setTitle} />
        <TextField label={t.outreach.contacts.fields.email} type="email" value={email} onChange={setEmail} />
        <TextField label={t.outreach.contacts.fields.company} value={company} onChange={setCompany} />
      </div>
      <TextField label={t.outreach.contacts.fields.linkedin} value={linkedin} onChange={setLinkedin} />
      <TextField label={t.outreach.contacts.fields.notes} multiline value={notes} onChange={setNotes} />
      {save.error && <InlineAlert tone="danger">{save.error.message}</InlineAlert>}
    </FormDialog>
  )
}

function People() {
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<ContactInfo | 'new' | null>(null)
  const list = useApi('contacts.list', { q, applicationId: null })
  const dnc = useAction('contacts.setDoNotContact')
  const rows = list.data ?? []
  return (
    <div>
      <div className="toolbar">
        <SearchInput label={t.outreach.contacts.search} value={q} onChange={setQ} />
        <span className="spacer" />
        <Button onPress={() => setEditing('new')}>
          <PlusIcon aria-hidden />
          {t.outreach.contacts.add}
        </Button>
      </div>
      {list.data && rows.length === 0 ? (
        <Empty title={t.outreach.contacts.empty} body={t.outreach.contacts.emptyBody} />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{t.outreach.contacts.fields.name}</th>
              <th>{t.outreach.contacts.fields.company}</th>
              <th>{t.outreach.contacts.fields.email}</th>
              <th>{t.outreach.contacts.fields.title}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} data-href onClick={(e) => !(e.target as HTMLElement).closest('button') && setEditing(c)}>
                <td className="label">{c.name}</td>
                <td>{c.company}</td>
                <td>
                  {c.email} {c.email && <span className="meta">({t.outreach.emailStatus[c.emailStatus]})</span>}
                </td>
                <td className="meta">
                  {t.outreach.contacts.relation[c.relation]}
                  {c.title ? `, ${c.title}` : ''}
                </td>
                <td className="right">
                  {c.doNotContact ? (
                    <Button size="sm" variant="quiet" onPress={() => dnc.mutate({ id: c.id, value: false })}>
                      {t.outreach.contacts.allowContact}
                    </Button>
                  ) : (
                    <Button size="sm" variant="quiet" onPress={() => dnc.mutate({ id: c.id, value: true })}>
                      {t.outreach.contacts.doNotContact}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && <ContactDialog contact={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

export function Outreach() {
  const [tabParam, setTab] = useParam('tab')
  const [itemParam, setItem] = useParam('item')
  const tab = (TABS.includes(tabParam as Tab) ? tabParam : 'drafts') as Tab
  const list = useApi('outreach.list', { filter: tab === 'contacts' ? 'drafts' : tab, applicationId: null }, { enabled: tab !== 'contacts' })
  const rows = (list.data ?? []).filter((o) => tab !== 'drafts' || o.step === 0)
  const selected = itemParam ? Number(itemParam) : null
  const approve = useAction('outreach.approve')
  useAutoSelect(tab === 'contacts' ? undefined : rows[0]?.id, selected, setItem)
  return (
    <>
      <PageHead title={t.outreach.title}>
        {tab === 'drafts' && rows.length > 1 && <Button onPress={() => approve.mutate({ ids: rows.map((r) => r.id) })}>{t.outreach.approveMany(rows.length)}</Button>}
        <Segmented label={t.outreach.title} value={tab} onChange={(v) => { setTab(v); setItem(null) }} options={TABS.map((x) => ({ id: x, label: t.outreach.tabs[x]! }))} />
      </PageHead>
      <div className="page-body">
        {tab === 'contacts' ? (
          <People />
        ) : list.data && rows.length === 0 ? (
          <Empty title={tab === 'drafts' ? t.outreach.empty : tab === 'scheduled' ? t.outreach.emptyScheduled : t.outreach.emptySent} body={tab === 'drafts' ? t.outreach.emptyBody : undefined} />
        ) : (
          <Split
            list={
              <RowList
                label={t.outreach.title}
                rows={rows.map((o) => ({
                  id: o.id,
                  textValue: `${o.contact.name} ${o.company ?? ''}`,
                  line1: (
                    <>
                      <span className="truncate" style={{ flex: 1 }}>
                        {o.contact.name}
                      </span>
                      <span className="meta">{o.status === 'sent' ? ago(o.sentAt) : o.scheduledAt && o.status === 'scheduled' ? dateTime(o.scheduledAt) : ''}</span>
                    </>
                  ),
                  line2: (
                    <>
                      <span className="truncate">{o.company}</span>
                      <span className="truncate">{o.step > 0 ? t.outreach.step(o.step) : o.subject}</span>
                      {o.status === 'failed' && <Tag tone="danger">{t.activity.run.status['failed']}</Tag>}
                    </>
                  ),
                }))}
                selected={selected}
                onSelect={(id) => setItem(id)}
              />
            }
            detail={selected ? <MessagePane key={selected} id={selected} /> : <Empty title={t.outreach.select} />}
          />
        )}
      </div>
    </>
  )
}
