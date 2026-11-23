/**
 * Atajos de teclado del Estudio Bandait: texto canonico, lectura de una pulsacion, mapa por
 * usuario (guardado por navegador), choques y a que comando va cada pulsacion. Contrato: types.ts,
 * seccion "v2 · commands.ts". commands.ts reexporta todo esto (CommandsApi).
 *
 * Texto canonico: modificadores en el orden Ctrl, Alt, Shift y una tecla, unidos con '+':
 * "Ctrl+Shift+Z", "Space", "Delete", "ArrowUp", "Plus", "Minus", "?", "1", "F2".
 *   - Letras y digitos por `event.code` (KeyZ, Digit1): no dependen de la distribucion.
 *   - Teclas con nombre por `event.key`; simbolos por `event.key` ("+" es "Plus", "-" es "Minus").
 *   - Con un simbolo, Shift no cuenta: "?" ya implica Shift en muchas distribuciones.
 *   - "Ctrl" es Ctrl en Windows y Linux, y Cmd (metaKey) en macOS. La otra tecla (Cmd en Windows,
 *     Ctrl en macOS) no se usa: una pulsacion con ella no es un atajo.
 *
 * Decisiones que el contrato no fija:
 *   - Una pulsacion repetida (tecla sostenida, `repeat`) solo dispara atajos de teclas de
 *     navegacion (flechas, Plus, Minus, PageUp, PageDown): sostener Espacio no alterna sin fin.
 *   - El mapa guardado se lee con tolerancia (lo ilegible se ignora) y se guarda con rigor (un
 *     atajo no valido o un choque lanzan Error con el motivo en espanol).
 *   - El mapa por defecto no usa Tab (alternar editor es E): Tab y Shift+Tab son la navegacion del
 *     teclado. Aunque un usuario asigne Tab a un comando, la vista del Estudio no lo despacha sin
 *     Ctrl ni Alt (StudioHubView), para no dejar una trampa de foco. La interfaz llama a
 *     matchEvent solo con el foco dentro del Estudio (nunca en un dialogo).
 *
 * Modulo puro: sin DOM ni import.meta.env; el almacen llega inyectado (localStorage lo cumple).
 */
import type { CommandContext, KeyEventLike, KeyValueStorage, Keymap, ParsedShortcut, ShortcutConflict, StudioCommand } from './types.ts'

/** Clave del almacen donde se guardan solo los atajos que el usuario cambio. */
export const KEYMAP_STORAGE_KEY = 'bandait_studio_keymap'

/** Lo que el keymap usa de un comando (los comandos completos lo cumplen). */
export type KeymapCommand = Pick<StudioCommand<unknown>, 'id' | 'label' | 'defaultShortcuts' | 'context'>

const NAMED_KEYS = [
  'Space',
  'Enter',
  'Escape',
  'Tab',
  'Backspace',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12',
] as const

const NAMED_SET: ReadonlySet<string> = new Set(NAMED_KEYS)

/** Nombres escritos que se aceptan al leer un atajo (en minusculas), en ingles y en espanol. */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  space: 'Space',
  spacebar: 'Space',
  espacio: 'Space',
  enter: 'Enter',
  return: 'Enter',
  intro: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  backspace: 'Backspace',
  retroceso: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  supr: 'Delete',
  suprimir: 'Delete',
  home: 'Home',
  inicio: 'Home',
  end: 'End',
  fin: 'End',
  pageup: 'PageUp',
  pgup: 'PageUp',
  repag: 'PageUp',
  pagedown: 'PageDown',
  pgdn: 'PageDown',
  avpag: 'PageDown',
  arrowup: 'ArrowUp',
  up: 'ArrowUp',
  arriba: 'ArrowUp',
  arrowdown: 'ArrowDown',
  down: 'ArrowDown',
  abajo: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  left: 'ArrowLeft',
  izquierda: 'ArrowLeft',
  arrowright: 'ArrowRight',
  right: 'ArrowRight',
  derecha: 'ArrowRight',
  plus: 'Plus',
  mas: 'Plus',
  minus: 'Minus',
  menos: 'Minus',
}

/** Teclas de navegacion: las unicas que disparan con la tecla sostenida. */
const REPEATABLE: ReadonlySet<string> = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Plus', 'Minus', 'PageUp', 'PageDown'])

/** Nombres para mostrar (en espanol, como la tabla del plan). */
const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  Space: 'Espacio',
  Delete: 'Supr',
  Backspace: 'Retroceso',
  Home: 'Inicio',
  End: 'Fin',
  PageUp: 'RePág',
  PageDown: 'AvPág',
  Escape: 'Esc',
  ArrowUp: 'Arriba',
  ArrowDown: 'Abajo',
  ArrowLeft: 'Izquierda',
  ArrowRight: 'Derecha',
  Plus: '+',
  Minus: '-',
}

/** Un caracter imprimible que no es letra, digito, espacio ni '+' / '-'. */
function isSymbolChar(ch: string): boolean {
  return ch.length === 1 && /^[!-~]$/.test(ch) && !/^[A-Za-z0-9]$/.test(ch) && ch !== '+' && ch !== '-'
}

/** true si la tecla canonica es un simbolo (Shift no cuenta). */
function isSymbolKey(key: string): boolean {
  return key === 'Plus' || key === 'Minus' || isSymbolChar(key)
}

/** Token canonico de una tecla escrita, o null. */
function canonicalKey(token: string): string | null {
  if (token.length === 1) {
    if (/^[A-Za-z]$/.test(token)) return token.toUpperCase()
    if (/^[0-9]$/.test(token)) return token
    if (token === '+') return 'Plus'
    if (token === '-') return 'Minus'
    return isSymbolChar(token) ? token : null
  }
  const lower = token.toLowerCase()
  if (KEY_ALIASES[lower]) return KEY_ALIASES[lower]
  const f = /^f([1-9]|1[0-2])$/.exec(lower)
  if (f) return `F${f[1]}`
  return null
}

export function parseShortcut(text: string): ParsedShortcut | null {
  if (typeof text !== 'string') return null
  const s = text.trim()
  if (s === '') return null
  const parts = s.split('+').map((p) => p.trim())
  // "Ctrl++" y "+" terminan en la tecla '+'.
  const tokens = parts.length >= 2 && parts[parts.length - 1] === '' && parts[parts.length - 2] === '' ? [...parts.slice(0, -2), '+'] : parts
  if (tokens.some((t) => t === '')) return null
  const keyToken = tokens[tokens.length - 1]
  let ctrl = false
  let alt = false
  let shift = false
  for (const raw of tokens.slice(0, -1)) {
    const m = raw.toLowerCase()
    if (m === 'ctrl' || m === 'control' || m === 'cmd' || m === 'command' || m === 'meta' || m === 'mod') {
      if (ctrl) return null
      ctrl = true
    } else if (m === 'alt' || m === 'option' || m === 'opt') {
      if (alt) return null
      alt = true
    } else if (m === 'shift' || m === 'mayus' || m === 'mayús') {
      if (shift) return null
      shift = true
    } else {
      return null
    }
  }
  const key = canonicalKey(keyToken)
  if (key === null) return null
  return { ctrl, alt, shift: shift && !isSymbolKey(key), key }
}

export function formatShortcut(shortcut: ParsedShortcut): string {
  const parts: string[] = []
  if (shortcut.ctrl) parts.push('Ctrl')
  if (shortcut.alt) parts.push('Alt')
  if (shortcut.shift && !isSymbolKey(shortcut.key)) parts.push('Shift')
  parts.push(shortcut.key)
  return parts.join('+')
}

/** Texto canonico de un atajo escrito, o null si no es valido. */
export function normalizeShortcut(text: string): string | null {
  const parsed = parseShortcut(text)
  return parsed ? formatShortcut(parsed) : null
}

export function displayShortcut(shortcut: string, platform: 'mac' | 'other'): string {
  const p = parseShortcut(shortcut)
  if (!p) return shortcut
  const parts: string[] = []
  if (p.ctrl) parts.push(platform === 'mac' ? 'Cmd' : 'Ctrl')
  if (p.alt) parts.push(platform === 'mac' ? 'Option' : 'Alt')
  if (p.shift) parts.push('Shift')
  parts.push(DISPLAY_NAMES[p.key] ?? p.key)
  return parts.join('+')
}

/** Tecla canonica de una pulsacion, o null (solo un modificador, o una tecla no admitida). */
function eventKey(event: KeyEventLike): string | null {
  const letter = /^Key([A-Z])$/.exec(event.code ?? '')
  if (letter) return letter[1]
  const digit = /^Digit([0-9])$/.exec(event.code ?? '')
  if (digit) return digit[1]
  const key = event.key ?? ''
  if (key === ' ' || key === 'Spacebar' || event.code === 'Space') return 'Space'
  if (key === 'Esc') return 'Escape'
  if (key === 'Del') return 'Delete'
  if (key === 'Up' || key === 'Down' || key === 'Left' || key === 'Right') return `Arrow${key}`
  if (NAMED_SET.has(key)) return key
  if (key.length === 1) {
    // Teclado numerico y teclados virtuales sin `code`.
    if (/^[A-Za-z]$/.test(key)) return key.toUpperCase()
    if (/^[0-9]$/.test(key)) return key
    if (key === '+') return 'Plus'
    if (key === '-') return 'Minus'
    if (isSymbolChar(key)) return key
  }
  return null
}

export function shortcutFromEvent(event: KeyEventLike, platform: 'mac' | 'other'): string | null {
  const ctrl = platform === 'mac' ? event.metaKey : event.ctrlKey
  const foreign = platform === 'mac' ? event.ctrlKey : event.metaKey
  if (foreign) return null
  const key = eventKey(event)
  if (key === null) return null
  return formatShortcut({ ctrl: ctrl === true, alt: event.altKey === true, shift: event.shiftKey === true, key })
}

// ---------------------------------------------------------------------------
// Mapa
// ---------------------------------------------------------------------------

/** Atajos canonicos, sin repetir, de una lista escrita (los no validos se descartan). */
function canonicalList(list: readonly unknown[]): string[] {
  const out: string[] = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    const s = normalizeShortcut(item)
    if (s !== null && !out.includes(s)) out.push(s)
  }
  return out
}

/** Atajos efectivos de un comando: los del mapa o, si no esta, los por defecto. */
export function commandShortcuts(command: KeymapCommand, keymap: Keymap): string[] {
  const own = Object.prototype.hasOwnProperty.call(keymap, command.id) ? keymap[command.id] : undefined
  return canonicalList(own ?? command.defaultShortcuts)
}

export function defaultKeymap(commands: readonly KeymapCommand[]): Keymap {
  const map: Record<string, string[]> = {}
  for (const c of commands) map[c.id] = canonicalList(c.defaultShortcuts)
  return map
}

/** Dos contextos se pisan si son iguales o si uno es 'global'. */
export function contextsOverlap(a: CommandContext, b: CommandContext): boolean {
  return a === b || a === 'global' || b === 'global'
}

export function findConflicts(commands: readonly KeymapCommand[], keymap: Keymap): ShortcutConflict[] {
  const byShortcut = new Map<string, KeymapCommand[]>()
  for (const c of commands) {
    for (const s of commandShortcuts(c, keymap)) {
      const list = byShortcut.get(s)
      if (list) list.push(c)
      else byShortcut.set(s, [c])
    }
  }
  const out: ShortcutConflict[] = []
  for (const [shortcut, list] of byShortcut) {
    if (list.length < 2) continue
    const ids = list.filter((c, i) => list.some((other, j) => j !== i && other.id !== c.id && contextsOverlap(c.context, other.context))).map((c) => c.id)
    const unique = [...new Set(ids)]
    if (unique.length > 1) out.push({ shortcut, commandIds: unique })
  }
  return out.sort((a, b) => (a.shortcut < b.shortcut ? -1 : a.shortcut > b.shortcut ? 1 : 0))
}

/**
 * Atajos que el navegador se queda (la pagina no los puede usar, o los recibe solo con el foco
 * dentro del Estudio y si no abren otra cosa): pestanas y ventanas (Ctrl+T, Ctrl+N, Ctrl+W y sus
 * variantes con Shift, Ctrl+Tab), descargas (Ctrl+J), herramientas de desarrollo (Ctrl+Shift+J,
 * Ctrl+Shift+I, Ctrl+Shift+C, F12), recargar (F5, Ctrl+R, Ctrl+Shift+R), menu y barra de
 * direcciones (Alt+F, Alt+E, Alt+D), atras y adelante (Alt+Izquierda, Alt+Derecha). En Chrome
 * Ctrl+J abria las descargas en vez del asistente (reporte de Daniel Castaneda, 2026-11-23).
 * Ni el mapa por defecto ni uno editado los usan: al guardar es un error; al leer se ignoran.
 */
export const BROWSER_RESERVED_SHORTCUTS: ReadonlySet<string> = new Set([
  'Ctrl+T',
  'Ctrl+Shift+T',
  'Ctrl+N',
  'Ctrl+Shift+N',
  'Ctrl+W',
  'Ctrl+Shift+W',
  'Ctrl+Tab',
  'Ctrl+Shift+Tab',
  'Ctrl+J',
  'Ctrl+Shift+J',
  'Ctrl+Shift+I',
  'Ctrl+Shift+C',
  'Ctrl+R',
  'Ctrl+Shift+R',
  'F5',
  'F12',
  'Alt+F',
  'Alt+E',
  'Alt+D',
  'Alt+ArrowLeft',
  'Alt+ArrowRight',
])

export function isBrowserReserved(shortcut: string): boolean {
  const n = normalizeShortcut(shortcut)
  return n !== null && BROWSER_RESERVED_SHORTCUTS.has(n)
}

export function loadKeymap(storage: KeyValueStorage, commands: readonly KeymapCommand[]): Keymap {
  const map = defaultKeymap(commands) as Record<string, string[]>
  let raw: string | null
  try {
    raw = storage.getItem(KEYMAP_STORAGE_KEY)
  } catch {
    return map
  }
  if (!raw) return map
  let saved: unknown
  try {
    saved = JSON.parse(raw)
  } catch {
    return map
  }
  if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) return map
  for (const [id, value] of Object.entries(saved as Record<string, unknown>)) {
    // Un id que ya no existe (o un valor que no es lista) se ignora.
    if (!Object.prototype.hasOwnProperty.call(map, id) || !Array.isArray(value)) continue
    map[id] = canonicalList(value).filter((s) => !BROWSER_RESERVED_SHORTCUTS.has(s))
  }
  return map
}

export function saveKeymap(storage: KeyValueStorage, commands: readonly KeymapCommand[], keymap: Keymap): void {
  const defaults = defaultKeymap(commands)
  const full: Record<string, string[]> = { ...(defaults as Record<string, string[]>) }
  for (const c of commands) {
    if (!Object.prototype.hasOwnProperty.call(keymap, c.id)) continue
    const list = keymap[c.id]
    const canonical: string[] = []
    for (const s of list) {
      const n = normalizeShortcut(s)
      if (n === null) throw new Error(`El atajo "${s}" de "${c.label}" no es válido`)
      if (BROWSER_RESERVED_SHORTCUTS.has(n)) throw new Error(`El atajo ${n} lo usa el navegador: elige otro para "${c.label}"`)
      if (!canonical.includes(n)) canonical.push(n)
    }
    full[c.id] = canonical
  }
  const conflicts = findConflicts(commands, full)
  if (conflicts.length > 0) {
    const labels = new Map(commands.map((c) => [c.id, c.label]))
    const first = conflicts[0]
    throw new Error(`El atajo ${first.shortcut} está repetido en: ${first.commandIds.map((id) => labels.get(id) ?? id).join(', ')}`)
  }
  const changed: Record<string, string[]> = {}
  for (const c of commands) {
    const a = full[c.id]
    const b = defaults[c.id]
    if (a.length !== b.length || a.some((s, i) => s !== b[i])) changed[c.id] = a
  }
  if (Object.keys(changed).length === 0) storage.removeItem(KEYMAP_STORAGE_KEY)
  else storage.setItem(KEYMAP_STORAGE_KEY, JSON.stringify(changed))
}

export function resetKeymap(storage: KeyValueStorage): void {
  storage.removeItem(KEYMAP_STORAGE_KEY)
}

export function matchEvent(
  event: KeyEventLike,
  context: CommandContext,
  inTextField: boolean,
  commands: readonly KeymapCommand[],
  keymap: Keymap,
  platform: 'mac' | 'other',
): string | null {
  // Los atajos nunca se disparan mientras se escribe en un campo.
  if (inTextField) return null
  const shortcut = shortcutFromEvent(event, platform)
  if (shortcut === null) return null
  if (event.repeat === true) {
    const parsed = parseShortcut(shortcut)
    if (!parsed || !REPEATABLE.has(parsed.key)) return null
  }
  let globalHit: string | null = null
  for (const c of commands) {
    if (!commandShortcuts(c, keymap).includes(shortcut)) continue
    // Un comando del contexto activo gana sobre uno global.
    if (c.context === context) return c.id
    if (c.context === 'global' && globalHit === null) globalHit = c.id
  }
  return globalHit
}
