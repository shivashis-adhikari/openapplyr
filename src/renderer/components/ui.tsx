import { CaretDownIcon, CheckIcon, InfoIcon, MagnifyingGlassIcon, WarningCircleIcon, WarningIcon } from '@phosphor-icons/react'
import type { ComponentProps, ReactNode } from 'react'
import { t } from '../strings/en'
import {
  Button as AriaButton,
  Checkbox as AriaCheckbox,
  Dialog,
  FieldError,
  Heading,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Menu as AriaMenu,
  MenuItem,
  MenuTrigger,
  Modal,
  ModalOverlay,
  Popover,
  Radio as AriaRadio,
  RadioGroup as AriaRadioGroup,
  Select as AriaSelect,
  SelectValue,
  Switch as AriaSwitch,
  Text,
  TextArea as AriaTextArea,
  TextField as AriaTextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  TooltipTrigger,
} from 'react-aria-components'

type Variant = 'primary' | 'secondary' | 'quiet' | 'danger'

export function Button({ variant = 'secondary', size, className, kbd, ...p }: ComponentProps<typeof AriaButton> & { variant?: Variant; size?: 'sm'; kbd?: string }) {
  const cls = ['btn', variant !== 'secondary' && `btn-${variant}`, size === 'sm' && 'btn-sm', className].filter(Boolean).join(' ')
  return (
    <AriaButton {...p} className={cls}>
      {(r) => (
        <>
          {typeof p.children === 'function' ? p.children(r) : p.children}
          {kbd && <span className="kbd">{kbd}</span>}
        </>
      )}
    </AriaButton>
  )
}

/** Icon-only buttons always carry a tooltip and an accessible name (design language §7). */
export function IconButton({ label, icon, size, variant = 'quiet', ...p }: Omit<ComponentProps<typeof AriaButton>, 'children'> & { label: string; icon: ReactNode; size?: 'sm'; variant?: Variant }) {
  return (
    <TooltipTrigger delay={500}>
      <AriaButton {...p} aria-label={label} className={['btn', 'btn-icon', `btn-${variant}`, size === 'sm' && 'btn-sm'].filter(Boolean).join(' ')}>
        {icon}
      </AriaButton>
      <Tooltip className="tooltip" offset={6}>
        {label}
      </Tooltip>
    </TooltipTrigger>
  )
}

export function TextField({
  label,
  help,
  multiline,
  tall,
  placeholder,
  className,
  inputClassName,
  ...p
}: ComponentProps<typeof AriaTextField> & { label?: string; help?: string; multiline?: boolean; tall?: boolean; placeholder?: string; inputClassName?: string }) {
  return (
    <AriaTextField {...p} className={['field', className].filter(Boolean).join(' ')}>
      {label && <Label className="label">{label}</Label>}
      {multiline ? <AriaTextArea className={['textarea', tall && 'textarea-tall', inputClassName].filter(Boolean).join(' ')} placeholder={placeholder} /> : <Input className={['input', inputClassName].filter(Boolean).join(' ')} placeholder={placeholder} />}
      {help && (
        <Text slot="description" className="help">
          {help}
        </Text>
      )}
      <FieldError className="error" />
    </AriaTextField>
  )
}

export function SearchInput({ value, onChange, label, placeholder }: { value: string; onChange: (v: string) => void; label: string; placeholder?: string }) {
  return (
    <div className="search">
      <MagnifyingGlassIcon aria-hidden />
      <input className="input" type="search" aria-label={label} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}

export type Option<K extends string = string> = { id: K; label: string }

export function Select<K extends string>({ label, options, value, onChange, className, ariaLabel, help, placeholder }: { label?: string; ariaLabel?: string; options: Option<K>[]; value: K | null; onChange: (v: K) => void; className?: string; help?: string; placeholder?: string }) {
  return (
    <AriaSelect selectedKey={value} onSelectionChange={(k) => k !== null && onChange(k as K)} className={['field', className].filter(Boolean).join(' ')} aria-label={ariaLabel ?? label} placeholder={placeholder ?? t.common.choose}>
      {label && <Label className="label">{label}</Label>}
      <AriaButton className="select-button">
        <SelectValue className="truncate" />
        <CaretDownIcon aria-hidden />
      </AriaButton>
      {help && (
        <Text slot="description" className="help">
          {help}
        </Text>
      )}
      <Popover className="popover" offset={4}>
        <ListBox className="listbox" items={options}>
          {(o) => (
            <ListBoxItem id={o.id} className="option" textValue={o.label}>
              {o.label}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </AriaSelect>
  )
}

export function Checkbox({ children, ...p }: ComponentProps<typeof AriaCheckbox> & { children: ReactNode }) {
  return (
    <AriaCheckbox {...p} className="checkbox">
      {({ isSelected }) => (
        <>
          <span className="box" aria-hidden>
            {isSelected && <CheckIcon weight="bold" />}
          </span>
          <span>{children}</span>
        </>
      )}
    </AriaCheckbox>
  )
}

/** Switches are only for settings that take effect immediately (design language §9). */
export function Switch({ children, ...p }: ComponentProps<typeof AriaSwitch> & { children: ReactNode }) {
  return (
    <AriaSwitch {...p} className="switch">
      <span className="track" aria-hidden />
      <span>{children}</span>
    </AriaSwitch>
  )
}

export function RadioGroup<K extends string>({ label, options, value, onChange, horizontal }: { label?: string; options: (Option<K> & { help?: string })[]; value: K; onChange: (v: K) => void; horizontal?: boolean }) {
  return (
    <AriaRadioGroup value={value} onChange={(v) => onChange(v as K)} className="field" orientation={horizontal ? 'horizontal' : 'vertical'} aria-label={label}>
      {label && <Label className="label">{label}</Label>}
      <div className="radio-group" data-orientation={horizontal ? 'horizontal' : 'vertical'}>
        {options.map((o) => (
          <AriaRadio key={o.id} value={o.id} className="radio">
            <span className="box" aria-hidden />
            <span>
              {o.label}
              {o.help && <span className="meta" style={{ display: 'block' }}>{o.help}</span>}
            </span>
          </AriaRadio>
        ))}
      </div>
    </AriaRadioGroup>
  )
}

export function Segmented<K extends string>({ label, options, value, onChange }: { label: string; options: Option<K>[]; value: K; onChange: (v: K) => void }) {
  return (
    <ToggleButtonGroup aria-label={label} selectionMode="single" disallowEmptySelection selectedKeys={[value]} onSelectionChange={(s) => onChange([...s][0] as K)} className="segmented">
      {options.map((o) => (
        <ToggleButton key={o.id} id={o.id} className="seg">
          {o.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  )
}

export type Tone = 'attention' | 'danger' | 'accent' | 'info' | undefined

export function Tag({ tone, children, icon }: { tone?: Tone; children: ReactNode; icon?: ReactNode }) {
  return (
    <span className="tag" data-tone={tone}>
      {icon}
      {children}
    </span>
  )
}

export function Status({ tone, children, icon }: { tone?: Tone; children: ReactNode; icon?: ReactNode }) {
  return (
    <span className="status" data-tone={tone}>
      {icon}
      {children}
    </span>
  )
}

/** A score is a number plus a bar, and always opens its explanation (design language §9, Meter). */
export function Meter({ value, onPress, label }: { value: number | null; onPress?: () => void; label: string }) {
  if (value === null) return <span className="meta">–</span>
  const v = Math.round(value)
  const inner = (
    <>
      <span>{v}</span>
      <span className="bar" aria-hidden>
        <i style={{ width: `${Math.max(2, Math.min(100, v))}%` }} />
      </span>
    </>
  )
  return onPress ? (
    <AriaButton className="meter" data-low={v < 50} onPress={onPress} aria-label={label}>
      {inner}
    </AriaButton>
  ) : (
    <span className="meter" data-low={v < 50} aria-label={label} role="img">
      {inner}
    </span>
  )
}

export function InlineAlert({ tone = 'attention', children, actions }: { tone?: 'attention' | 'danger' | 'info'; children: ReactNode; actions?: ReactNode }) {
  const Icon = tone === 'danger' ? WarningCircleIcon : tone === 'info' ? InfoIcon : WarningIcon
  return (
    <div className="alert" data-tone={tone} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon aria-hidden />
      <div className="body">{children}</div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  )
}

/** One line in the serif face saying what will appear here, one plain line if needed, one action. */
export function Empty({ title, body, action, center }: { title: string; body?: string; action?: ReactNode; center?: boolean }) {
  return (
    <div className={['empty', center && 'empty-center'].filter(Boolean).join(' ')}>
      <p className="display">{title}</p>
      {body && <p>{body}</p>}
      {action}
    </div>
  )
}

/** Network or model work in progress: a plain line with what is happening (no spinners, no jokes). */
export function Working({ text }: { text: string }) {
  return (
    <div className="working" role="status" aria-live="polite">
      <span>{text}</span>
      <div className="progress-line" />
    </div>
  )
}

export function Dialogue({
  open,
  onOpenChange,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  return (
    <ModalOverlay isOpen={open} onOpenChange={onOpenChange} isDismissable className="overlay">
      <Modal className={['modal', wide && 'modal-wide'].filter(Boolean).join(' ')}>
        <Dialog className="dialog">
          <div className="dialog-head">
            <Heading slot="title">{title}</Heading>
          </div>
          <div className="dialog-body">{children}</div>
          {footer && <div className="dialog-foot">{footer}</div>}
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}

export type MenuAction = { id: string; label: string; danger?: boolean; kbd?: string; onAction: () => void }

export function Menu({ label, trigger, items }: { label: string; trigger: ReactNode; items: (MenuAction | 'sep')[] }) {
  return (
    <MenuTrigger>
      {trigger}
      <Popover className="popover" placement="bottom end" offset={4}>
        <AriaMenu className="menu" aria-label={label} onAction={(k) => (items.find((i) => i !== 'sep' && i.id === k) as MenuAction | undefined)?.onAction()}>
          {items.map((i, n) =>
            i === 'sep' ? (
              <MenuItem key={`sep${n}`} className="menu-sep" isDisabled textValue="-" />
            ) : (
              <MenuItem key={i.id} id={i.id} className="menu-item" data-danger={i.danger || undefined} textValue={i.label}>
                {i.label}
                {i.kbd && <span className="kbd">{i.kbd}</span>}
              </MenuItem>
            ),
          )}
        </AriaMenu>
      </Popover>
    </MenuTrigger>
  )
}

export function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <div className="section-head">
        <h3 className="section-title">{title}</h3>
        <span className="spacer" />
        {actions}
      </div>
      {children}
    </section>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>
}

/** A form in a dialog: Cancel and one primary button; Cmd/Ctrl+Enter submits (design language §11). */
export function FormDialog({ open, onClose, title, onSubmit, submitLabel, valid, children, wide }: { open: boolean; onClose: () => void; title: string; onSubmit: () => void; submitLabel: string; valid: boolean; children: ReactNode; wide?: boolean }) {
  return (
    <Dialogue
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={title}
      wide={wide}
      footer={
        <>
          <Button onPress={onClose}>{t.common.cancel}</Button>
          <Button variant="primary" isDisabled={!valid} onPress={onSubmit}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <div
        className="stack"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && valid) onSubmit()
        }}
      >
        {children}
      </div>
    </Dialogue>
  )
}
