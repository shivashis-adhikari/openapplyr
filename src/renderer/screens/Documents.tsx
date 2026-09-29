import { CheckCircleIcon, TrashIcon, WarningIcon } from '@phosphor-icons/react'
import { useMemo, useState } from 'react'
import type { ResumeContent, ResumeDetail } from '../../shared/domain'
import { DocPreview } from '../components/DocPreview'
import { PageHead, RowList, Split } from '../components/layout'
import { Button, Empty, IconButton, InlineAlert, Menu, SearchInput, Section, Segmented, Select, TextField, Working } from '../components/ui'
import { call, useAction, useApi } from '../lib/api'
import { bridge } from '../lib/bridge'
import { ago } from '../lib/format'
import { useParam } from '../lib/router'
import { toast } from '../lib/toast'
import { useAutoSelect, useDraft } from '../lib/hooks'
import { t } from '../strings/en'
import { ProfileEditor } from './ProfileEditor'

const TABS = ['profile', 'resumes', 'answers', 'voice'] as const

function ContentEditor({ r, onDone }: { r: ResumeDetail; onDone: () => void }) {
  const [c, setC] = useState<ResumeContent>(r.content)
  const update = useAction('resumes.update', { onSuccess: onDone })
  return (
    <div className="stack">
      <TextField label={t.documents.headline} value={c.headline} onChange={(v) => setC({ ...c, headline: v })} />
      <TextField label={t.documents.summary} multiline value={c.summary.text} onChange={(v) => setC({ ...c, summary: { ...c.summary, text: v } })} />
      {c.work.map((w, i) => (
        <div key={w.workId} className="stack" style={{ gap: 6 }}>
          <span className="label">
            {w.title}, {w.company}
          </span>
          {w.bullets.map((b, j) => (
            <div key={j} className="stack" style={{ gap: 2 }}>
              <TextField
                aria-label={`${w.company} ${j + 1}`}
                multiline
                value={b.text}
                inputClassName="textarea-short"
                onChange={(v) => setC({ ...c, work: c.work.map((x, k) => (k === i ? { ...x, bullets: x.bullets.map((y, m) => (m === j ? { ...y, text: v } : y)) } : x)) })}
              />
              {b.flagged && <span className="meta" style={{ color: 'var(--attention)' }}>{t.documents.flagged}</span>}
            </div>
          ))}
        </div>
      ))}
      <TextField label={t.documents.skills} help={t.documents.skillsHelp} value={c.skills.join(', ')} onChange={(v) => setC({ ...c, skills: v.split(',').map((x) => x.trim()).filter(Boolean) })} />
      <div className="row">
        <Button variant="primary" onPress={() => update.mutate({ id: r.id, content: c })}>
          {t.common.saveChanges}
        </Button>
        <Button onPress={onDone}>{t.common.cancel}</Button>
      </div>
    </div>
  )
}

function ResumePane({ id }: { id: number }) {
  const resume = useApi('resumes.get', { id })
  const html = useApi('resumes.html', { id })
  const templates = useApi('templates.list', undefined)
  const update = useAction('resumes.update')
  const del = useAction('resumes.delete')
  const setDefault = useAction('resumes.setDefault')
  const [editing, setEditing] = useState(false)
  const ats = useAction('resumes.ats', { quiet: true })
  const critique = useAction('resumes.critique')
  if (!resume.data) return null
  const r = resume.data
  const exportAs = async (format: 'pdf' | 'docx' | 'txt') => {
    const path = await bridge.host.saveFile({ defaultPath: `${r.content.name.replace(/\W+/g, '_')}_Resume.${format}`, extensions: [format] })
    if (!path) return
    try {
      await call('resumes.export', { id, format, path })
      void bridge.host.reveal(path)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  return (
    <div className="detail">
      <div className="detail-head">
        <h2>{r.name}</h2>
        <p className="meta">{ago(r.updatedAt)}</p>
      </div>
      <div className="detail-actions">
        <Select label={t.documents.template} value={r.templateId} onChange={(v) => update.mutate({ id, templateId: v })} options={(templates.data ?? []).map((x) => ({ id: x.id, label: x.name }))} />
        <Select label={t.documents.pageSize} value={r.pageSize} onChange={(v) => update.mutate({ id, pageSize: v })} options={(['Letter', 'A4'] as const).map((k) => ({ id: k, label: t.documents.pageSizes[k]! }))} />
      </div>
      <div className="detail-actions">
        <Menu
          label={t.documents.exportPdf}
          trigger={<Button variant="primary">{t.documents.exportPdf}</Button>}
          items={[
            { id: 'pdf', label: t.documents.exportPdf, onAction: () => void exportAs('pdf') },
            { id: 'docx', label: t.documents.exportDocx, onAction: () => void exportAs('docx') },
            { id: 'txt', label: t.documents.exportTxt, onAction: () => void exportAs('txt') },
          ]}
        />
        <Button onPress={() => setEditing((v) => !v)}>{t.documents.edit}</Button>
        <Button onPress={() => ats.mutate({ id })} isDisabled={ats.isPending}>
          {t.documents.atsRun}
        </Button>
        <Button variant="quiet" onPress={() => critique.mutate({ id })} isDisabled={critique.isPending}>
          {t.documents.critique}
        </Button>
        <span className="spacer" />
        {r.kind === 'base' && (
          <Button variant="quiet" onPress={() => setDefault.mutate({ id })}>
            {t.documents.setDefault}
          </Button>
        )}
        <IconButton label={t.documents.deleteResume} icon={<TrashIcon aria-hidden />} onPress={() => del.mutate({ id })} />
      </div>
      {editing && <ContentEditor r={r} onDone={() => setEditing(false)} />}
      {ats.isPending && <Working text={t.documents.atsBody} />}
      {ats.error && <InlineAlert tone="danger">{ats.error.message}</InlineAlert>}
      {ats.data && (
        <Section title={t.documents.atsCheck}>
          <p className="meta">{t.documents.atsBody}</p>
          <div className="gates">
            {ats.data.checks.map((c) => (
              <div key={c.label} className="gate" data-ok={c.ok}>
                {c.ok ? <CheckCircleIcon aria-hidden /> : <WarningIcon aria-hidden />}
                <div>
                  <div className="gl">{c.label}</div>
                  <div className="gd">{c.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}
      {critique.isPending && <Working text={t.documents.critiqueRunning} />}
      {(critique.data ?? r.review).length > 0 && (
        <Section title={t.queue.reviewer}>
          <ul className="stack" style={{ gap: 6 }}>
            {(critique.data ?? r.review).map((i, n) => (
              <li key={n}>
                <span className="label">{i.location}:</span> {i.message} <span className="muted">{i.suggestion}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {html.data && <DocPreview html={html.data.html} title={r.name} />}
    </div>
  )
}

function Resumes() {
  const [resumeParam, setResume] = useParam('resume')
  const list = useApi('resumes.list', { kind: 'all' })
  const create = useAction('resumes.createBase', { onSuccess: (r) => setResume(r.id) })
  const rows = list.data ?? []
  const selected = resumeParam ? Number(resumeParam) : null
  useAutoSelect(rows[0]?.id, selected, setResume)
  if (list.data && rows.length === 0)
    return <Empty title={t.documents.noResumes} body={t.documents.noResumesBody} action={<Button variant="primary" onPress={() => create.mutate({})}>{t.documents.createBase}</Button>} />
  return (
    <Split
      list={
        <div>
          <div className="toolbar">
            <Button size="sm" onPress={() => create.mutate({})}>
              {t.documents.createBase}
            </Button>
          </div>
          {(['base', 'tailored'] as const).map((k) => {
            const group = rows.filter((r) => r.kind === k)
            if (!group.length) return null
            return (
              <div key={k}>
                <div className="group-label">{k === 'base' ? t.documents.base : t.documents.tailored}</div>
                <RowList
                  label={k === 'base' ? t.documents.base : t.documents.tailored}
                  rows={group.map((r) => ({ id: r.id, textValue: r.name, line1: <span className="truncate">{r.name}</span>, line2: <span>{ago(r.updatedAt)}</span> }))}
                  selected={selected}
                  onSelect={(id) => setResume(id)}
                />
              </div>
            )
          })}
        </div>
      }
      detail={selected ? <ResumePane key={selected} id={selected} /> : null}
    />
  )
}

function Answers() {
  const [q, setQ] = useState('')
  const list = useApi('answers.list', { q })
  const save = useAction('answers.save')
  const del = useAction('answers.delete')
  const rows = list.data ?? []
  return (
    <div>
      <div className="toolbar">
        <SearchInput label={t.documents.answers.search} value={q} onChange={setQ} />
      </div>
      {list.data && rows.length === 0 ? (
        <Empty title={t.documents.answers.empty} body={t.documents.answers.emptyBody} />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: '40%' }}>{t.queue.answers}</th>
              <th />
              <th>{t.nav.applications}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <td>{a.question}</td>
                <td>
                  <input className="input" aria-label={a.question} defaultValue={a.answer} onBlur={(e) => e.target.value.trim() && e.target.value !== a.answer && save.mutate({ id: a.id, answer: e.target.value })} />
                </td>
                <td className="meta">
                  {t.documents.answers.company(a.company)}, {t.documents.answers.used(a.usedCount)}
                </td>
                <td className="right">
                  <IconButton size="sm" label={t.common.delete} icon={<TrashIcon aria-hidden />} onPress={() => del.mutate({ id: a.id })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function Voice() {
  const voice = useApi('profile.voice', undefined)
  const [samples, setSamples] = useDraft(useMemo(() => [...(voice.data?.samples ?? []), '', '', ''].slice(0, 3), [voice.data]))
  const [description, setDescription] = useDraft(voice.data?.description ?? '')
  const describe = useAction('profile.describeVoice', { onSuccess: (v) => setDescription(v.description) })
  const save = useAction('profile.saveVoice', { onSuccess: () => toast.info(t.profile.saved) })
  const filled = samples.filter((s) => s.trim().length >= 40)
  return (
    <div className="page-narrow stack-lg">
      <p className="muted prose">{t.documents.voice.body}</p>
      <Section title={t.documents.voice.samples}>
        {samples.map((s, i) => (
          <TextField key={i} aria-label={`${t.documents.voice.samples} ${i + 1}`} multiline value={s} onChange={(v) => setSamples(samples.map((x, j) => (j === i ? v : x)))} />
        ))}
        <div>
          <Button isDisabled={!filled.length || describe.isPending} onPress={() => describe.mutate({ samples: filled })}>
            {t.documents.voice.describe}
          </Button>
        </div>
        {describe.isPending && <Working text={t.documents.voice.describing} />}
      </Section>
      <Section title={t.documents.voice.description}>
        <TextField aria-label={t.documents.voice.description} multiline value={description} onChange={setDescription} />
        <div>
          <Button variant="primary" onPress={() => save.mutate({ description, samples: filled })}>
            {t.common.save}
          </Button>
        </div>
      </Section>
    </div>
  )
}

export function Documents() {
  const [tabParam, setTab] = useParam('tab')
  const tab = (TABS.includes(tabParam as never) ? tabParam : 'profile') as (typeof TABS)[number]
  return (
    <>
      <PageHead title={t.documents.title}>
        <Segmented label={t.documents.title} value={tab} onChange={(v) => setTab(v)} options={TABS.map((x) => ({ id: x, label: t.documents.tabs[x]! }))} />
      </PageHead>
      <div className="page-body">
        {tab === 'profile' && <ProfileEditor />}
        {tab === 'resumes' && <Resumes />}
        {tab === 'answers' && <Answers />}
        {tab === 'voice' && <Voice />}
      </div>
    </>
  )
}
