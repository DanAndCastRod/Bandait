/**
 * Markdown minimo para las respuestas del asistente del Estudio. El modelo escribe con **negritas**,
 * *cursivas*, `codigo`, listas y titulos; sin esto el chat mostraba los asteriscos tal cual.
 *
 * Devuelve un arbol de datos (nunca HTML): la vista lo pinta con elementos de React, asi que un
 * texto del modelo no puede inyectar etiquetas, enlaces ni scripts. Lo que no se reconoce queda
 * como texto plano.
 *
 * Soporta: parrafos (lineas seguidas se unen con salto de linea), titulos #..###### (se pintan
 * como texto fuerte), listas con "-", "*", "+" o "1." / "1)", bloques ``` y, dentro de una linea,
 * **negrita** / __negrita__, *cursiva* / _cursiva_ y `codigo`.
 *
 * Modulo puro: sin DOM.
 */

export type MdInline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; children: MdInline[] }
  | { kind: 'em'; children: MdInline[] }
  | { kind: 'code'; text: string }

export type MdBlock =
  | { kind: 'paragraph'; lines: MdInline[][] }
  | { kind: 'heading'; children: MdInline[] }
  | { kind: 'list'; ordered: boolean; items: MdInline[][] }
  | { kind: 'code'; text: string }

const LIST_RE = /^\s*(?:([-*+])|(\d{1,3})[.)])\s+(.*)$/
const HEADING_RE = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/
const FENCE_RE = /^\s*```/

/** Une textos vecinos para que el arbol quede compacto. */
function pushText(out: MdInline[], text: string): void {
  if (text === '') return
  const last = out[out.length - 1]
  if (last && last.kind === 'text') last.text += text
  else out.push({ kind: 'text', text })
}

/**
 * Busca el cierre de un delimitador desde `from`. El cierre no puede ir pegado a un espacio por
 * dentro ("** x**" no es negrita), igual que en CommonMark.
 */
function findClose(src: string, delim: string, from: number): number {
  let i = src.indexOf(delim, from)
  while (i !== -1) {
    // En "***" el cierre doble es el par final: el primer '*' cierra una cursiva interna.
    while (delim.length === 2 && src[i + 2] === delim[0]) i++
    if (i > from && !/\s/.test(src[i - 1])) return i
    i = src.indexOf(delim, i + 1)
  }
  return -1
}

export function parseInline(src: string, depth = 0): MdInline[] {
  const out: MdInline[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === '`') {
      const end = src.indexOf('`', i + 1)
      if (end > i + 1) {
        out.push({ kind: 'code', text: src.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }
    if (depth < 4 && (ch === '*' || ch === '_')) {
      const double = src[i + 1] === ch
      const delim = double ? ch + ch : ch
      const start = i + delim.length
      const next = src[start]
      // Un '_' dentro de una palabra (nombre_de_pista) no abre cursiva.
      const intraword = ch === '_' && i > 0 && /[\p{L}\p{N}]/u.test(src[i - 1])
      if (next !== undefined && !/\s/.test(next) && !intraword) {
        const end = findClose(src, delim, start)
        if (end !== -1 && !(double === false && src[end + 1] === ch)) {
          const inner = parseInline(src.slice(start, end), depth + 1)
          out.push(double ? { kind: 'strong', children: inner } : { kind: 'em', children: inner })
          i = end + delim.length
          continue
        }
      }
      pushText(out, delim)
      i = start
      continue
    }
    pushText(out, ch)
    i++
  }
  return out
}

export function parseChatMarkdown(text: string): MdBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MdBlock[] = []
  let para: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null

  const flushPara = () => {
    if (para.length > 0) blocks.push({ kind: 'paragraph', lines: para.map((l) => parseInline(l)) })
    para = []
  }
  const flushList = () => {
    if (list) blocks.push({ kind: 'list', ordered: list.ordered, items: list.items.map((l) => parseInline(l)) })
    list = null
  }

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]
    if (FENCE_RE.test(line)) {
      flushPara()
      flushList()
      const body: string[] = []
      n++
      while (n < lines.length && !FENCE_RE.test(lines[n])) body.push(lines[n++])
      blocks.push({ kind: 'code', text: body.join('\n') })
      continue
    }
    if (line.trim() === '') {
      flushPara()
      flushList()
      continue
    }
    const heading = HEADING_RE.exec(line)
    if (heading) {
      flushPara()
      flushList()
      blocks.push({ kind: 'heading', children: parseInline(heading[1]) })
      continue
    }
    const item = LIST_RE.exec(line)
    if (item) {
      flushPara()
      const ordered = item[2] !== undefined
      if (list && list.ordered !== ordered) flushList()
      if (!list) list = { ordered, items: [] }
      list.items.push(item[3])
      continue
    }
    if (list) {
      // Una linea sangrada sigue el punto anterior; una sin sangria cierra la lista.
      if (/^\s{2,}/.test(line)) {
        list.items[list.items.length - 1] += ` ${line.trim()}`
        continue
      }
      flushList()
    }
    para.push(line)
  }
  flushPara()
  flushList()
  return blocks
}
