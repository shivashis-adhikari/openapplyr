import { useEffect, useState, useSyncExternalStore } from 'react'

/**
 * Editable copy of a value from the engine. When the source changes (a save, a refetch), the draft
 * resets to it, unless `hold` is set (the user has unsaved edits). The reset happens during render,
 * as React recommends for state derived from props, so there is no extra render pass.
 */
export function useDraft<T>(source: T, hold = false): [T, (v: T) => void] {
  const [state, setState] = useState({ source, value: source })
  if (!hold && !Object.is(state.source, source)) {
    setState({ source, value: source })
    return [source, (value) => setState({ source, value })]
  }
  return [state.value, (value) => setState((s) => ({ ...s, value }))]
}

/** Selects the first row of a list when nothing is selected yet, so the detail pane is never empty. */
export function useAutoSelect(firstId: string | number | undefined, selected: unknown, select: (id: string | number) => void): void {
  useEffect(() => {
    if (!selected && firstId !== undefined) select(firstId)
  }, [firstId, selected, select])
}

/** Whether a CSS media query matches, kept current as the window resizes or zooms. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const m = matchMedia(query)
      m.addEventListener('change', onChange)
      return () => m.removeEventListener('change', onChange)
    },
    () => matchMedia(query).matches,
  )
}
