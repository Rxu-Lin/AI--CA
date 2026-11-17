import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

type GenerationSelectProps = {
  label: string
  menuLabel: string
  value: string
  options: { value: string; label: string; content?: ReactNode }[]
  optionAction?: {
    icon: ReactNode
    label: (value: string) => string
    onActivate: (value: string) => void
  }
  fallbackLabel?: string
  disabled?: boolean
  onChange: (value: string) => void
  onOpen?: () => void
}

/** Shared dark dropdown for model, aspect ratio and output resolution. */
export default function GenerationSelect({ label, menuLabel, value, options, optionAction, fallbackLabel, disabled, onChange, onOpen }: GenerationSelectProps) {
  const menuId = useId()
  const pickerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const onOpenRef = useRef(onOpen)
  onOpenRef.current = onOpen
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [onActionColumn, setOnActionColumn] = useState(false)
  const selectedIndex = options.findIndex((option) => option.value === value)
  const expanded = open && !disabled && options.length > 0
  const activeCellId = `${menuId}-option-${activeIndex}${optionAction && onActionColumn ? '-action' : ''}`
  const searchRef = useRef({ text: '', time: 0 })

  useEffect(() => {
    if (!expanded) return
    const frame = requestAnimationFrame(() => onOpenRef.current?.())
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !pickerRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside, true)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('pointerdown', closeOutside, true)
    }
  }, [expanded])

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  useEffect(() => {
    if (expanded) document.getElementById(activeCellId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeCellId, expanded])

  const choose = (index: number, activateAction = false) => {
    const option = options[index]
    if (!option) return
    if (activateAction && optionAction) optionAction.onActivate(option.value)
    else onChange(option.value)
    setOpen(false)
    triggerRef.current?.focus({ preventScroll: true })
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled || !options.length) return
    if (expanded && optionAction && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault()
      event.stopPropagation()
      setOnActionColumn(event.key === 'ArrowRight')
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      event.stopPropagation()
      const current = expanded ? activeIndex : Math.max(0, selectedIndex)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
        : expanded ? (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length : current
      setActiveIndex(next)
      if (!expanded) setOnActionColumn(false)
      setOpen(true)
    } else if (event.key === 'Escape' && expanded) {
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    } else if (event.key === 'Tab') {
      setOpen(false)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      event.stopPropagation()
      if (expanded) choose(activeIndex, onActionColumn)
      else {
        setActiveIndex(Math.max(0, selectedIndex))
        setOnActionColumn(false)
        setOpen(true)
      }
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      event.stopPropagation()
      const now = Date.now()
      const text = (now - searchRef.current.time < 700 ? searchRef.current.text : '') + event.key.toLocaleLowerCase()
      searchRef.current = { text, time: now }
      const match = options.findIndex((option) => option.label.toLocaleLowerCase().startsWith(text))
      if (match >= 0) {
        setActiveIndex(match)
        setOnActionColumn(false)
        setOpen(true)
      }
    }
  }

  return (
    <div
      ref={pickerRef}
      className={`node-model-picker nodrag nopan nowheel ${expanded ? 'open' : ''}`}
      onPointerDown={(event) => event.stopPropagation()}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}
    >
      <button
        ref={triggerRef}
        className="node-model-select"
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup={optionAction ? 'grid' : 'listbox'}
        aria-expanded={expanded}
        aria-controls={expanded ? menuId : undefined}
        aria-activedescendant={expanded ? activeCellId : undefined}
        disabled={disabled || !options.length}
        onKeyDown={handleKeyDown}
        onClick={() => {
          setActiveIndex(Math.max(0, selectedIndex))
          setOnActionColumn(false)
          setOpen(!expanded)
        }}
      >
        <span>{options[selectedIndex]?.label || fallbackLabel || value}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {expanded && (
        <div id={menuId} className="node-model-menu" role={optionAction ? 'grid' : 'listbox'} aria-label={menuLabel}>
          {options.map((option, index) => {
            const optionId = `${menuId}-option-${index}`
            const selected = option.value === value
            const active = index === activeIndex
            const optionButton = <button
              key={option.value}
              id={optionAction ? undefined : optionId}
              className={`node-model-option ${selected ? 'selected' : ''} ${active && !onActionColumn ? 'active' : ''}`}
              type="button"
              role={optionAction ? undefined : 'option'}
              aria-selected={optionAction ? undefined : selected}
              tabIndex={-1}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => choose(index)}
            >
              {option.content ?? option.label}
            </button>
            if (!optionAction) return optionButton
            const actionLabel = optionAction.label(option.value)
            return (
              <div className="node-option-row" key={option.value} role="row" aria-selected={selected}>
                <div role="gridcell" id={optionId}>{optionButton}</div>
                <div role="gridcell" id={`${optionId}-action`}>
                  <button type="button" className={`node-option-action${active && onActionColumn ? ' active' : ''}`}
                    aria-label={actionLabel} title={actionLabel} tabIndex={-1}
                    onPointerDown={event => event.preventDefault()} onClick={() => choose(index, true)}>
                    {optionAction.icon}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
