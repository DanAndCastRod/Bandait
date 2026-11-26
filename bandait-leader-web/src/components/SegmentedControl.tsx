import React, { useRef } from 'react'

interface Option<T extends string> {
  id: T
  label: string
  icon?: React.ReactNode
}

interface Props<T extends string> {
  ariaLabel: string
  value: T
  options: ReadonlyArray<Option<T>>
  onChange: (value: T) => void
  /** data-testid de cada opcion: `${testIdPrefix}-${id}`. */
  testIdPrefix?: string
  /** id del panel que controlan las pestanas (aria-controls). */
  panelId?: string
}

/**
 * Selector segmentado en pildora (pestanas ARIA): flechas izquierda/derecha, Inicio y Fin mueven
 * la seleccion; solo la opcion activa entra en el orden de tabulacion.
 */
export function SegmentedControl<T extends string>({ ariaLabel, value, options, onChange, testIdPrefix, panelId }: Props<T>) {
  const listRef = useRef<HTMLDivElement>(null)

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const index = options.findIndex((o) => o.id === value)
    let next = -1
    if (e.key === 'ArrowRight') next = (index + 1) % options.length
    else if (e.key === 'ArrowLeft') next = (index - 1 + options.length) % options.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = options.length - 1
    if (next < 0) return
    e.preventDefault()
    onChange(options[next].id)
    listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  }

  return (
    <div ref={listRef} role="tablist" aria-label={ariaLabel} className="hub-segmented" onKeyDown={onKeyDown}>
      {options.map((o) => {
        const active = o.id === value
        return (
          <button
            key={o.id}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={panelId}
            tabIndex={active ? 0 : -1}
            data-testid={testIdPrefix ? `${testIdPrefix}-${o.id}` : undefined}
            className="hub-segment hub-press"
            onClick={() => onChange(o.id)}
          >
            {o.icon}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
