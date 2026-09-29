import { XIcon } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import type { Chat, ChatAction } from '../../shared/api/prep'
import { call, useAction, useApi } from '../lib/api'
import { navigate } from '../lib/router'
import { toast } from '../lib/toast'
import { t } from '../strings/en'
import { Button, IconButton, Working } from './ui'

function Action({ a }: { a: ChatAction }) {
  const hunt = useApi('hunts.get', { id: a.kind === 'hunt_change' ? a.huntId : 0 }, { enabled: a.kind === 'hunt_change' })
  const save = useAction('hunts.save', { onSuccess: () => toast.info(t.hunts.saved) })
  if (a.kind === 'note_added') return <p className="meta">{t.assistant.noteAdded}</p>
  if (a.kind === 'draft_request')
    return (
      <div className="well row">
        <span className="meta">{t.assistant.draftRequest}</span>
        <span className="spacer" />
        <Button size="sm" onPress={() => navigate('/applications', { app: a.applicationId })}>
          {t.assistant.openOutbox}
        </Button>
      </div>
    )
  if (a.kind === 'hunt_change')
    return (
      <div className="well stack">
        <p className="label">
          {t.assistant.proposal}: {a.huntName}
        </p>
        <p className="meta">{a.reason}</p>
        <pre className="mono">{JSON.stringify(a.patch, null, 2)}</pre>
        <div>
          <Button
            size="sm"
            isDisabled={!hunt.data || save.isPending}
            onPress={() => hunt.data && save.mutate({ id: hunt.data.id, name: hunt.data.name, mode: hunt.data.mode, active: hunt.data.active, baseResumeId: hunt.data.baseResumeId, config: { ...hunt.data.config, ...a.patch } })}
          >
            {t.assistant.apply}
          </Button>
        </div>
      </div>
    )
  return null
}

export function Assistant({ onClose }: { onClose: () => void }) {
  const [chat, setChat] = useState<Chat | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [chat, busy])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const send = async () => {
    const q = text.trim()
    if (!q || busy) return
    setText('')
    setBusy(true)
    setChat((c) => ({ id: c?.id ?? 0, title: '', updatedAt: Date.now(), messages: [...(c?.messages ?? []), { role: 'user', text: q, at: Date.now() }] }))
    try {
      setChat(await call('assistant.send', { id: chat?.id ?? null, text: q }))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="drawer" aria-label={t.assistant.title}>
      <div className="page-head">
        <h2 className="section-title">{t.assistant.title}</h2>
        <span className="spacer" />
        <Button size="sm" variant="quiet" onPress={() => setChat(null)}>
          {t.assistant.newChat}
        </Button>
        <IconButton label={t.common.close} icon={<XIcon aria-hidden />} onPress={onClose} />
      </div>
      <div className="chat" aria-live="polite">
        {!chat?.messages.length && <p className="meta">{t.assistant.empty}</p>}
        {chat?.messages.map((m, i) => (
          <div key={i} className="msg" data-role={m.role}>
            <p className="pre">{m.text}</p>
            {m.role === 'assistant' && m.actions.filter((a) => a.kind !== 'looked_up').map((a, j) => <Action key={j} a={a} />)}
          </div>
        ))}
        {busy && <Working text={t.assistant.thinking} />}
        <div ref={end} />
      </div>
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <input className="input" aria-label={t.assistant.title} placeholder={t.assistant.placeholder} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        <Button type="submit" variant="primary" isDisabled={!text.trim() || busy}>
          {t.assistant.send}
        </Button>
      </form>
    </aside>
  )
}
