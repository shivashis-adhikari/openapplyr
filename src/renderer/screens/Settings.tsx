import { PlusIcon, TrashIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import type { IntegrationInfo } from '../../shared/api/jobs'
import { REPO_URL } from '../../shared/project'
import type { Settings as S } from '../../shared/settings'
import { Wordmark } from '../components/Logo'
import { PageHead } from '../components/layout'
import { Button, Dialogue, Empty, IconButton, InlineAlert, Section, Select, Status, Switch, TextField, Working } from '../components/ui'
import { call, useAction, useApi } from '../lib/api'
import { bridge } from '../lib/bridge'
import { ago, dollars } from '../lib/format'
import { useParam } from '../lib/router'
import { toast } from '../lib/toast'
import { useDraft } from '../lib/hooks'
import { t } from '../strings/en'
import { MailForm, ProviderForm } from './ConnectForms'

const TABS = ['models', 'email', 'integrations', 'applying', 'notifications', 'general', 'data', 'about'] as const

function useSettings() {
  const s = useApi('settings.get', undefined)
  const update = useAction('settings.update')
  const patch = (p: Record<string, unknown>) => update.mutate(p)
  return { s: s.data, patch }
}

/** A number setting that saves when the field loses focus. */
function NumberSetting({ label, value, min, max, onSave, help }: { label: string; value: number; min: number; max: number; onSave: (n: number) => void; help?: string }) {
  const [v, setV] = useDraft(String(value))
  return (
    <TextField
      label={label}
      help={help}
      inputMode="decimal"
      value={v}
      onChange={setV}
      onBlur={() => {
        const n = Math.max(min, Math.min(max, Number(v)))
        if (Number.isFinite(n) && n !== value) onSave(n)
        else setV(String(value))
      }}
    />
  )
}

function Models() {
  const providers = useApi('ai.providers', undefined)
  const roles = useApi('ai.roles', undefined)
  const usage = useApi('ai.usage', { days: 30 })
  const setRole = useAction('ai.setRole')
  const del = useAction('ai.deleteProvider')
  const test = useAction('ai.test')
  const { s, patch } = useSettings()
  const [adding, setAdding] = useState(false)
  const options = (providers.data ?? []).flatMap((p) => p.models.map((m) => ({ id: `${p.id}::${m}`, label: `${p.label}: ${m}` })))
  return (
    <div className="page-narrow stack-lg">
      <Section title={t.settings.models.providers} actions={<Button onPress={() => setAdding(true)}><PlusIcon aria-hidden />{t.settings.models.add}</Button>}>
        <p className="muted">{t.settings.models.providersBody}</p>
        {providers.data && providers.data.length === 0 ? (
          <Empty title={t.settings.models.noProviders} body={t.settings.models.noProvidersBody} action={<Button variant="primary" onPress={() => setAdding(true)}>{t.settings.models.add}</Button>} />
        ) : (
          <ul className="panel">
            {(providers.data ?? []).map((p) => (
              <li key={p.id} className="worklist-item" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
                <div className="stack" style={{ gap: 2 }}>
                  <span className="what">{p.label}</span>
                  <span className="why">{t.settings.models.modelCount(p.models.length)}</span>
                </div>
                <div className="row">
                  {p.models[0] && (
                    <Button size="sm" isDisabled={test.isPending} onPress={() => test.mutate({ providerId: p.id, modelId: p.models[0]! }, { onSuccess: (r) => (r.ok ? toast.info(t.settings.models.testOk(r.latencyMs, p.models[0]!)) : toast.error(r.error ?? '')) })}>
                      {t.settings.models.test}
                    </Button>
                  )}
                  <IconButton size="sm" label={t.settings.models.remove} icon={<TrashIcon aria-hidden />} onPress={() => del.mutate({ id: p.id })} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t.settings.models.roles}>
        <p className="muted">{t.settings.models.rolesBody}</p>
        {(roles.data ?? []).map((r) => (
          <div key={r.role} className="row">
            <span style={{ width: 240 }}>{t.settings.models.role[r.role]}</span>
            <Select
              ariaLabel={t.settings.models.role[r.role]}
              value={r.providerId && r.modelId ? `${r.providerId}::${r.modelId}` : null}
              onChange={(v) => {
                const [pid, ...m] = v.split('::')
                setRole.mutate({ role: r.role, providerId: Number(pid), modelId: m.join('::') })
              }}
              options={options}
              className="spacer"
            />
            <span className="meta num" style={{ width: 240 }}>
              {!r.modelId ? '' : r.price === null ? t.settings.models.noPrice : r.price.input + r.price.output === 0 ? t.settings.models.free : t.settings.models.price(r.price.input, r.price.output)}
            </span>
          </div>
        ))}
      </Section>

      {s && (
        <Section title={t.settings.models.budget}>
          <p className="muted">{t.settings.models.budgetBody}</p>
          <div className="grid-2">
            <NumberSetting label={t.settings.models.daily} value={s.budget.daily} min={0} max={1000} onSave={(n) => patch({ budget: { daily: n } })} />
            <NumberSetting label={t.settings.models.monthly} value={s.budget.monthly} min={0} max={10000} onSave={(n) => patch({ budget: { monthly: n } })} />
          </div>
          {usage.data && <p className="meta">{t.settings.models.spent(dollars(usage.data.today.cost), dollars(usage.data.month.cost))}</p>}
        </Section>
      )}
      <Dialogue open={adding} onOpenChange={setAdding} title={t.settings.models.addTitle}>
        <ProviderForm onDone={() => setAdding(false)} />
      </Dialogue>
    </div>
  )
}

function Email() {
  const accounts = useApi('mail.accounts', undefined)
  const disconnect = useAction('mail.disconnect')
  const sync = useAction('mail.syncNow')
  const update = useAction('mail.update')
  const [adding, setAdding] = useState(false)
  return (
    <div className="page-narrow stack-lg">
      <Section title={t.settings.email.accounts} actions={<Button onPress={() => setAdding(true)}><PlusIcon aria-hidden />{t.settings.email.add}</Button>}>
        <p className="muted">{t.settings.email.body}</p>
        {accounts.data && accounts.data.length === 0 && <Empty title={t.settings.email.none} action={<Button variant="primary" onPress={() => setAdding(true)}>{t.settings.email.add}</Button>} />}
        {(accounts.data ?? []).map((a) => (
          <div key={a.id} className="panel panel-pad stack">
            <div className="row">
              <span className="label" style={{ flex: 1 }}>
                {a.address}
              </span>
              <Status tone={a.status === 'ok' ? 'accent' : 'danger'}>{t.settings.email.status[a.status] ?? a.status}</Status>
            </div>
            {a.statusDetail && <InlineAlert tone="danger">{a.statusDetail}</InlineAlert>}
            <div className="row">
              <span className="meta">{a.lastSyncAt ? t.inbox.lastSync(ago(a.lastSyncAt)) : ''}</span>
              <span className="spacer" />
              <input className="input" style={{ width: 72 }} type="number" aria-label={t.settings.email.dailyCap} defaultValue={a.dailyCap} onBlur={(e) => update.mutate({ id: a.id, dailyCap: Math.max(1, Math.min(50, Number(e.target.value) || 20)) })} />
              <span className="meta">{t.settings.email.dailyCap}</span>
              <Button size="sm" onPress={() => sync.mutate({ id: a.id })}>
                {t.settings.email.sync}
              </Button>
              <Button size="sm" variant="danger" onPress={() => disconnect.mutate({ id: a.id })}>
                {t.settings.email.disconnect}
              </Button>
            </div>
          </div>
        ))}
      </Section>
      <Dialogue open={adding} onOpenChange={setAdding} title={t.settings.email.addTitle} wide>
        <MailForm onDone={() => setAdding(false)} />
      </Dialogue>
    </div>
  )
}

function IntegrationRow({ i }: { i: IntegrationInfo }) {
  const [values, setValues] = useState<Record<string, string>>(i.config)
  const [open, setOpen] = useState(false)
  const save = useAction('integrations.save', { onSuccess: () => setOpen(false) })
  const del = useAction('integrations.delete')
  return (
    <li className="worklist-item" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
      <div className="stack" style={{ gap: 6 }}>
        <span className="what">{i.label}</span>
        {open && (
          <div className="grid-2">
            {i.fields.map((f) => (
              <TextField key={f.key} label={f.key} type={f.secret ? 'password' : 'text'} placeholder={i.secretsSet.includes(f.key) ? '••••••' : ''} value={values[f.key] ?? ''} onChange={(v) => setValues({ ...values, [f.key]: v })} />
            ))}
          </div>
        )}
      </div>
      <div className="row">
        {i.connected ? <Status tone="accent">{t.settings.integrations.connected}</Status> : null}
        {open ? (
          <Button size="sm" variant="primary" onPress={() => save.mutate({ kind: i.kind, values })}>
            {t.common.save}
          </Button>
        ) : (
          <Button size="sm" onPress={() => setOpen(true)}>
            {i.connected ? t.common.edit : t.settings.integrations.connect}
          </Button>
        )}
        {!i.connected && (
          <Button size="sm" variant="quiet" onPress={() => void bridge.host.openExternal(i.url)}>
            {t.settings.integrations.getKey}
          </Button>
        )}
        {i.connected && (
          <Button size="sm" variant="quiet" onPress={() => del.mutate({ kind: i.kind })}>
            {t.settings.integrations.disconnect}
          </Button>
        )}
      </div>
    </li>
  )
}

function Integrations() {
  const list = useApi('integrations.list', undefined)
  return (
    <div className="page-narrow stack-lg">
      <p className="muted">{t.settings.integrations.body}</p>
      <ul className="panel">{(list.data ?? []).map((i) => <IntegrationRow key={i.kind} i={i} />)}</ul>
    </div>
  )
}

function Applying({ s, patch }: { s: S; patch: (p: Record<string, unknown>) => void }) {
  const a = s.automation
  const set = (p: Partial<S['automation']>) => patch({ automation: p })
  return (
    <div className="page-narrow stack-lg">
      <Section title={t.settings.applying.browser}>
        <p className="muted">{t.settings.applying.browserBody}</p>
        <Select label={t.settings.applying.browser} value={a.browser} onChange={(v) => set({ browser: v })} options={(['auto', 'chrome', 'msedge', 'chromium', 'custom'] as const).map((k) => ({ id: k, label: t.settings.applying.browserChoice[k]! }))} />
        {a.browser === 'custom' && <TextField label={t.settings.applying.browserPath} defaultValue={a.browserPath} onBlur={(e) => set({ browserPath: (e.target as HTMLInputElement).value })} />}
        <Switch isSelected={a.headless} onChange={(v) => set({ headless: v })}>
          {t.settings.applying.headless}
        </Switch>
      </Section>
      <Section title={t.settings.applying.pace}>
        <div className="grid-2">
          <NumberSetting label={t.settings.applying.globalCap} value={a.globalDailyApplyCap} min={0} max={200} onSave={(n) => set({ globalDailyApplyCap: Math.round(n) })} />
          <NumberSetting label={t.settings.applying.hostGap} value={a.perHostGapSeconds} min={10} max={3600} onSave={(n) => set({ perHostGapSeconds: Math.round(n) })} />
          <NumberSetting label={t.settings.applying.gap} value={a.minGapSeconds} min={5} max={3600} onSave={(n) => set({ minGapSeconds: Math.round(n), maxGapSeconds: Math.max(a.maxGapSeconds, Math.round(n)) })} />
          <NumberSetting label={t.settings.applying.waitMinutes} value={a.needsUserTimeoutMinutes} min={1} max={120} onSave={(n) => set({ needsUserTimeoutMinutes: Math.round(n) })} />
        </div>
        <NumberSetting label={t.settings.applying.trust} help={t.settings.applying.trustBody} value={a.trustRampRemaining} min={0} max={20} onSave={(n) => set({ trustRampRemaining: Math.round(n) })} />
      </Section>
    </div>
  )
}

function Notifications({ s, patch }: { s: S; patch: (p: Record<string, unknown>) => void }) {
  const n = s.notifications
  const set = (p: Partial<S['notifications']>) => patch({ notifications: p })
  return (
    <div className="page-narrow stack">
      <Switch isSelected={n.needsYou} onChange={(v) => set({ needsYou: v })}>
        {t.settings.notifications.needsYou}
      </Switch>
      <Switch isSelected={n.replies} onChange={(v) => set({ replies: v })}>
        {t.settings.notifications.replies}
      </Switch>
      <Switch isSelected={n.matchesDigest} onChange={(v) => set({ matchesDigest: v })}>
        {t.settings.notifications.matches}
      </Switch>
      <Switch isSelected={n.eveningSummary} onChange={(v) => set({ eveningSummary: v })}>
        {t.settings.notifications.evening}
      </Switch>
      <Switch isSelected={n.quietHours.enabled} onChange={(v) => set({ quietHours: { ...n.quietHours, enabled: v } })}>
        {t.settings.notifications.quiet}
      </Switch>
      {n.quietHours.enabled && (
        <div className="row">
          <TextField label={t.settings.notifications.from} defaultValue={n.quietHours.start} onBlur={(e) => set({ quietHours: { ...n.quietHours, start: (e.target as HTMLInputElement).value } })} />
          <TextField label={t.settings.notifications.until} defaultValue={n.quietHours.end} onBlur={(e) => set({ quietHours: { ...n.quietHours, end: (e.target as HTMLInputElement).value } })} />
        </div>
      )}
    </div>
  )
}

function General({ s, patch }: { s: S; patch: (p: Record<string, unknown>) => void }) {
  return (
    <div className="page-narrow stack-lg">
      <Select
        label={t.settings.general.theme}
        value={s.theme}
        onChange={(v) => {
          patch({ theme: v })
          void bridge.host.setTheme(v)
        }}
        options={(['system', 'light', 'dark'] as const).map((k) => ({ id: k, label: t.settings.general.themes[k]! }))}
      />
      <Select label={t.settings.general.density} value={s.density} onChange={(v) => patch({ density: v })} options={(['compact', 'comfortable'] as const).map((k) => ({ id: k, label: t.settings.general.densities[k]! }))} />
      <Select label={t.settings.general.region} help={t.settings.general.regionHelp} value={s.region} onChange={(v) => patch({ region: v })} options={(['US', 'CA', 'UK', 'EU', 'IN', 'AU', 'OTHER'] as const).map((k) => ({ id: k, label: t.settings.general.regions[k]! }))} />
      <Switch isSelected={s.backgroundMode} onChange={(v) => patch({ backgroundMode: v })}>
        {t.settings.general.background}
      </Switch>
      <Switch isSelected={s.launchAtLogin} onChange={(v) => patch({ launchAtLogin: v })}>
        {t.settings.general.login}
      </Switch>
      <Switch isSelected={s.privacy.stripContactFromScoring} onChange={(v) => patch({ privacy: { stripContactFromScoring: v } })}>
        {t.settings.data.privacy}
      </Switch>
    </div>
  )
}

function Data() {
  const status = useApi('app.status', undefined)
  const backup = useAction('data.backupNow', { onSuccess: (r) => toast.info(t.settings.data.backedUp(r.path)) })
  const [confirm, setConfirm] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const exportAll = async () => {
    const path = await bridge.host.saveFile({ defaultPath: `OpenApplyr export ${new Date().toISOString().slice(0, 10)}` })
    if (!path) return
    setBusy(true)
    try {
      await call('data.export', { path })
      void bridge.host.reveal(path)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="page-narrow stack-lg">
      <Section title={t.settings.data.folder}>
        <p className="mono">{status.data?.dataDir}</p>
        <div className="row">
          <Button onPress={() => void call('data.revealDataDir', undefined)}>{t.settings.data.reveal}</Button>
          <Button onPress={() => backup.mutate(undefined)}>{t.settings.data.backup}</Button>
        </div>
      </Section>
      <Section title={t.settings.data.export}>
        <p className="muted">{t.settings.data.exportBody}</p>
        <div>
          <Button onPress={() => void exportAll()} isDisabled={busy}>
            {t.settings.data.export}
          </Button>
        </div>
        {busy && <Working text={t.settings.data.export} />}
      </Section>
      <Section title={t.settings.data.delete}>
        <p className="muted">{t.settings.data.deleteBody}</p>
        <div>
          <Button variant="danger" onPress={() => setConfirm(true)}>
            {t.settings.data.delete}
          </Button>
        </div>
      </Section>
      <Dialogue
        open={confirm}
        onOpenChange={setConfirm}
        title={t.settings.data.delete}
        footer={
          <>
            <Button onPress={() => setConfirm(false)}>{t.common.cancel}</Button>
            <Button variant="danger" isDisabled={typed !== 'DELETE'} onPress={() => void call('data.deleteAll', { confirm: 'DELETE' })}>
              {t.settings.data.deleteRun}
            </Button>
          </>
        }
      >
        <p>{t.settings.data.deleteBody}</p>
        <TextField label={t.settings.data.deleteConfirm} value={typed} onChange={setTyped} />
      </Dialogue>
    </div>
  )
}

function About() {
  const status = useApi('app.status', undefined)
  return (
    <div className="page-narrow stack">
      <div className="brand about-logo">
        <Wordmark />
      </div>
      <p>{t.settings.about.version(status.data?.version ?? '')}</p>
      <p className="muted">{t.settings.about.license}</p>
      <p className="muted">{t.settings.about.credits}</p>
      <div className="row">
        <Button onPress={() => void bridge.host.openExternal(REPO_URL)}>{t.settings.about.source}</Button>
        <Button variant="quiet" onPress={() => void bridge.host.openExternal(`${REPO_URL}/issues`)}>
          {t.settings.about.issues}
        </Button>
      </div>
    </div>
  )
}

export function Settings() {
  const [tabParam, setTab] = useParam('tab')
  const tab = (TABS.includes(tabParam as never) ? tabParam : 'models') as (typeof TABS)[number]
  const { s, patch } = useSettings()
  return (
    <>
      <PageHead title={t.settings.title} />
      <div className="page-body" style={{ display: 'grid', gridTemplateColumns: '200px minmax(0,1fr)' }}>
        <nav aria-label={t.settings.title} className="nav" style={{ padding: 16, borderRight: '1px solid var(--border)' }}>
          {TABS.map((x) => (
            <a
              key={x}
              className="nav-item"
              href={`#/settings?tab=${x}`}
              aria-current={x === tab ? 'page' : undefined}
              onClick={(e) => {
                e.preventDefault()
                setTab(x)
              }}
            >
              <span>{t.settings.tabs[x]}</span>
            </a>
          ))}
        </nav>
        <div style={{ overflow: 'auto' }}>
          {tab === 'models' && <Models />}
          {tab === 'email' && <Email />}
          {tab === 'integrations' && <Integrations />}
          {tab === 'applying' && s && <Applying s={s} patch={patch} />}
          {tab === 'notifications' && s && <Notifications s={s} patch={patch} />}
          {tab === 'general' && s && <General s={s} patch={patch} />}
          {tab === 'data' && <Data />}
          {tab === 'about' && <About />}
        </div>
      </div>
    </>
  )
}

