import { useState } from 'react'
import { Wordmark } from '../components/Logo'
import { Button, InlineAlert, TextField } from '../components/ui'
import { bridge } from '../lib/bridge'
import { t } from '../strings/en'

/** Linux without a keyring: the data key comes from a passphrase the user chooses. */
export function Unlock({ firstRun, onUnlocked }: { firstRun: boolean; onUnlocked: () => void }) {
  const [pass, setPass] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <div className="unlock">
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          try {
            if (await bridge.host.unlock(pass)) onUnlocked()
            else setError(t.unlock.wrong)
          } catch (err) {
            setError((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
          } finally {
            setBusy(false)
          }
        }}
      >
        <div className="brand">
          <Wordmark />
        </div>
        <h1 className="display">{firstRun ? t.unlock.firstTitle : t.unlock.title}</h1>
        <p className="muted">{t.unlock.body}</p>
        <TextField label={t.unlock.passphrase} type="password" value={pass} onChange={setPass} autoFocus />
        {error && <InlineAlert tone="danger">{error}</InlineAlert>}
        <Button type="submit" variant="primary" isDisabled={pass.length < 8 || busy}>
          {firstRun ? t.unlock.setUp : t.unlock.unlock}
        </Button>
      </form>
    </div>
  )
}
