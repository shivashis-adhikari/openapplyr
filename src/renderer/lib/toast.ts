import { useSyncExternalStore } from 'react'

export type Toast = { id: number; text: string; tone: 'default' | 'danger'; action?: { label: string; run: () => void } }

let seq = 0
let toasts: Toast[] = []
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

function show(t: Omit<Toast, 'id'>, ms: number): number {
  const id = ++seq
  toasts = [...toasts.slice(-3), { ...t, id }]
  emit()
  setTimeout(() => dismiss(id), ms)
  return id
}

export function dismiss(id: number): void {
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

/**
 * Toasts are for background events and undo only (design language §9). Never "Saved successfully".
 */
export const toast = {
  info: (text: string) => show({ text, tone: 'default' }, 5000),
  error: (text: string) => show({ text, tone: 'danger' }, 8000),
  undo: (text: string, label: string, run: () => void) => show({ text, tone: 'default', action: { label, run } }, 8000),
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => toasts,
  )
}
