import { CheckCircleIcon, CircleIcon, PlusIcon, TrashIcon, UploadSimpleIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import type { ImportResult } from '../../shared/api/profile'
import type { Profile } from '../../shared/domain'
import { Button, Checkbox, FormDialog, IconButton, InlineAlert, Section, Select, TextField, Working } from '../components/ui'
import { call, useApi } from '../lib/api'
import { bridge } from '../lib/bridge'
import { toast } from '../lib/toast'
import { useDraft } from '../lib/hooks'
import { t } from '../strings/en'

type Work = Profile['work'][number]
type Edu = Profile['education'][number]

const lines = (bullets: { id: string; text: string }[]) => bullets.map((b) => b.text).join('\n')
/** Keeps each line's id by position so tailored resumes keep citing the same facts. */
const toBullets = (text: string, prev: { id: string; text: string }[]) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => ({ id: prev[i]?.text === l ? prev[i]!.id : (prev.find((p) => p.text === l)?.id ?? ''), text: l }))

function WorkEditor({ w, onChange, onRemove }: { w: Work; onChange: (w: Work) => void; onRemove: () => void }) {
  const [bullets, setBullets] = useDraft(lines(w.bullets))
  return (
    <div className="panel panel-pad stack">
      <div className="row">
        <span className="label truncate" style={{ flex: 1 }}>
          {w.title || t.profile.fields.jobTitle}, {w.company || t.profile.fields.company}
        </span>
        <IconButton size="sm" label={t.common.remove} icon={<TrashIcon aria-hidden />} onPress={onRemove} />
      </div>
      <div className="grid-2">
        <TextField label={t.profile.fields.jobTitle} value={w.title} onChange={(v) => onChange({ ...w, title: v })} />
        <TextField label={t.profile.fields.company} value={w.company} onChange={(v) => onChange({ ...w, company: v })} />
      </div>
      <div className="grid-3">
        <TextField label={t.profile.fields.start} placeholder="2021-03" value={w.start} onChange={(v) => onChange({ ...w, start: v })} />
        <TextField label={t.profile.fields.end} placeholder="2024-06" value={w.end ?? ''} isDisabled={w.end === null} onChange={(v) => onChange({ ...w, end: v })} />
        <TextField label={t.profile.fields.location} value={w.location} onChange={(v) => onChange({ ...w, location: v })} />
      </div>
      <Checkbox isSelected={w.end === null} onChange={(on) => onChange({ ...w, end: on ? null : '' })}>
        {t.profile.fields.current}
      </Checkbox>
      <TextField label={t.profile.fields.bullets} help={t.profile.fields.bulletsHelp} multiline tall value={bullets} onChange={setBullets} onBlur={() => onChange({ ...w, bullets: toBullets(bullets, w.bullets) })} />
    </div>
  )
}

function EduEditor({ e, onChange, onRemove }: { e: Edu; onChange: (e: Edu) => void; onRemove: () => void }) {
  return (
    <div className="panel panel-pad stack">
      <div className="row">
        <span className="label truncate" style={{ flex: 1 }}>
          {e.institution || t.profile.fields.institution}
        </span>
        <IconButton size="sm" label={t.common.remove} icon={<TrashIcon aria-hidden />} onPress={onRemove} />
      </div>
      <div className="grid-2">
        <TextField label={t.profile.fields.institution} value={e.institution} onChange={(v) => onChange({ ...e, institution: v })} />
        <TextField label={t.profile.fields.degree} value={e.degree} onChange={(v) => onChange({ ...e, degree: v })} />
        <TextField label={t.profile.fields.field} value={e.field} onChange={(v) => onChange({ ...e, field: v })} />
        <div className="grid-2">
          <TextField label={t.profile.fields.start} value={e.start} onChange={(v) => onChange({ ...e, start: v })} />
          <TextField label={t.profile.fields.end} value={e.end} onChange={(v) => onChange({ ...e, end: v })} />
        </div>
      </div>
    </div>
  )
}

/** Resume import: file or pasted text. Returns a draft for review; nothing is saved until the user saves. */
export function ImportResume({ onDraft }: { onDraft: (r: ImportResult) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pasting, setPasting] = useState(false)
  const [text, setText] = useState('')
  const run = async (input: { path: string } | { text: string }) => {
    setBusy(true)
    setError(null)
    try {
      onDraft(await call('profile.import', input))
      setPasting(false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="stack">
      <div className="row">
        <Button
          onPress={async () => {
            const [p] = await bridge.host.pickFile({ extensions: ['pdf', 'docx', 'txt', 'md', 'json', 'zip'] })
            if (p) void run({ path: p })
          }}
          isDisabled={busy}
        >
          <UploadSimpleIcon aria-hidden />
          {t.profile.choose}
        </Button>
        <Button variant="quiet" onPress={() => setPasting(true)} isDisabled={busy}>
          {t.profile.paste}
        </Button>
      </div>
      {busy && <Working text={t.profile.reading} />}
      {error && <InlineAlert tone="danger">{error}</InlineAlert>}
      <FormDialog open={pasting} onClose={() => setPasting(false)} title={t.profile.paste} submitLabel={t.onboarding.next} valid={text.trim().length >= 40} onSubmit={() => void run({ text })} wide>
        <TextField label={t.profile.pasteLabel} multiline tall value={text} onChange={setText} autoFocus />
      </FormDialog>
    </div>
  )
}

function SkillsField({ p, set }: { p: Profile; set: (p: Profile) => void }) {
  const [text, setText] = useDraft(p.skills.map((s) => s.name).join(', '))
  return (
    <TextField
      aria-label={t.profile.skills}
      help={t.profile.fields.skillHelp}
      multiline
      value={text}
      onChange={setText}
      onBlur={() => {
        const names = text.split(',').map((x) => x.trim()).filter(Boolean)
        set({ ...p, skills: names.map((n) => p.skills.find((s) => s.name === n) ?? { name: n, years: null, category: '' }) })
      }}
    />
  )
}

export function FactsEditor({ p, set }: { p: Profile; set: (p: Profile) => void }) {
  const js = p.jobSearch
  const setJs = (patch: Partial<Profile['jobSearch']>) => set({ ...p, jobSearch: { ...js, ...patch } })
  const yn = (v: boolean | null) => (v === null ? 'unset' : v ? 'yes' : 'no')
  const fromYn = (v: string) => (v === 'unset' ? null : v === 'yes')
  const ynOptions = [
    { id: 'unset', label: t.common.unknown },
    { id: 'yes', label: t.common.yes },
    { id: 'no', label: t.common.no },
  ]
  return (
    <div className="stack">
      <p className="meta">{t.profile.searchWhy}</p>
      <div className="stack" style={{ gap: 8 }}>
        <span className="label">{t.profile.fields.workAuth}</span>
        {js.workAuthorization.map((a, i) => (
          <div key={i} className="row">
            <input className="input" style={{ width: 64 }} aria-label={t.profile.fields.authCountry} value={a.country} maxLength={2} onChange={(e) => setJs({ workAuthorization: js.workAuthorization.map((x, j) => (j === i ? { ...x, country: e.target.value.toUpperCase() } : x)) })} />
            <Checkbox isSelected={a.authorized} onChange={(v) => setJs({ workAuthorization: js.workAuthorization.map((x, j) => (j === i ? { ...x, authorized: v } : x)) })}>
              {t.profile.fields.authorized}
            </Checkbox>
            <Checkbox isSelected={a.needsSponsorship} onChange={(v) => setJs({ workAuthorization: js.workAuthorization.map((x, j) => (j === i ? { ...x, needsSponsorship: v } : x)) })}>
              {t.profile.fields.sponsorship}
            </Checkbox>
            <IconButton size="sm" label={t.common.remove} icon={<TrashIcon aria-hidden />} onPress={() => setJs({ workAuthorization: js.workAuthorization.filter((_, j) => j !== i) })} />
          </div>
        ))}
        <div>
          <Button size="sm" onPress={() => setJs({ workAuthorization: [...js.workAuthorization, { country: p.basics.location.country || '', authorized: true, needsSponsorship: false }] })}>
            <PlusIcon aria-hidden />
            {t.profile.fields.addCountry}
          </Button>
        </div>
      </div>
      <div className="grid-3">
        <TextField label={t.profile.fields.expected} inputMode="numeric" value={js.expectedCompensation ? String(js.expectedCompensation.amount) : ''} onChange={(v) => setJs({ expectedCompensation: v.replace(/\D/g, '') ? { amount: Number(v.replace(/\D/g, '')), currency: js.expectedCompensation?.currency ?? 'USD', period: 'year' } : null })} />
        <TextField label={t.profile.fields.currency} value={js.expectedCompensation?.currency ?? ''} maxLength={3} onChange={(v) => js.expectedCompensation && setJs({ expectedCompensation: { ...js.expectedCompensation, currency: v.toUpperCase() } })} />
        <TextField label={t.profile.fields.noticePeriod} placeholder="1 month" value={js.noticePeriod} onChange={(v) => setJs({ noticePeriod: v })} />
        <TextField label={t.profile.fields.earliestStart} value={js.earliestStart} onChange={(v) => setJs({ earliestStart: v })} />
        <Select label={t.profile.fields.relocation} value={js.relocation} onChange={(v) => setJs({ relocation: v })} options={(['yes', 'no', 'maybe'] as const).map((k) => ({ id: k, label: t.profile.relocation[k]! }))} />
        <TextField label={t.profile.fields.travel} value={js.willingToTravel} onChange={(v) => setJs({ willingToTravel: v })} />
        <Select label={t.profile.fields.over18} value={yn(js.over18)} onChange={(v) => setJs({ over18: fromYn(v) })} options={ynOptions} />
        <Select label={t.profile.fields.driversLicense} value={yn(js.driversLicense)} onChange={(v) => setJs({ driversLicense: fromYn(v) })} options={ynOptions} />
        <TextField label={t.profile.fields.clearance} help={t.profile.fields.clearanceHelp} value={js.clearance} onChange={(v) => setJs({ clearance: v })} />
      </div>
      <details>
        <summary className="label">{t.profile.fields.eeo}</summary>
        <p className="meta" style={{ margin: '8px 0' }}>
          {t.profile.fields.eeoHelp}
        </p>
        <div className="grid-3">
          {(['gender', 'race', 'hispanic', 'veteran', 'disability', 'pronouns'] as const).map((k) => (
            <TextField key={k} label={t.profile.fields.eeoFields[k]} value={js.eeo[k]} onChange={(v) => setJs({ eeo: { ...js.eeo, [k]: v } })} />
          ))}
        </div>
      </details>
    </div>
  )
}

export function ProfileEditor() {
  const state = useApi('profile.get', undefined)
  const [dirty, setDirty] = useState(false)
  const [p, setP] = useDraft<Profile | null>(state.data?.profile ?? null, dirty)
  const [review, setReview] = useState<ImportResult | null>(null)
  const [saving, setSaving] = useState(false)
  if (!p || !state.data) return null
  const set = (next: Profile) => {
    setP(next)
    setDirty(true)
  }
  const b = p.basics
  const setB = (patch: Partial<Profile['basics']>) => set({ ...p, basics: { ...b, ...patch } })
  const save = async () => {
    setSaving(true)
    try {
      await call('profile.save', { profile: p, ...(review ? { sourceText: review.sourceText } : {}) })
      setDirty(false)
      setReview(null)
      toast.info(t.profile.saved)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="page-narrow stack-lg">
      <div className="row">
        <ImportResume
          onDraft={(r) => {
            setReview(r)
            set(r.draft)
          }}
        />
        <span className="spacer" />
        <span className="meta">{t.profile.years(state.data.yearsOfExperience)}</span>
        <Button variant="primary" isDisabled={!dirty || saving} onPress={() => void save()}>
          {t.common.saveChanges}
        </Button>
      </div>
      {review && review.unverified.length > 0 && (
        <InlineAlert>
          <p>{t.profile.checkThese}</p>
          <ul>
            {review.unverified.slice(0, 8).map((u) => (
              <li key={u.path + u.text} className="meta">
                {u.text}
              </li>
            ))}
          </ul>
        </InlineAlert>
      )}
      {review?.warnings.map((w) => <InlineAlert key={w}>{w}</InlineAlert>)}

      <Section title={t.profile.completeness}>
        <ul className="grid-2">
          {state.data.completeness.map((c) => (
            <li key={c.key} className="row" style={{ alignItems: 'flex-start' }} title={c.why}>
              {c.done ? <CheckCircleIcon aria-hidden style={{ color: 'var(--accent-text)', flex: 'none', marginTop: 2 }} /> : <CircleIcon aria-hidden style={{ color: 'var(--attention)', flex: 'none', marginTop: 2 }} />}
              <span>
                {c.label}
                {!c.done && <span className="meta" style={{ display: 'block' }}>{c.why}</span>}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title={t.profile.basics}>
        <div className="grid-2">
          <TextField label={t.profile.fields.name} value={b.name} onChange={(v) => setB({ name: v })} />
          <TextField label={t.profile.fields.headline} value={b.headline} onChange={(v) => setB({ headline: v })} />
          <TextField label={t.profile.fields.email} type="email" value={b.email} onChange={(v) => setB({ email: v })} />
          <TextField label={t.profile.fields.phone} type="tel" value={b.phone} onChange={(v) => setB({ phone: v })} />
        </div>
        <div className="grid-3">
          <TextField label={t.profile.fields.city} value={b.location.city} onChange={(v) => setB({ location: { ...b.location, city: v } })} />
          <TextField label={t.profile.fields.region} value={b.location.region} onChange={(v) => setB({ location: { ...b.location, region: v } })} />
          <TextField label={t.profile.fields.country} help={t.profile.fields.countryHelp} maxLength={2} value={b.location.country} onChange={(v) => setB({ location: { ...b.location, country: v.toUpperCase() } })} />
        </div>
        <TextField label={t.profile.fields.links} help={t.common.onePerLine} multiline value={b.links.map((l) => l.url).join('\n')} onChange={(v) => setB({ links: v.split('\n').map((u) => u.trim()).filter(Boolean).map((url) => ({ label: /linkedin/i.test(url) ? 'LinkedIn' : /github/i.test(url) ? 'GitHub' : 'Website', url })) })} />
        <TextField label={t.profile.fields.summary} multiline value={b.summary} onChange={(v) => setB({ summary: v })} />
      </Section>

      <Section
        title={t.profile.work}
        actions={
          <Button size="sm" onPress={() => set({ ...p, work: [{ id: '', company: '', title: '', location: '', start: '', end: null, summary: '', bullets: [], skills: [] }, ...p.work] })}>
            <PlusIcon aria-hidden />
            {t.profile.addRole}
          </Button>
        }
      >
        {p.work.map((w, i) => (
          <WorkEditor key={w.id || `new${i}`} w={w} onChange={(nw) => set({ ...p, work: p.work.map((x, j) => (j === i ? nw : x)) })} onRemove={() => set({ ...p, work: p.work.filter((_, j) => j !== i) })} />
        ))}
      </Section>

      <Section
        title={t.profile.education}
        actions={
          <Button size="sm" onPress={() => set({ ...p, education: [...p.education, { id: '', institution: '', degree: '', field: '', start: '', end: '', grade: '', bullets: [] }] })}>
            <PlusIcon aria-hidden />
            {t.profile.addEducation}
          </Button>
        }
      >
        {p.education.map((e, i) => (
          <EduEditor key={e.id || `new${i}`} e={e} onChange={(ne) => set({ ...p, education: p.education.map((x, j) => (j === i ? ne : x)) })} onRemove={() => set({ ...p, education: p.education.filter((_, j) => j !== i) })} />
        ))}
      </Section>

      <Section title={t.profile.skills}>
        <SkillsField p={p} set={set} />
      </Section>

      <Section title={t.profile.search}>
        <FactsEditor p={p} set={set} />
      </Section>

      {dirty && (
        <div className="row" style={{ position: 'sticky', bottom: 0, background: 'var(--surface)', padding: '12px 0', borderTop: '1px solid var(--border)' }}>
          <span className="spacer" />
          <Button onPress={() => { setDirty(false); setReview(null); setP(state.data!.profile) }}>{t.common.cancel}</Button>
          <Button variant="primary" isDisabled={saving} onPress={() => void save()}>
            {t.common.saveChanges}
          </Button>
        </div>
      )}
    </div>
  )
}
