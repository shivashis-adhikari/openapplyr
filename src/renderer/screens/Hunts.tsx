import { PlusIcon, TrashIcon } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import type { Hunt, HuntConfig, HuntMode } from '../../shared/domain'
import { HuntConfigSchema } from '../../shared/domain'
import { PageHead, RowList, Split } from '../components/layout'
import { Button, Checkbox, Empty, IconButton, InlineAlert, RadioGroup, Section, Select, Status, Switch, TextField } from '../components/ui'
import { call, useAction, useApi } from '../lib/api'
import { useParam } from '../lib/router'
import { toast } from '../lib/toast'
import { useAutoSelect } from '../lib/hooks'
import { t } from '../strings/en'

type Draft = { id?: number; name: string; mode: HuntMode; active: boolean; baseResumeId: number | null; config: HuntConfig }

const blank = (): Draft => ({ name: '', mode: 'review', active: true, baseResumeId: null, config: HuntConfigSchema.parse({}) })
const lines = (xs: string[]) => xs.join('\n')
const fromLines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean)
const fromCsv = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)

const EMPLOYMENT = ['full_time', 'part_time', 'contract', 'internship', 'temporary'] as const
const SENIORITY = ['intern', 'junior', 'mid', 'senior', 'staff', 'principal', 'manager', 'director', 'executive'] as const

function Editor({ initial, onSaved }: { initial: Draft; onSaved: (h: Hunt) => void }) {
  const [d, setD] = useState<Draft>(initial)
  const [titles, setTitles] = useState(lines(initial.config.titles))
  const [preview, setPreview] = useState<{ total: number; pass: number; reasons: { reason: string; count: number }[] } | null>(null)
  const resumes = useApi('resumes.list', { kind: 'base' })
  const templates = useApi('templates.list', undefined)
  const suggestions = useApi('hunts.suggestions', { id: initial.id ?? 0 }, { enabled: !!initial.id })
  const save = useAction('hunts.save', {
    onSuccess: (h) => {
      toast.info(t.hunts.saved)
      onSaved(h)
    },
  })
  const runNow = useAction('hunts.runNow')
  const del = useAction('hunts.delete')
  const suggest = useAction('hunts.suggestTitles', { onSuccess: (xs) => setTitles(lines([...new Set([...fromLines(titles), ...xs])])) })
  const c = d.config
  const setC = (patch: Partial<HuntConfig>) => setD({ ...d, config: { ...c, ...patch } })

  // Live preview: how many jobs already in the database pass these filters.
  useEffect(() => {
    const h = setTimeout(() => {
      call('hunts.preview', { config: { ...c, titles: fromLines(titles) } }).then(setPreview, () => setPreview(null))
    }, 400)
    return () => clearTimeout(h)
  }, [c, titles])

  const submit = () => save.mutate({ ...d, config: { ...c, titles: fromLines(titles) } })
  return (
    <div className="detail" style={{ maxWidth: 880 }}>
      <div className="row">
        <TextField aria-label={t.hunts.name} placeholder={t.hunts.name} value={d.name} onChange={(v) => setD({ ...d, name: v })} className="spacer" inputClassName="title-input" />
        <Switch isSelected={d.active} onChange={(v) => setD({ ...d, active: v })}>
          {d.active ? t.hunts.active : t.hunts.paused}
        </Switch>
      </div>
      <div className="detail-actions">
        <Button variant="primary" onPress={submit} isDisabled={!d.name.trim() || !fromLines(titles).length || save.isPending}>
          {t.common.saveChanges}
        </Button>
        {d.id && (
          <Button onPress={() => runNow.mutate({ id: d.id })} isDisabled={runNow.isPending}>
            {t.hunts.runNow}
          </Button>
        )}
        {preview && <span className="meta">{t.hunts.previewCount(preview.pass, preview.total)}</span>}
        <span className="spacer" />
        {d.id && <IconButton label={t.hunts.delete} icon={<TrashIcon aria-hidden />} onPress={() => del.mutate({ id: d.id! })} />}
      </div>
      {save.error && <InlineAlert tone="danger">{save.error.message}</InlineAlert>}

      {(suggestions.data ?? []).length > 0 && (
        <Section title={t.hunts.suggestions}>
          {suggestions.data!.map((s) => (
            <div key={s.id} className="row">
              <span>{s.text}</span>
              <span className="spacer" />
              <Button size="sm" onPress={() => setC(s.patch as Partial<HuntConfig>)}>
                {t.hunts.applySuggestion}
              </Button>
            </div>
          ))}
        </Section>
      )}

      <Section title={t.hunts.sections.what}>
        <div className="grid-2">
          <div className="stack" style={{ gap: 6 }}>
            <TextField label={t.hunts.titles} help={t.hunts.titlesHelp} placeholder={t.hunts.titlesPlaceholder} multiline value={titles} onChange={setTitles} />
            <div>
              <Button size="sm" variant="quiet" isDisabled={!fromLines(titles).length || suggest.isPending} onPress={() => suggest.mutate({ titles: fromLines(titles).slice(0, 10) })}>
                {t.hunts.suggestTitles}
              </Button>
            </div>
          </div>
          <TextField label={t.hunts.exclude} help={t.hunts.excludeHelp} multiline value={lines(c.excludeKeywords)} onChange={(v) => setC({ excludeKeywords: fromLines(v) })} />
        </div>
        <div className="grid-2">
          <fieldset className="field">
            <legend className="label">{t.hunts.seniority}</legend>
            <div className="row-wrap">
              {SENIORITY.map((s) => (
                <Checkbox key={s} isSelected={c.seniority.includes(s)} onChange={(on) => setC({ seniority: on ? [...c.seniority, s] : c.seniority.filter((x) => x !== s) })}>
                  {t.jobs.seniority[s]}
                </Checkbox>
              ))}
            </div>
            <span className="help">{t.hunts.seniorityHelp}</span>
          </fieldset>
          <fieldset className="field">
            <legend className="label">{t.hunts.employment}</legend>
            <div className="row-wrap">
              {EMPLOYMENT.map((s) => (
                <Checkbox key={s} isSelected={c.employment.includes(s)} onChange={(on) => setC({ employment: on ? [...c.employment, s] : c.employment.filter((x) => x !== s) })}>
                  {t.jobs.employment[s]}
                </Checkbox>
              ))}
            </div>
          </fieldset>
        </div>
      </Section>

      <Section title={t.hunts.sections.where}>
        <div className="row-wrap">
          {(['remote', 'hybrid', 'onsite'] as const).map((w) => (
            <Checkbox key={w} isSelected={c.workplace[w]} onChange={(on) => setC({ workplace: { ...c.workplace, [w]: on } })}>
              {t.jobs.remote[w]}
            </Checkbox>
          ))}
        </div>
        {c.places.map((p, i) => (
          <div key={i} className="row">
            <input className="input" aria-label={t.hunts.places} value={p.label} onChange={(e) => setC({ places: c.places.map((x, j) => (j === i ? { ...x, label: e.target.value, city: e.target.value.split(',')[0]!.trim() } : x)) })} />
            <input className="input" aria-label={t.hunts.radius} style={{ width: 96 }} type="number" min={0} max={500} value={p.radiusKm} onChange={(e) => setC({ places: c.places.map((x, j) => (j === i ? { ...x, radiusKm: Number(e.target.value) } : x)) })} />
            <span className="meta">km</span>
            <IconButton size="sm" label={t.common.remove} icon={<TrashIcon aria-hidden />} onPress={() => setC({ places: c.places.filter((_, j) => j !== i) })} />
          </div>
        ))}
        <div>
          <Button size="sm" onPress={() => setC({ places: [...c.places, { label: '', city: null, country: null, lat: null, lon: null, radiusKm: 40 }] })}>
            <PlusIcon aria-hidden />
            {t.hunts.addPlace}
          </Button>
        </div>
        <TextField label={t.hunts.remoteCountries} help={t.hunts.remoteCountriesHelp} value={c.remoteCountries.join(', ')} onChange={(v) => setC({ remoteCountries: fromCsv(v.toUpperCase()).filter((x) => /^[A-Z]{2}$/.test(x)) })} />
      </Section>

      <Section title={t.hunts.sections.filters}>
        <div className="grid-3">
          <TextField label={t.hunts.salaryFloor} inputMode="numeric" value={c.salaryFloor ? String(c.salaryFloor.amount) : ''} onChange={(v) => setC({ salaryFloor: v.replace(/\D/g, '') ? { amount: Number(v.replace(/\D/g, '')), currency: c.salaryFloor?.currency ?? 'USD', period: 'year' } : null })} />
          <TextField label={t.profile.fields.currency} maxLength={3} value={c.salaryFloor?.currency ?? ''} onChange={(v) => c.salaryFloor && setC({ salaryFloor: { ...c.salaryFloor, currency: v.toUpperCase() } })} />
          <TextField label={t.hunts.postedWithin} type="number" value={String(c.postedWithinDays)} onChange={(v) => setC({ postedWithinDays: Math.max(1, Math.min(365, Number(v) || 30)) })} />
        </div>
        <Checkbox isSelected={c.includeUnknownSalary} onChange={(v) => setC({ includeUnknownSalary: v })}>
          {t.hunts.includeUnknownSalary}
        </Checkbox>
        <Checkbox isSelected={c.excludeStaffing} onChange={(v) => setC({ excludeStaffing: v })}>
          {t.hunts.excludeStaffing}
        </Checkbox>
        <Checkbox isSelected={c.requireSponsorship} onChange={(v) => setC({ requireSponsorship: v })}>
          {t.hunts.requireSponsorship}
        </Checkbox>
        <div className="grid-2">
          <TextField label={t.hunts.companiesInclude} multiline value={lines(c.companiesInclude)} onChange={(v) => setC({ companiesInclude: fromLines(v) })} />
          <TextField label={t.hunts.companiesExclude} multiline value={lines(c.companiesExclude)} onChange={(v) => setC({ companiesExclude: fromLines(v) })} />
        </div>
        {preview && preview.reasons.length > 0 && (
          <ul className="meta">
            {preview.reasons.slice(0, 6).map((r) => (
              <li key={r.reason}>
                {r.count}: {r.reason}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t.hunts.sections.mode}>
        <RadioGroup label={t.hunts.mode} value={d.mode} onChange={(v) => setD({ ...d, mode: v })} options={(['manual', 'review', 'autopilot'] as const).map((m) => ({ id: m, label: t.hunts.modes[m]! }))} />
        <div className="grid-2">
          <TextField label={t.hunts.queueThreshold} type="number" value={String(c.queueThreshold)} onChange={(v) => setC({ queueThreshold: Math.max(0, Math.min(100, Number(v) || 0)) })} />
          <TextField label={t.hunts.autopilotThreshold} type="number" value={String(c.autopilotThreshold)} onChange={(v) => setC({ autopilotThreshold: Math.max(0, Math.min(100, Number(v) || 0)) })} />
        </div>
        {d.mode === 'autopilot' && (
          <Checkbox isSelected={c.generatedAnswersInAutopilot} onChange={(v) => setC({ generatedAnswersInAutopilot: v })}>
            {t.hunts.generatedAnswers}
          </Checkbox>
        )}
      </Section>

      <Section title={t.hunts.sections.limits}>
        <div className="grid-3">
          <TextField label={t.hunts.dailyCap} type="number" value={String(c.dailyApplyCap)} onChange={(v) => setC({ dailyApplyCap: Math.max(0, Math.min(100, Number(v) || 0)) })} />
          <TextField label={t.hunts.activeHours} placeholder="08:00" value={c.activeHours.start} onChange={(v) => setC({ activeHours: { ...c.activeHours, start: v } })} />
          <TextField label="" aria-label={t.hunts.activeHours} placeholder="21:00" value={c.activeHours.end} onChange={(v) => setC({ activeHours: { ...c.activeHours, end: v } })} />
        </div>
        <div className="row">
          <span>{t.hunts.cooldown}</span>
          <input className="input" style={{ width: 64 }} type="number" aria-label={t.hunts.cooldown} value={c.companyCooldown.max} onChange={(e) => setC({ companyCooldown: { ...c.companyCooldown, max: Math.max(1, Number(e.target.value) || 1) } })} />
          <span>{t.hunts.cooldownDays}</span>
          <input className="input" style={{ width: 72 }} type="number" aria-label={t.hunts.cooldownDays} value={c.companyCooldown.days} onChange={(e) => setC({ companyCooldown: { ...c.companyCooldown, days: Math.max(1, Number(e.target.value) || 1) } })} />
          <span>{t.hunts.days}</span>
        </div>
      </Section>

      <Section title={t.hunts.sections.documents}>
        <div className="grid-3">
          <Select label={t.hunts.template} value={c.template} onChange={(v) => setC({ template: v })} options={(templates.data ?? []).map((x) => ({ id: x.id, label: x.name }))} />
          <Select label={t.hunts.coverLetter} value={c.coverLetter} onChange={(v) => setC({ coverLetter: v })} options={(['always', 'when_accepted', 'never'] as const).map((k) => ({ id: k, label: t.hunts.coverLetterOptions[k]! }))} />
          <Select
            label={t.hunts.baseResume}
            value={d.baseResumeId ? String(d.baseResumeId) : 'none'}
            onChange={(v) => setD({ ...d, baseResumeId: v === 'none' ? null : Number(v) })}
            options={[{ id: 'none', label: t.common.none }, ...(resumes.data ?? []).map((r) => ({ id: String(r.id), label: r.name }))]}
          />
        </div>
        <Checkbox isSelected={c.reviewer} onChange={(v) => setC({ reviewer: v })}>
          {t.hunts.reviewer}
        </Checkbox>
      </Section>

      <Section title={t.hunts.sections.outreach}>
        <Checkbox isSelected={c.outreach.enabled} onChange={(v) => setC({ outreach: { ...c.outreach, enabled: v } })}>
          {t.hunts.outreachEnabled}
        </Checkbox>
        {c.outreach.enabled && (
          <>
            {d.mode === 'autopilot' && (
              <Checkbox isSelected={c.outreach.autopilot} onChange={(v) => setC({ outreach: { ...c.outreach, autopilot: v } })}>
                {t.hunts.outreachAutopilot}
              </Checkbox>
            )}
            <div className="grid-2">
              <TextField label={t.hunts.outreachCap} type="number" value={String(c.outreach.dailyCap)} onChange={(v) => setC({ outreach: { ...c.outreach, dailyCap: Math.max(0, Math.min(50, Number(v) || 0)) } })} />
              <TextField label={t.hunts.followUps} value={c.outreach.followUpDays.join(', ')} onChange={(v) => setC({ outreach: { ...c.outreach, followUpDays: fromCsv(v).map(Number).filter((n) => n >= 1 && n <= 30).slice(0, 3) } })} />
            </div>
          </>
        )}
      </Section>
    </div>
  )
}

export function Hunts() {
  const [huntParam, setHunt] = useParam('hunt')
  const list = useApi('hunts.list', undefined)
  const rows = list.data ?? []
  const current = huntParam === 'new' ? null : rows.find((r) => String(r.hunt.id) === huntParam)?.hunt
  useAutoSelect(rows[0]?.hunt.id, huntParam, setHunt)
  return (
    <>
      <PageHead title={t.hunts.title}>
        <Button variant="primary" onPress={() => setHunt('new')}>
          <PlusIcon aria-hidden />
          {t.hunts.new}
        </Button>
      </PageHead>
      <div className="page-body">
        {list.data && rows.length === 0 && huntParam !== 'new' ? (
          <Empty title={t.hunts.empty} body={t.hunts.emptyBody} action={<Button variant="primary" onPress={() => setHunt('new')}>{t.hunts.new}</Button>} />
        ) : (
          <Split
            list={
              <RowList
                label={t.hunts.title}
                rows={rows.map(({ hunt, stats }) => ({
                  id: hunt.id,
                  textValue: hunt.name,
                  line1: (
                    <>
                      <span className="truncate" style={{ flex: 1 }}>
                        {hunt.name}
                      </span>
                      {!hunt.active && <Status>{t.hunts.paused}</Status>}
                    </>
                  ),
                  line2: <span className="truncate">{t.hunts.stats(stats)}</span>,
                }))}
                selected={huntParam === 'new' ? null : huntParam}
                onSelect={(id) => setHunt(id)}
              />
            }
            detail={
              huntParam === 'new' ? (
                <Editor key="new" initial={blank()} onSaved={(h) => setHunt(h.id)} />
              ) : current ? (
                <Editor key={current.id} initial={{ id: current.id, name: current.name, mode: current.mode, active: current.active, baseResumeId: current.baseResumeId, config: current.config }} onSaved={() => undefined} />
              ) : (
                <Empty title={t.hunts.select} />
              )
            }
          />
        )}
      </div>
    </>
  )
}
