import { describe, it, expect } from 'vitest'
import { DEFAULT_THEME, THEME_KEY, THEME_MIGRATED_KEY, resolveTheme } from '../theme'

function store(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init))
  return {
    data,
    getItem: (k: string) => (data.has(k) ? (data.get(k) as string) : null),
    setItem: (k: string, v: string) => void data.set(k, v),
  }
}

describe('resolveTheme (Grafito por defecto desde 2026-10-30)', () => {
  it('sin preferencia, Grafito', () => {
    expect(resolveTheme(store())).toBe(DEFAULT_THEME)
    expect(DEFAULT_THEME).toBe('theme-grafito')
  })

  it("un 'theme-swiss' guardado por el valor por defecto viejo pasa a Grafito una sola vez", () => {
    const s = store({ [THEME_KEY]: 'theme-swiss' })
    expect(resolveTheme(s)).toBe('theme-grafito')
    expect(s.data.get(THEME_MIGRATED_KEY)).toBe('1')
    s.setItem(THEME_KEY, 'theme-swiss') // ahora si lo elige a proposito
    expect(resolveTheme(s)).toBe('theme-swiss')
  })

  it('respeta un tema elegido a proposito y descarta valores desconocidos', () => {
    expect(resolveTheme(store({ [THEME_KEY]: 'theme-tokyo' }))).toBe('theme-tokyo')
    expect(resolveTheme(store({ [THEME_KEY]: 'theme-neon', [THEME_MIGRATED_KEY]: '1' }))).toBe(DEFAULT_THEME)
    expect(resolveTheme(null)).toBe(DEFAULT_THEME)
  })
})
