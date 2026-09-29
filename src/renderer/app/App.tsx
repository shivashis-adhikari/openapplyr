import { useEffect, useState } from 'react'
import { useApi, listenForChanges } from '../lib/api'
import { bridge } from '../lib/bridge'
import { Onboarding } from '../screens/Onboarding'
import { Unlock } from '../screens/Unlock'
import { Shell } from './Shell'

type KeyState = Awaited<ReturnType<typeof bridge.host.keyState>>

export function App() {
  const [key, setKey] = useState<KeyState | 'checking'>('checking')
  useEffect(() => {
    void bridge.host.keyState().then(setKey, () => setKey({ kind: 'ready' }))
  }, [])
  useEffect(() => listenForChanges(), [])
  // Notification clicks and menu items arrive as routes.
  useEffect(() => bridge.host.onNavigate((route) => (window.location.hash = route.replace(/^#/, ''))), [])

  if (key === 'checking') return null
  if (key && key.kind === 'needs-passphrase') return <Unlock firstRun={key.firstRun} onUnlocked={() => setKey({ kind: 'ready' })} />
  return <Ready />
}

function Ready() {
  const status = useApi('app.status', undefined, { refetchInterval: 30_000 })
  const settings = useApi('settings.get', undefined)
  const theme = settings.data?.theme ?? 'system'
  const density = settings.data?.density ?? 'compact'
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') delete root.dataset['theme']
    else root.dataset['theme'] = theme
    root.dataset['density'] = density
  }, [theme, density])
  if (!status.data) return null
  if (!status.data.onboarded) return <Onboarding />
  return <Shell status={status.data} />
}
