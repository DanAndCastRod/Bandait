/**
 * Deshacer y rehacer del Estudio Bandait. Guarda referencias a estados inmutables (las sesiones
 * que devuelve sessionOps comparten lo que no cambio, asi que 100 pasos cuestan poco).
 *
 * Modulo puro: sin DOM ni import.meta.env (se prueba en scripts/verify-studio-logic.ts).
 */
import type { HistoryApi, StudioHistory } from './types.ts'

/** Pasos que el Estudio permite deshacer (plan, seccion 6). */
export const STUDIO_HISTORY_LIMIT = 100

interface Entry<T> {
  state: T
  /** Nombre del paso que LLEVO a este estado ("Dividir clip"). */
  label: string | null
}

export function createHistory<T>(limit: number): StudioHistory<T> {
  const maxSteps = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : STUDIO_HISTORY_LIMIT
  let entries: Entry<T>[] = []
  /** Posicion del presente en `entries`; -1 si todavia no hubo push. */
  let index = -1

  return {
    push(state: T, label?: string): void {
      if (index >= 0 && entries[index].state === state) return
      // Un push despues de deshacer descarta lo que se podia rehacer.
      entries = entries.slice(0, index + 1)
      entries.push({ state, label: label ?? null })
      // La linea base mas `maxSteps` pasos: al pasarse se olvida el mas viejo.
      if (entries.length > maxSteps + 1) entries = entries.slice(entries.length - (maxSteps + 1))
      index = entries.length - 1
    },
    undo(): T | null {
      if (index <= 0) return null
      index -= 1
      return entries[index].state
    },
    redo(): T | null {
      if (index < 0 || index >= entries.length - 1) return null
      index += 1
      return entries[index].state
    },
    canUndo(): boolean {
      return index > 0
    },
    canRedo(): boolean {
      return index >= 0 && index < entries.length - 1
    },
    current(): T | null {
      return index >= 0 ? entries[index].state : null
    },
    undoLabel(): string | null {
      return index > 0 ? entries[index].label : null
    },
    redoLabel(): string | null {
      return index >= 0 && index < entries.length - 1 ? entries[index + 1].label : null
    },
    states(): T[] {
      return entries.map((entry) => entry.state)
    },
    clear(): void {
      entries = []
      index = -1
    },
  }
}

void ({ createHistory } satisfies HistoryApi)
