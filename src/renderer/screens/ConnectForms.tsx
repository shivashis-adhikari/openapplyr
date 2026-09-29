import { useState } from 'react'
import type { ProviderKind, ProviderSpec } from '../../shared/api/ai'
import { Button, InlineAlert, Select, TextField, Working } from '../components/ui'
import { call, useApi } from '../lib/api'
import { bridge } from '../lib/bridge'
import { t } from '../strings/en'

/** Adds a model provider, checks it answers, and assigns it to any role that has no model yet. */
export function ProviderForm({ onDone }: { onDone: () => void }) {
  const catalog = useApi('ai.catalog', undefined)
  const local = useApi('ai.detectLocal', undefined)
  const [kind, setKind] = useState<ProviderKind>('anthropic')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const spec: ProviderSpec | undefined = catalog.data?.find((c) => c.kind === kind)
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const p = await call('ai.saveProvider', { kind, fields })
      const withModels = p.models.length ? p : await call('ai.refreshModels', { id: p.id }).catch(() => p)
      await call('ai.autoAssign', { providerId: withModels.id, onlyEmpty: true })
      onDone()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const found = [local.data?.ollama?.length ? `Ollama: ${local.data.ollama.slice(0, 3).join(', ')}` : '', local.data?.lmstudio?.length ? `LM Studio: ${local.data.lmstudio.slice(0, 3).join(', ')}` : ''].filter(Boolean)
  return (
    <div className="stack">
      <Select label={t.settings.models.kind} value={kind} onChange={(k) => { setKind(k); setFields({}) }} options={(catalog.data ?? []).filter((c) => c.kind !== 'mock').map((c) => ({ id: c.kind, label: c.label }))} />
      {found.length > 0 && <p className="meta">{found.join('. ')}</p>}
      {spec?.fields.map((f) => (
        <TextField
          key={f.key}
          label={f.label}
          help={f.help || undefined}
          placeholder={f.placeholder || undefined}
          type={f.secret ? 'password' : 'text'}
          multiline={f.multiline}
          isRequired={f.required}
          value={fields[f.key] ?? ''}
          onChange={(v) => setFields({ ...fields, [f.key]: v })}
        />
      ))}
      <div className="row">
        <Button variant="primary" isDisabled={busy || !spec || spec.fields.some((f) => f.required && !fields[f.key]?.trim())} onPress={() => void save()}>
          {t.settings.models.add}
        </Button>
        {spec?.keyUrl && (
          <Button variant="quiet" onPress={() => void bridge.host.openExternal(spec.keyUrl!)}>
            {t.settings.integrations.getKey}
          </Button>
        )}
      </div>
      {busy && <Working text={t.settings.models.testing} />}
      {error && <InlineAlert tone="danger">{error}</InlineAlert>}
    </div>
  )
}

/** Connects a mailbox: app password for most providers, a browser sign-in for Microsoft. */
export function MailForm({ onDone }: { onDone: () => void }) {
  const presets = useApi('mail.presets', undefined)
  const [preset, setPreset] = useState('gmail')
  const [address, setAddress] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [clientId, setClientId] = useState('')
  const [imap, setImap] = useState({ host: '', port: '993' })
  const [smtp, setSmtp] = useState({ host: '', port: '465' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const p = presets.data?.find((x) => x.id === preset)
  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      if (p?.auth === 'oauth') await call('mail.connectOAuth', { provider: 'microsoft', clientId, address: address || undefined, displayName: name || undefined })
      else
        await call('mail.connect', {
          preset,
          address,
          password,
          displayName: name || undefined,
          ...(p?.needsServers ? { imap: { host: imap.host, port: Number(imap.port), secure: Number(imap.port) === 993 }, smtp: { host: smtp.host, port: Number(smtp.port), secure: Number(smtp.port) === 465 } } : {}),
        })
      onDone()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="stack">
      <Select label={t.settings.email.provider} value={preset} onChange={setPreset} options={(presets.data ?? []).map((x) => ({ id: x.id, label: x.label }))} />
      <div className="grid-2">
        <TextField label={t.settings.email.address} type="email" value={address} onChange={setAddress} />
        <TextField label={t.settings.email.displayName} value={name} onChange={setName} />
      </div>
      {p?.auth === 'oauth' ? (
        <TextField label={t.settings.email.clientId} help={t.settings.email.clientIdHelp} value={clientId} onChange={setClientId} />
      ) : (
        <TextField label={t.settings.email.password} help={t.settings.email.passwordHelp} type="password" value={password} onChange={setPassword} />
      )}
      {p?.needsServers && (
        <div className="grid-2">
          <div className="row">
            <TextField label={t.settings.email.imapHost} value={imap.host} onChange={(v) => setImap({ ...imap, host: v })} className="spacer" />
            <TextField label={t.settings.email.port} value={imap.port} onChange={(v) => setImap({ ...imap, port: v })} />
          </div>
          <div className="row">
            <TextField label={t.settings.email.smtpHost} value={smtp.host} onChange={(v) => setSmtp({ ...smtp, host: v })} className="spacer" />
            <TextField label={t.settings.email.port} value={smtp.port} onChange={(v) => setSmtp({ ...smtp, port: v })} />
          </div>
        </div>
      )}
      <div className="row">
        <Button variant="primary" isDisabled={busy || !address.includes('@') || (p?.auth === 'oauth' ? clientId.length < 8 : !password)} onPress={() => void run()}>
          {p?.auth === 'oauth' ? t.settings.email.signIn : t.settings.email.add}
        </Button>
        {p?.helpUrl && (
          <Button variant="quiet" onPress={() => void bridge.host.openExternal(p.helpUrl!)}>
            {p.auth === 'oauth' ? t.common.showDetails : t.settings.email.makePassword}
          </Button>
        )}
      </div>
      {busy && <Working text={t.settings.email.connecting} />}
      {error && <InlineAlert tone="danger">{error}</InlineAlert>}
    </div>
  )
}
