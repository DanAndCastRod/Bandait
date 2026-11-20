import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { CornerDownLeft, Search, X } from 'lucide-react'
import { commandShortcuts, displayShortcut, STUDIO_COMMAND_CATEGORY_LABELS } from '../../services/studio/commands'
import type { Keymap, StudioCommand } from '../../services/studio/types'
import { STUDIO_ARGS_ONLY_COMMANDS, type StudioCommandCtx, type StudioRegistry } from './studioCommandHandlers'

/** Texto en minusculas y sin tildes, para buscar "cuantizar" con "cuantizár" o "CUANT". */
function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/**
 * Puntaje difuso: las letras de la consulta deben aparecer en orden. Suma mas si van seguidas,
 * si caen al inicio de una palabra o al inicio del texto. null = no coincide.
 */
function fuzzyScore(query: string, text: string): number | null {
  const q = fold(query).replace(/\s+/g, '')
  if (q === '') return 0
  const t = fold(text)
  let score = 0
  let ti = 0
  let streak = 0
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found < 0) return null
    const wordStart = found === 0 || /[\s.\-_/(]/.test(t[found - 1])
    streak = found === ti ? streak + 1 : 0
    score += 1 + streak * 2 + (wordStart ? 3 : 0) + (found === 0 ? 4 : 0)
    // Saltos largos restan un poco: "dup" en "Duplicar" gana sobre "d...u...p" disperso.
    score -= Math.min(3, (found - ti) * 0.1)
    ti = found + 1
  }
  // Una coincidencia seguida gana a una dispersa: "cl" pone "clic" antes que "Cuantizar la...".
  const at = t.indexOf(q)
  if (at >= 0) score += 10 + (at === 0 || /[\s.\-_/(]/.test(t[at - 1]) ? 6 : 0)
  return score
}

interface Props {
  registry: StudioRegistry
  keymap: Keymap
  platform: 'mac' | 'other'
  ctx: StudioCommandCtx
  /** Ejecuta el comando elegido (la vista cierra la paleta y muestra el error si lo hay). */
  onRun: (id: string) => void
  onClose: () => void
}

interface Row {
  command: StudioCommand<StudioCommandCtx>
  shortcut: string | null
  enabled: boolean
  score: number
}

/**
 * Paleta de comandos (Ctrl+K): busca en el mismo registro que usan el teclado y el asistente.
 * Foco atrapado en el dialogo; Escape cierra; flechas eligen; Enter ejecuta.
 */
export const StudioCommandPalette: React.FC<Props> = ({ registry, keymap, platform, ctx, onRun, onClose }) => {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  // El foco vuelve a donde estaba al cerrar.
  const returnFocus = useRef<Element | null>(typeof document === 'undefined' ? null : document.activeElement)

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true })
    const back = returnFocus.current
    return () => {
      if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true })
    }
  }, [])

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const command of registry.list()) {
      if (STUDIO_ARGS_ONLY_COMMANDS.has(command.id) || command.id === 'view.command_palette') continue
      const category = STUDIO_COMMAND_CATEGORY_LABELS[command.category]
      const score = fuzzyScore(query, `${command.label} ${category}`)
      if (score === null) continue
      const first = commandShortcuts(command, keymap)[0]
      out.push({
        command,
        shortcut: first ? displayShortcut(first, platform) : null,
        enabled: command.isEnabled ? command.isEnabled(ctx) : true,
        score,
      })
    }
    // Sin consulta, el orden del registro (por categorias); con consulta, por puntaje.
    return query.trim() === '' ? out : out.sort((a, b) => b.score - a.score)
  }, [registry, keymap, platform, ctx, query])

  const safeActive = rows.length === 0 ? -1 : Math.min(active, rows.length - 1)

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${safeActive}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [safeActive])

  const run = (row: Row | undefined) => {
    if (!row || !row.enabled) return
    onRun(row.command.id)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (rows.length === 0) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((safeActive + step + rows.length) % rows.length)
      return
    }
    if (event.key === 'Home' && event.ctrlKey) {
      event.preventDefault()
      setActive(0)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      run(rows[safeActive])
      return
    }
    if (event.key === 'Tab') {
      // Foco atrapado: el unico control que recibe foco es el buscador (y el boton de cerrar).
      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>('input, button:not([tabindex="-1"])')
      if (!focusables || focusables.length === 0) return
      const list = Array.from(focusables)
      const at = list.indexOf(document.activeElement as HTMLElement)
      event.preventDefault()
      const next = list[(at + (event.shiftKey ? -1 : 1) + list.length) % list.length]
      next.focus()
    }
  }

  return (
    <div className="stu-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()} data-testid="studio-palette-overlay">
      <div ref={dialogRef} className="stu-palette" role="dialog" aria-modal="true" aria-label="Paleta de comandos" onKeyDown={onKeyDown} data-testid="studio-palette">
        <div className="stu-palette-search">
          <Search size={14} aria-hidden="true" />
          <input
            ref={inputRef}
            className="stu-palette-input"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActive(0)
            }}
            placeholder="Busca un comando: dividir, cuantizar, loop..."
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={safeActive >= 0 ? `${listId}-${safeActive}` : undefined}
            aria-autocomplete="list"
            aria-label="Buscar un comando"
            spellCheck={false}
            autoComplete="off"
            data-testid="studio-palette-input"
          />
          <button type="button" className="stu-btn" data-size="icon" data-tone="ghost" onClick={onClose} aria-label="Cerrar la paleta de comandos">
            <X size={14} />
          </button>
        </div>
        <ul ref={listRef} id={listId} className="stu-palette-list" role="listbox" aria-label="Comandos">
          {rows.length === 0 && (
            <li className="stu-palette-empty" role="option" aria-selected="false" aria-disabled="true">
              Ningún comando coincide con "{query}".
            </li>
          )}
          {rows.map((row, index) => (
            <li
              key={row.command.id}
              id={`${listId}-${index}`}
              data-index={index}
              role="option"
              aria-selected={index === safeActive}
              aria-disabled={!row.enabled}
              className="stu-palette-row"
              data-active={index === safeActive}
              onMouseMove={() => index !== safeActive && setActive(index)}
              onClick={() => run(row)}
              data-testid="studio-palette-row"
              data-command={row.command.id}
            >
              <span className="stu-palette-name">{row.command.label}</span>
              <span className="stu-label">{row.enabled ? STUDIO_COMMAND_CATEGORY_LABELS[row.command.category] : 'NO DISPONIBLE AHORA'}</span>
              {row.shortcut && <kbd className="stu-kbd">{row.shortcut}</kbd>}
            </li>
          ))}
        </ul>
        <div className="stu-palette-foot stu-label">
          <span>
            <CornerDownLeft size={11} aria-hidden="true" /> EJECUTAR
          </span>
          <span>FLECHAS ELEGIR</span>
          <span>ESC CERRAR</span>
        </div>
      </div>
    </div>
  )
}
