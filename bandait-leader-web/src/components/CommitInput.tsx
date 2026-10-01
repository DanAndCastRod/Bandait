import React, { useState } from 'react'
import { colors, smallInputStyle } from './hubStyles'

interface Props {
  value: string
  /** Devuelve false si el valor no es valido: el campo vuelve al valor guardado. */
  onCommit: (text: string) => boolean
  ariaLabel: string
  width?: string
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode']
  title?: string
  testId?: string
}

/**
 * Campo que guarda al salir (blur) o con Enter, no en cada tecla: evita una subida a la nube
 * por pulsacion y deja escribir valores intermedios ("1" antes de "120").
 */
export const CommitInput: React.FC<Props> = ({ value, onCommit, ariaLabel, width = '64px', inputMode, title, testId }) => {
  const [draft, setDraft] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)

  const commit = () => {
    if (draft === null) return
    if (draft !== value) {
      const ok = onCommit(draft)
      setInvalid(!ok)
      if (!ok) {
        setTimeout(() => setInvalid(false), 1500)
      }
    }
    setDraft(null)
  }

  return (
    <input
      aria-label={ariaLabel}
      title={title}
      data-testid={testId}
      inputMode={inputMode}
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setDraft(null)
      }}
      style={{ ...smallInputStyle, width, borderColor: invalid ? colors.danger : colors.border }}
    />
  )
}
