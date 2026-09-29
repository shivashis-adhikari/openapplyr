import {
  ChatsCircleIcon,
  CrosshairIcon,
  EnvelopeIcon,
  FileTextIcon,
  GearSixIcon,
  HouseIcon,
  KanbanIcon,
  ListChecksIcon,
  MagnifyingGlassIcon,
  NotepadIcon,
  PaperPlaneTiltIcon,
  PauseIcon,
  PlayIcon,
  PulseIcon,
  SidebarSimpleIcon,
  TrayIcon,
} from '@phosphor-icons/react'
import { type ComponentType, useEffect, useState } from 'react'
import type { EngineStatus } from '../../shared/api/core'
import { Wordmark } from '../components/Logo'
import { Assistant } from '../components/Assistant'
import { Palette } from '../components/Palette'
import { Toasts } from '../components/Toasts'
import { IconButton } from '../components/ui'
import { useAction, useApi } from '../lib/api'
import { bridge } from '../lib/bridge'
import { dollars } from '../lib/format'
import { useMediaQuery } from '../lib/hooks'
import { href, useRoute } from '../lib/router'
import { Activity } from '../screens/Activity'
import { Applications } from '../screens/Applications'
import { Documents } from '../screens/Documents'
import { Hunts } from '../screens/Hunts'
import { Inbox } from '../screens/Inbox'
import { Jobs } from '../screens/Jobs'
import { Outreach } from '../screens/Outreach'
import { Prep } from '../screens/Prep'
import { Queue } from '../screens/Queue'
import { Settings } from '../screens/Settings'
import { Today } from '../screens/Today'
import { t } from '../strings/en'

type NavItem = { path: string; label: string; icon: ComponentType<{ 'aria-hidden'?: boolean }>; screen: ComponentType }

export const NAV: NavItem[] = [
  { path: '/today', label: t.nav.today, icon: HouseIcon, screen: Today },
  { path: '/jobs', label: t.nav.jobs, icon: MagnifyingGlassIcon, screen: Jobs },
  { path: '/queue', label: t.nav.queue, icon: TrayIcon, screen: Queue },
  { path: '/applications', label: t.nav.applications, icon: KanbanIcon, screen: Applications },
  { path: '/outreach', label: t.nav.outreach, icon: PaperPlaneTiltIcon, screen: Outreach },
  { path: '/inbox', label: t.nav.inbox, icon: EnvelopeIcon, screen: Inbox },
  { path: '/documents', label: t.nav.documents, icon: FileTextIcon, screen: Documents },
  { path: '/prep', label: t.nav.prep, icon: NotepadIcon, screen: Prep },
  { path: '/hunts', label: t.nav.hunts, icon: CrosshairIcon, screen: Hunts },
]
const FOOT: NavItem[] = [
  { path: '/activity', label: t.nav.activity, icon: PulseIcon, screen: Activity },
  { path: '/settings', label: t.nav.settings, icon: GearSixIcon, screen: Settings },
]

function NavLink({ item, current, count, attention }: { item: NavItem; current: boolean; count?: number; attention?: boolean }) {
  const Icon = item.icon
  return (
    <a className="nav-item" href={href(item.path)} aria-current={current ? 'page' : undefined} title={item.label}>
      <Icon aria-hidden />
      <span>{item.label}</span>
      {!!count && (
        <span className="count" data-attention={attention}>
          {count}
        </span>
      )}
    </a>
  )
}

export function Shell({ status }: { status: EngineStatus }) {
  const route = useRoute()
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebar') === 'collapsed')
  const [palette, setPalette] = useState(false)
  const [assistant, setAssistant] = useState(false)
  const today = useApi('today.summary', undefined)
  const pause = useAction('app.pause')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette((v) => !v)
      } else if (mod && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        setAssistant((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Narrow windows (small screens, high scaling, zoom) keep the sidebar to icons so content has room.
  const narrow = useMediaQuery('(max-width: 999px)')
  const [peek, setPeek] = useState(false)
  const sidebarCollapsed = narrow ? !peek : collapsed
  const toggleSidebar = () => {
    if (narrow) return setPeek((p) => !p)
    setCollapsed((c) => {
      try {
        localStorage.setItem('sidebar', c ? 'open' : 'collapsed')
      } catch {
        /* storage unavailable */
      }
      return !c
    })
  }

  const counts = today.data?.items ?? []
  const count = (kinds: string[]) => counts.filter((i) => kinds.includes(i.kind)).length
  const current = [...NAV, ...FOOT].find((n) => route.path.startsWith(n.path)) ?? NAV[0]!
  const Screen = current.screen
  const agentState = status.paused ? 'paused' : status.activeRuns ? 'running' : status.activeTasks ? 'running' : 'ok'
  const agentText = status.paused ? t.agent.paused : status.activeRuns ? t.agent.running(status.activeRuns) : status.activeTasks ? t.agent.working(status.activeTasks) : t.agent.idle

  return (
    <div className="shell" data-collapsed={sidebarCollapsed} data-platform={bridge.host.platform}>
      <nav className="sidebar" aria-label={t.common.mainNav}>
        <div className="brand">
          <Wordmark />
        </div>
        <div className="nav">
          {NAV.map((n) => (
            <NavLink
              key={n.path}
              item={n}
              current={current.path === n.path}
              count={
                n.path === '/today'
                  ? status.needsYou
                  : n.path === '/queue'
                    ? count(['package', 'package_answers', 'package_failed'])
                    : n.path === '/inbox'
                      ? count(['mail'])
                      : n.path === '/outreach'
                        ? count(['outbox'])
                        : undefined
              }
              attention={n.path === '/today'}
            />
          ))}
        </div>
        <div className="sidebar-foot">
          {FOOT.map((n) => (
            <NavLink key={n.path} item={n} current={current.path === n.path} />
          ))}
          <div className="agent-status" title={t.agent.budget(dollars(status.spendToday), dollars(status.budgetDaily))}>
            <span className="dot" data-state={agentState} aria-hidden />
            <span className="truncate">{agentText}</span>
            <span className="spacer" />
            <IconButton
              size="sm"
              label={status.paused ? t.agent.resume : t.agent.pause}
              icon={status.paused ? <PlayIcon aria-hidden /> : <PauseIcon aria-hidden />}
              onPress={() => pause.mutate({ paused: !status.paused })}
            />
          </div>
          <div className="row">
            <IconButton size="sm" label={sidebarCollapsed ? t.nav.expand : t.nav.collapse} icon={<SidebarSimpleIcon aria-hidden />} onPress={toggleSidebar} />
            <IconButton size="sm" label={t.nav.assistant} icon={<ChatsCircleIcon aria-hidden />} onPress={() => setAssistant(true)} />
            <IconButton size="sm" label={t.palette.label} icon={<ListChecksIcon aria-hidden />} onPress={() => setPalette(true)} />
          </div>
        </div>
      </nav>
      <main className="main" id="main">
        {status.demo && (
          <div className="demo-banner row">
            <span>{t.app.demo}</span>
            <span className="spacer" />
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => void bridge.host.openSample(false)}>
              {t.app.leaveDemo}
            </button>
          </div>
        )}
        <Screen />
      </main>
      <Palette open={palette} onClose={() => setPalette(false)} onAssistant={() => setAssistant(true)} />
      {assistant && <Assistant onClose={() => setAssistant(false)} />}
      <Toasts />
    </div>
  )
}
