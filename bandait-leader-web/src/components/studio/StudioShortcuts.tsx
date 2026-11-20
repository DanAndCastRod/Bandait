import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Keyboard, RotateCcw, Save, X } from 'lucide-react'
import {
  commandShortcuts,
  defaultKeymap,
  displayShortcut,
  findConflicts,
  loadKeymap,
  resetKeymap,
  saveKeymap,
  shortcutFromEvent,
  STUDIO_COMMAND_CATEGORY_LABELS,
  STUDIO_COMMAND_CONTEXT_LABELS,
} from '../../services/studio/commands'
import type { CommandCategory, Keymap, StudioCommand } from '../../services/studio/types'
import { STUDIO_ARGS_ONLY_COMMANDS, studioKeymapStorage, type StudioCommandCtx, type StudioRegistry } from './studioCommandHandlers'

const CATEGORY_ORDER: readonly CommandCategory[] = ['transporte', 'edicion', 'pistas', 'herramientas', 'midi', 'mezcla', 'marcas', 'vista', 'archivo']

/** Teclas que solas no son un atajo (se espera la tecla que acompanan). */
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'OS', 'AltGraph', 'CapsLock'])

interface Props {
  registry: StudioRegistry
  keymap: Keymap
  platform: 'mac' | 'other'
  /** El mapa guardado cambio (guardar o restaurar). */
  onChange: (keymap: Keymap) => void
  onClose: () => void
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i])
}

/**
 * Hoja de atajos (?) con editor: cambiar o quitar el atajo de un comando, ver los choques antes
 * de guardar y restaurar los de fabrica. Se guarda por navegador (keymap.saveKeymap: solo las
 * diferencias, bajo "bandait_studio_keymap").
 */
export const StudioShortcuts: React.FC<Props> = ({ registry, keymap, platform, onChange, onClose }) => {
  const commands = useMemo(() => registry.list().filter((c) => !STUDIO_ARGS_ONLY_COMMANDS.has(c.id)), [registry])
  const [draft, setDraft] = useState<Record<string, string[]>>(() => ({ ...(keymap as Record<string, string[]>) }))
  const [capturing, setCapturing] = useState<string | null>(null)
  const [message, setMessage] = useState<{ tone: 'error' | 'ok'; text: string } | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef<Element | null>(typeof document === 'undefined' ? null : document.activeElement)

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true })
    const back = returnFocus.current
    return () => {
      if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true })
    }
  }, [])

  const all = useMemo(() => registry.list() as readonly StudioCommand<StudioCommandCtx>[], [registry])
  const conflicts = useMemo(() => findConflicts(all, draft), [all, draft])
  const conflictOf = useMemo(() => {
    const map = new Map<string, string[]>()
    const labels = new Map(all.map((c) => [c.id, c.label]))
    for (const conflict of conflicts) {
      for (const id of conflict.commandIds) {
        const others = conflict.commandIds.filter((other) => other !== id).map((other) => labels.get(other) ?? other)
        map.set(id, [...(map.get(id) ?? []), `${displayShortcut(conflict.shortcut, platform)} con ${others.join(', ')}`])
      }
    }
    return map
  }, [conflicts, all, platform])

  const defaults = useMemo(() => defaultKeymap(all), [all])
  const dirty = all.some((c) => !sameList(commandShortcuts(c, draft), commandShortcuts(c, keymap)))
  const customized = all.some((c) => !sameList(commandShortcuts(c, keymap), defaults[c.id] ?? []))

  const groups = useMemo(
    () =>
      CATEGORY_ORDER.map((category) => ({ category, items: commands.filter((c) => c.category === category) })).filter((group) => group.items.length > 0),
    [commands],
  )

  const setShortcuts = (id: string, list: string[]) => {
    setDraft((current) => ({ ...current, [id]: list }))
    setMessage(null)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (capturing) {
      // Mientras se espera la tecla nueva, toda pulsacion es para el editor (Tab incluido).
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setCapturing(null)
        return
      }
      if (MODIFIER_KEYS.has(event.key)) return
      const shortcut = shortcutFromEvent(event.nativeEvent, platform)
      if (!shortcut) {
        setMessage({ tone: 'error', text: 'Esa tecla no se puede usar como atajo. Prueba con una letra, un número, una flecha o una tecla de función.' })
        return
      }
      setShortcuts(capturing, [shortcut])
      setCapturing(null)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key === 'Tab') {
      const focusables = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])
      if (focusables.length === 0) return
      const at = focusables.indexOf(document.activeElement as HTMLElement)
      event.preventDefault()
      focusables[(at + (event.shiftKey ? -1 : 1) + focusables.length) % focusables.length].focus()
    }
  }

  const save = () => {
    try {
      saveKeymap(studioKeymapStorage, all, draft)
      const next = loadKeymap(studioKeymapStorage, all)
      onChange(next)
      setDraft({ ...(next as Record<string, string[]>) })
      setMessage({ tone: 'ok', text: 'Atajos guardados en este navegador.' })
      // GUARDAR queda deshabilitado (ya no hay cambios) y perderia el foco hacia el body: se
      // mueve al boton de cerrar para que Escape y Tab sigan dentro de la hoja.
      closeRef.current?.focus()
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof Error ? err.message : 'No se pudieron guardar los atajos.' })
    }
  }

  const restoreAll = () => {
    resetKeymap(studioKeymapStorage)
    const next = loadKeymap(studioKeymapStorage, all)
    onChange(next)
    setDraft({ ...(next as Record<string, string[]>) })
    setCapturing(null)
    setMessage({ tone: 'ok', text: 'Se restauraron los atajos de fábrica.' })
  }

  return (
    <div className="stu-overlay" onMouseDown={(event) => event.target === event.currentTarget && !capturing && onClose()} data-testid="studio-shortcuts-overlay">
      <div ref={dialogRef} className="stu-sheet" role="dialog" aria-modal="true" aria-labelledby="studio-shortcuts-title" onKeyDown={onKeyDown} data-testid="studio-shortcuts">
        <header className="stu-sheet-head">
          <Keyboard size={15} aria-hidden="true" />
          <h2 id="studio-shortcuts-title">Atajos de teclado</h2>
          <span className="stu-bar-spacer" />
          <button ref={closeRef} type="button" className="stu-btn" data-size="icon" data-tone="ghost" onClick={onClose} aria-label="Cerrar la hoja de atajos">
            <X size={14} />
          </button>
        </header>
        <p className="stu-help">
          Los atajos no se disparan mientras escribes en un campo. Un atajo de la línea de tiempo o del piano roll solo vale en esa vista; los de "En todo el Estudio" valen siempre. Se guardan en este navegador.
        </p>
        {conflicts.length > 0 && (
          <div className="stu-notice" data-tone="warn" role="status" data-testid="studio-shortcuts-conflicts">
            <span>
              <strong>{conflicts.length === 1 ? 'Hay 1 atajo repetido.' : `Hay ${conflicts.length} atajos repetidos.`}</strong> Cambia uno de los dos antes de guardar.
            </span>
          </div>
        )}
        {message && (
          <p className="stu-help" data-tone={message.tone === 'error' ? 'error' : undefined} role={message.tone === 'error' ? 'alert' : 'status'} data-testid="studio-shortcuts-message">
            {message.text}
          </p>
        )}
        <div className="stu-sheet-body">
          {groups.map((group) => (
            <section key={group.category} className="stu-sheet-group" aria-label={STUDIO_COMMAND_CATEGORY_LABELS[group.category]}>
              <span className="stu-label">{STUDIO_COMMAND_CATEGORY_LABELS[group.category]}</span>
              <ul className="stu-sheet-list">
                {group.items.map((command) => {
                  const list = commandShortcuts(command, draft)
                  const clash = conflictOf.get(command.id)
                  const isCapturing = capturing === command.id
                  const isDefault = sameList(list, defaults[command.id] ?? [])
                  return (
                    <li key={command.id} className="stu-sheet-row" data-conflict={clash ? 'true' : undefined} data-testid="studio-shortcut-row" data-command={command.id}>
                      <span className="stu-sheet-name">
                        <span>{command.label}</span>
                        <span className="stu-label">{STUDIO_COMMAND_CONTEXT_LABELS[command.context]}</span>
                        {clash && (
                          <span className="stu-help" data-tone="warn">
                            Choca: {clash.join('; ')}
                          </span>
                        )}
                      </span>
                      <span className="stu-sheet-keys">
                        {isCapturing ? (
                          <kbd className="stu-kbd" data-capturing="true" aria-live="polite">
                            PULSA LA TECLA...
                          </kbd>
                        ) : list.length === 0 ? (
                          <span className="stu-label">SIN ATAJO</span>
                        ) : (
                          list.map((s) => (
                            <kbd key={s} className="stu-kbd">
                              {displayShortcut(s, platform)}
                            </kbd>
                          ))
                        )}
                      </span>
                      <span className="stu-sheet-actions">
                        <button
                          type="button"
                          className="stu-btn"
                          data-size="small"
                          data-on={isCapturing}
                          aria-pressed={isCapturing}
                          onClick={() => {
                            setMessage(null)
                            setCapturing(isCapturing ? null : command.id)
                          }}
                          aria-label={isCapturing ? `Cancelar el cambio de atajo de ${command.label}` : `Cambiar el atajo de ${command.label}`}
                          data-testid="studio-shortcut-change"
                        >
                          {isCapturing ? 'CANCELAR' : 'CAMBIAR'}
                        </button>
                        <button
                          type="button"
                          className="stu-btn"
                          data-size="small"
                          data-tone="ghost"
                          disabled={list.length === 0 || isCapturing}
                          onClick={() => setShortcuts(command.id, [])}
                          aria-label={`Quitar el atajo de ${command.label}`}
                        >
                          QUITAR
                        </button>
                        <button
                          type="button"
                          className="stu-btn"
                          data-size="small"
                          data-tone="ghost"
                          disabled={isDefault || isCapturing}
                          onClick={() => setShortcuts(command.id, [...(defaults[command.id] ?? [])])}
                          aria-label={`Volver al atajo de fábrica de ${command.label}`}
                          title="Atajo de fábrica"
                        >
                          <RotateCcw size={12} />
                        </button>
                      </span>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
        </div>
        <footer className="stu-actions" data-align="end">
          <button type="button" className="stu-btn" data-tone="ghost" disabled={!customized && !dirty} onClick={restoreAll} data-testid="studio-shortcuts-reset">
            <RotateCcw size={13} />
            RESTAURAR TODO
          </button>
          <button type="button" className="stu-btn" data-tone="primary" disabled={!dirty || conflicts.length > 0 || capturing !== null} onClick={save} data-testid="studio-shortcuts-save">
            <Save size={13} />
            GUARDAR
          </button>
        </footer>
      </div>
    </div>
  )
}
