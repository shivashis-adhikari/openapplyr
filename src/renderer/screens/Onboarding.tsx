import { useState } from 'react'
import type { ImportResult } from '../../shared/api/profile'
import { HuntConfigSchema, type Profile } from '../../shared/domain'
import { Wordmark } from '../components/Logo'
import { Button, InlineAlert, RadioGroup, TextField } from '../components/ui'
import { call, useApi } from '../lib/api'
import { bridge } from '../lib/bridge'
import { t } from '../strings/en'
import { MailForm, ProviderForm } from './ConnectForms'
import { FactsEditor, ImportResume } from './ProfileEditor'

const STEPS = ['model', 'profile', 'facts', 'hunt', 'email'] as const
type Step = (typeof STEPS)[number]

/**
 * First run, aimed at a first reviewed application in under 15 minutes: a model, the resume, the
 * facts forms ask for, one hunt, and (optionally) email.
 */
export function Onboarding() {
  const providers = useApi('ai.providers', undefined)
  const profileState = useApi('profile.get', undefined)
  const [step, setStep] = useState<Step>('model')
  const [draft, setDraft] = useState<ImportResult | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [titles, setTitles] = useState('')
  const [place, setPlace] = useState('')
  const [mode, setMode] = useState<'manual' | 'review' | 'autopilot'>('review')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const p = profile ?? draft?.draft ?? profileState.data?.profile ?? null
  const i = STEPS.indexOf(step)
  const next = () => setStep(STEPS[Math.min(STEPS.length - 1, i + 1)]!)

  const saveProfile = async () => {
    if (!p) return
    setBusy(true)
    setError(null)
    try {
      await call('profile.save', { profile: p, ...(draft ? { sourceText: draft.sourceText } : {}) })
      next()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const saveHunt = async () => {
    setBusy(true)
    setError(null)
    try {
      const list = titles.split('\n').map((x) => x.trim()).filter(Boolean)
      const country = p?.basics.location.country || null
      await call('hunts.save', {
        name: list[0] ?? 'My search',
        mode,
        active: true,
        baseResumeId: null,
        // The engine looks the place up by name, so a city in another country keeps that country.
        config: HuntConfigSchema.parse({ titles: list, places: place.trim() ? [{ label: place.trim(), city: null, country: null, lat: null, lon: null, radiusKm: 40 }] : [], remoteCountries: country ? [country] : [] }),
      })
      next()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const finish = async () => {
    await call('settings.update', { onboarded: true })
    await call('hunts.runNow', {})
    window.location.hash = '/today'
  }

  return (
    <div className="onboarding">
      <div className="onboarding-inner">
        <div className="brand">
          <Wordmark />
        </div>
        <ol className="steps-nav" aria-label={t.common.setup}>
          {STEPS.map((s, n) => (
            <li key={s} aria-current={s === step ? 'step' : undefined} data-done={n < i}>
              {n + 1}. {t.onboarding.steps[s]}
            </li>
          ))}
        </ol>

        {step === 'model' && (
          <>
            <h1 className="display">{t.onboarding.modelTitle}</h1>
            <p className="muted">{t.onboarding.modelBody}</p>
            {providers.data && providers.data.length > 0 ? (
              <div className="row">
                <p>{providers.data.map((x) => x.label).join(', ')}</p>
                <span className="spacer" />
                <Button variant="primary" onPress={next}>
                  {t.onboarding.next}
                </Button>
              </div>
            ) : (
              <ProviderForm onDone={next} />
            )}
            <div>
              <Button variant="quiet" onPress={() => void bridge.host.openSample(true)}>
                {t.onboarding.sample}
              </Button>
            </div>
          </>
        )}

        {step === 'profile' && (
          <>
            <h1 className="display">{t.onboarding.profileTitle}</h1>
            <p className="muted">{t.profile.importBody}</p>
            <ImportResume onDraft={setDraft} />
            {draft && (
              <div className="panel panel-pad stack">
                <p className="label">{draft.draft.basics.name}</p>
                <p className="meta">{t.onboarding.parsed(draft.draft.work.length, draft.draft.skills.length, draft.draft.education.length)}</p>
                {draft.unverified.length > 0 && <InlineAlert>{t.profile.checkThese}</InlineAlert>}
              </div>
            )}
            <div className="row">
              <span className="spacer" />
              <Button variant="primary" isDisabled={!p?.work.length || busy} onPress={() => void saveProfile()}>
                {t.onboarding.next}
              </Button>
            </div>
          </>
        )}

        {step === 'facts' && p && (
          <>
            <h1 className="display">{t.onboarding.factsTitle}</h1>
            <p className="muted">{t.onboarding.factsBody}</p>
            <div className="grid-2">
              <TextField label={t.profile.fields.email} value={p.basics.email} onChange={(v) => setProfile({ ...p, basics: { ...p.basics, email: v } })} />
              <TextField label={t.profile.fields.phone} value={p.basics.phone} onChange={(v) => setProfile({ ...p, basics: { ...p.basics, phone: v } })} />
              <TextField label={t.profile.fields.city} value={p.basics.location.city} onChange={(v) => setProfile({ ...p, basics: { ...p.basics, location: { ...p.basics.location, city: v } } })} />
              <TextField label={t.profile.fields.country} help={t.profile.fields.countryHelp} maxLength={2} value={p.basics.location.country} onChange={(v) => setProfile({ ...p, basics: { ...p.basics, location: { ...p.basics.location, country: v.toUpperCase() } } })} />
            </div>
            <FactsEditor p={p} set={setProfile} />
            <div className="row">
              <span className="spacer" />
              <Button variant="primary" isDisabled={busy} onPress={() => void saveProfile()}>
                {t.onboarding.next}
              </Button>
            </div>
          </>
        )}

        {step === 'hunt' && (
          <>
            <h1 className="display">{t.onboarding.huntTitle}</h1>
            <TextField label={t.hunts.titles} help={t.hunts.titlesHelp} placeholder={t.hunts.titlesPlaceholder} multiline value={titles} onChange={setTitles} />
            <TextField label={t.hunts.places} help={t.hunts.placesHelp} placeholder="Lisbon, Portugal" value={place} onChange={setPlace} />
            <RadioGroup label={t.hunts.mode} value={mode} onChange={setMode} options={(['manual', 'review', 'autopilot'] as const).map((m) => ({ id: m, label: t.hunts.modes[m]! }))} />
            <div className="row">
              <span className="spacer" />
              <Button variant="primary" isDisabled={!titles.trim() || busy} onPress={() => void saveHunt()}>
                {t.onboarding.next}
              </Button>
            </div>
          </>
        )}

        {step === 'email' && (
          <>
            <h1 className="display">{t.onboarding.emailTitle}</h1>
            <p className="muted">{t.onboarding.emailBody}</p>
            <MailForm onDone={() => void finish()} />
            <div className="row">
              <span className="spacer" />
              <Button variant="quiet" onPress={() => void finish()}>
                {t.onboarding.emailSkip}
              </Button>
              <Button variant="primary" onPress={() => void finish()}>
                {t.onboarding.finish}
              </Button>
            </div>
          </>
        )}
        {error && <InlineAlert tone="danger">{error}</InlineAlert>}
      </div>
    </div>
  )
}
