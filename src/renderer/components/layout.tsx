import type { KeyboardEvent, ReactNode } from 'react'
import { GridList, GridListItem, type Selection } from 'react-aria-components'

/** The header every screen starts with: its name, then its actions on the right. */
export function PageHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="page-head">
      <h1 className="title">{title}</h1>
      {children && <div className="page-actions">{children}</div>}
    </header>
  )
}

/** List on the left, detail on the right; the list stays visible (design language §6). */
export function Split({ list, detail }: { list: ReactNode; detail: ReactNode }) {
  return (
    <div className="split">
      <div className="split-list">{list}</div>
      <div className="split-detail">{detail}</div>
    </div>
  )
}

export type Row = { id: string | number; line1: ReactNode; line2?: ReactNode; textValue: string }

/**
 * A keyboard-navigable list (arrow keys and J/K move, Enter opens). Single selection drives the detail
 * pane; multiple selection, when enabled, drives bulk actions.
 */
export function RowList({
  label,
  rows,
  selected,
  onSelect,
  multiple,
  checked,
  onChecked,
  onKey,
}: {
  label: string
  rows: Row[]
  selected: string | number | null
  onSelect: (id: string) => void
  multiple?: boolean
  checked?: Set<string>
  onChecked?: (ids: Set<string>) => void
  onKey?: (key: string, id: string) => void
}) {
  // With multiple selection, the open row is the selection until the user adds more (Cmd or Shift click).
  const selection: Selection = multiple && checked?.size ? checked : new Set(selected === null ? [] : [String(selected)])
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const list = e.currentTarget as HTMLElement
    const items = [...list.querySelectorAll<HTMLElement>('[role=row]')]
    const i = items.findIndex((el) => el === document.activeElement || el.contains(document.activeElement))
    const current = rows[i]
    if (!current) return
    if (e.key === 'j' || e.key === 'k') {
      const j = e.key === 'j' ? i + 1 : i - 1
      const next = rows[j]
      if (next) {
        e.preventDefault()
        onSelect(String(next.id))
        items[j]?.focus()
      }
    } else if (onKey && e.key.length === 1) onKey(e.key, String(current.id))
  }
  return (
    <div onKeyDown={onKeyDown}>
      <GridList
      aria-label={label}
      className="list"
      selectionMode={multiple ? 'multiple' : 'single'}
      selectionBehavior="replace"
      selectedKeys={selection}
      onSelectionChange={(s) => {
        const ids = s === 'all' ? new Set(rows.map((r) => String(r.id))) : new Set([...s].map(String))
        if (multiple && onChecked) onChecked(ids)
        const last = [...ids].at(-1)
        if (last) onSelect(last)
      }}
    >
      {rows.map((r) => (
        <GridListItem key={r.id} id={String(r.id)} textValue={r.textValue} className="list-item">
          <div className="line1">{r.line1}</div>
          {r.line2 && <div className="line2">{r.line2}</div>}
        </GridListItem>
      ))}
    </GridList>
    </div>
  )
}
