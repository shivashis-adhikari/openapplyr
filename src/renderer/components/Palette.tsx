import { useMemo, useState } from 'react'
import { Dialog, Input, ListBox, ListBoxItem, Modal, ModalOverlay } from 'react-aria-components'
import { useApi } from '../lib/api'
import { navigate } from '../lib/router'
import { t } from '../strings/en'

type Entry = { id: string; label: string; hint?: string; run: () => void }

const SCREENS: [string, string][] = [
  ['/today', t.nav.today],
  ['/jobs', t.nav.jobs],
  ['/queue', t.nav.queue],
  ['/applications', t.nav.applications],
  ['/outreach', t.nav.outreach],
  ['/inbox', t.nav.inbox],
  ['/documents', t.nav.documents],
  ['/prep', t.nav.prep],
  ['/hunts', t.nav.hunts],
  ['/activity', t.nav.activity],
  ['/settings', t.nav.settings],
]

/** Cmd/Ctrl+K: every screen, recent applications and jobs, and common actions (design language §6). */
export function Palette({ open, onClose, onAssistant }: { open: boolean; onClose: () => void; onAssistant: () => void }) {
  const [q, setQ] = useState('')
  const apps = useApi('applications.list', { q, statuses: [], huntId: null, archived: false }, { enabled: open && q.length > 1 })
  const jobs = useApi('jobs.list', { huntId: null, view: 'all', q, remote: [], employment: [], minScore: 0, hideWarnings: false, sort: 'score', limit: 8, offset: 0 }, { enabled: open && q.length > 1 })
  const entries = useMemo<Entry[]>(() => {
    const go = (path: string, params?: Record<string, string | number>) => () => navigate(path, params)
    const base: Entry[] = [
      ...SCREENS.map(([p, l]) => ({ id: `s:${p}`, label: t.palette.goTo(l), run: go(p) })),
      { id: 'a:assistant', label: t.nav.assistant, hint: 'Ctrl J', run: onAssistant },
      { id: 'a:addjob', label: t.jobs.importLink, run: go('/jobs', { add: 1 }) },
      { id: 'a:addapp', label: t.applications.add, run: go('/applications', { add: 1 }) },
      { id: 'a:hunt', label: t.hunts.new, run: go('/hunts', { hunt: 'new' }) },
      { id: 'a:profile', label: t.profile.title, run: go('/documents', { tab: 'profile' }) },
      { id: 'a:models', label: t.settings.tabs['models']!, run: go('/settings', { tab: 'models' }) },
      { id: 'a:email', label: t.settings.tabs['email']!, run: go('/settings', { tab: 'email' }) },
    ]
    const needle = q.trim().toLowerCase()
    const matched = needle ? base.filter((e) => e.label.toLowerCase().includes(needle)) : base
    const fromApps = (apps.data ?? []).slice(0, 6).map((a) => ({ id: `app:${a.id}`, label: `${a.company}: ${a.title}`, hint: t.status[a.status], run: go('/applications', { app: a.id }) }))
    const fromJobs = (jobs.data?.rows ?? []).slice(0, 6).map((j) => ({ id: `job:${j.id}`, label: `${j.company}: ${j.title}`, hint: t.nav.jobs, run: go('/jobs', { view: 'all', job: j.id }) }))
    return [...matched, ...fromApps, ...fromJobs]
  }, [q, apps.data, jobs.data, onAssistant])

  const close = () => {
    setQ('')
    onClose()
  }
  return (
    <ModalOverlay isOpen={open} onOpenChange={(o) => !o && close()} isDismissable className="overlay">
      <Modal className="palette">
        <Dialog aria-label={t.palette.label} className="dialog">
          <Input
            className="input"
            autoFocus
            aria-label={t.palette.label}
            placeholder={t.palette.placeholder}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && entries[0]) {
                entries[0].run()
                close()
              } else if (e.key === 'ArrowDown') {
                ;(document.querySelector('.palette [role=option]') as HTMLElement | null)?.focus()
              }
            }}
          />
          <ListBox
            className="listbox"
            aria-label={t.palette.label}
            items={entries}
            renderEmptyState={() => <div className="option muted">{t.palette.none}</div>}
            onAction={(k) => {
              entries.find((e) => e.id === k)?.run()
              close()
            }}
          >
            {(e) => (
              <ListBoxItem id={e.id} className="option" textValue={e.label}>
                <span className="truncate">{e.label}</span>
                {e.hint && <span className="kbd" style={{ marginLeft: 'auto' }}>{e.hint}</span>}
              </ListBoxItem>
            )}
          </ListBox>
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}
