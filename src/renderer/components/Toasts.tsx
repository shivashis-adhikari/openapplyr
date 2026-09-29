import { dismiss, useToasts } from '../lib/toast'
import { t } from '../strings/en'

export function Toasts() {
  const toasts = useToasts()
  return (
    <div className="toasts" role="region" aria-live="polite" aria-label={t.common.notifications}>
      {toasts.map((toast) => (
        <div key={toast.id} className="toast" data-tone={toast.tone === 'danger' ? 'danger' : undefined} role={toast.tone === 'danger' ? 'alert' : 'status'}>
          <div className="body">{toast.text}</div>
          {toast.action && (
            <button
              type="button"
              onClick={() => {
                toast.action!.run()
                dismiss(toast.id)
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
