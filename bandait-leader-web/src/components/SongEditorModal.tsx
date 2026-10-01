import React, { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ClipboardPaste, Eye, EyeOff, Plus, Trash2 } from 'lucide-react'
import type { SectionKind, Song, SongSection } from '../types/hub'
import {
  BPM_MAX,
  BPM_MIN,
  SECTION_KINDS,
  SECTION_KIND_LABELS,
  defaultCueText,
  estimateDurationSec,
  formatDuration,
  sectionStartBars,
} from '../services/workspaceSchema'
import { DEFAULT_SECTION_BARS, parseChordProSong, type ParsedSection } from '../services/chordpro'
import { uuidv4 } from '../services/uuid'
import { HubModal } from './HubModal'
import { ChordProPreview } from './ChordProPreview'
import {
  cardStyle,
  colors,
  ghostButton,
  iconButton,
  inputStyle,
  labelStyle,
  mono,
  primaryButton,
} from './hubStyles'

type CueMode = 'default' | 'none' | 'custom'

interface SectionDraft {
  /** Seccion original: se conservan sus campos desconocidos al guardar. */
  base: SongSection | null
  id: string
  kind: SectionKind
  label: string
  barsText: string
  chordpro: string
  cueMode: CueMode
  cueCustom: string
  showPreview: boolean
}

interface Props {
  /** null = cancion nueva. */
  initial: Song | null
  defaultArtist: string
  onSave: (song: Song) => void
  onCancel: () => void
}

const MAX_BEATS_PER_BAR = 12 // el conteo hablado tiene palabras "uno".."doce" (WORKSPACE_V2 5.1)

function draftFromSection(section: SongSection): SectionDraft {
  const cueMode: CueMode = section.cueText === null ? 'none' : typeof section.cueText === 'string' ? 'custom' : 'default'
  return {
    base: section,
    id: section.id,
    kind: section.kind,
    label: section.label,
    barsText: String(section.bars),
    chordpro: section.chordpro,
    cueMode,
    cueCustom: typeof section.cueText === 'string' ? section.cueText : '',
    showPreview: false,
  }
}

function parseBars(text: string): number | null {
  const t = text.trim()
  if (!/^\d{1,4}$/.test(t)) return null
  const n = Number(t)
  return n >= 1 ? n : null
}

function countKind(drafts: SectionDraft[], kind: SectionKind): number {
  return drafts.filter((d) => d.kind === kind).length
}

export const SongEditorModal: React.FC<Props> = ({ initial, defaultArtist, onSave, onCancel }) => {
  const [songId] = useState(() => initial?.id ?? uuidv4())
  const [title, setTitle] = useState(initial?.title ?? '')
  const [artist, setArtist] = useState(initial?.artist ?? defaultArtist)
  const [bpmText, setBpmText] = useState(String(initial?.bpm ?? 120))
  const [beatsPerBarText, setBeatsPerBarText] = useState(String(initial?.beatsPerBar ?? 4))
  const [beatUnit, setBeatUnit] = useState<number>(initial?.beatUnit ?? 4)
  const [key, setKey] = useState(initial?.key ?? '')
  const [camelot, setCamelot] = useState(initial?.camelot ?? '')
  const [notes, setNotes] = useState(initial?.notes ?? '')
  const [sections, setSections] = useState<SectionDraft[]>(() => (initial?.sections ?? []).map(draftFromSection))
  const [errors, setErrors] = useState<string[]>([])
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [pasteNote, setPasteNote] = useState<string | null>(null)

  const bpm = Number(bpmText)
  const bpmValid = /^\d+(\.\d+)?$/.test(bpmText.trim()) && bpm >= BPM_MIN && bpm <= BPM_MAX
  const beatsPerBar = Number(beatsPerBarText)
  const bpbValid = /^\d{1,2}$/.test(beatsPerBarText.trim()) && beatsPerBar >= 1 && beatsPerBar <= MAX_BEATS_PER_BAR

  const barsList = sections.map((s) => parseBars(s.barsText) ?? 0)
  const starts = sectionStartBars(barsList.map((bars) => ({ bars })))
  const total = barsList.reduce((a, b) => a + b, 0)
  const duration = bpmValid && bpbValid ? estimateDurationSec(total, beatsPerBar, bpm) : null

  const parsedPaste = useMemo(() => (pasteText.trim() ? parseChordProSong(pasteText) : null), [pasteText])

  const updateSection = (index: number, patch: Partial<SectionDraft>) => {
    setSections((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)))
  }

  const changeKind = (index: number, kind: SectionKind) => {
    setSections((prev) =>
      prev.map((s, i) => {
        if (i !== index) return s
        // Si la etiqueta era la automatica del tipo anterior, sigue al tipo nuevo.
        const autoLabel = !s.label.trim() || s.label === SECTION_KIND_LABELS[s.kind] || s.label.startsWith(`${SECTION_KIND_LABELS[s.kind]} `)
        return { ...s, kind, label: autoLabel && kind !== 'custom' ? SECTION_KIND_LABELS[kind] : s.label }
      })
    )
  }

  const moveSection = (index: number, delta: number) => {
    setSections((prev) => {
      const target = index + delta
      if (target < 0 || target >= prev.length) return prev
      const next = [...prev]
      const [moved] = next.splice(index, 1)
      next.splice(target, 0, moved)
      return next
    })
  }

  const addSection = () => {
    setSections((prev) => [
      ...prev,
      {
        base: null,
        id: uuidv4(),
        kind: 'verse',
        label: `Estrofa ${countKind(prev, 'verse') + 1}`,
        barsText: String(DEFAULT_SECTION_BARS),
        chordpro: '',
        cueMode: 'default',
        cueCustom: '',
        showPreview: false,
      },
    ])
  }

  const draftFromParsed = (p: ParsedSection, reuse: SectionDraft | null): SectionDraft => ({
    // Reemplazar por posicion conserva id, compases y campos extra de la seccion existente:
    // el lider usa el id como clave estable.
    base: reuse?.base ?? null,
    id: reuse?.id ?? uuidv4(),
    kind: p.kind,
    label: p.label,
    barsText: reuse ? reuse.barsText : String(p.bars),
    chordpro: p.chordpro,
    cueMode: p.cueText === null ? 'none' : reuse && reuse.kind === p.kind ? reuse.cueMode : 'default',
    cueCustom: reuse && reuse.kind === p.kind ? reuse.cueCustom : '',
    showPreview: false,
  })

  const applyPaste = (mode: 'replace' | 'append') => {
    if (!parsedPaste) return
    const notesOut: string[] = []
    if (parsedPaste.title && !title.trim()) setTitle(parsedPaste.title)
    else if (parsedPaste.title && parsedPaste.title !== title.trim()) notesOut.push(`Título del ChordPro ignorado ("${parsedPaste.title}").`)
    if (parsedPaste.artist && (!artist.trim() || artist === defaultArtist)) setArtist(parsedPaste.artist)
    if (parsedPaste.key && !key.trim()) setKey(parsedPaste.key)
    if (parsedPaste.bpm && parsedPaste.bpm >= BPM_MIN && parsedPaste.bpm <= BPM_MAX && !initial) setBpmText(String(parsedPaste.bpm))
    setSections((prev) =>
      mode === 'replace'
        ? parsedPaste.sections.map((p, i) => draftFromParsed(p, prev[i] ?? null))
        : [...prev, ...parsedPaste.sections.map((p) => draftFromParsed(p, null))]
    )
    setPasteOpen(false)
    setPasteText('')
    setPasteNote(
      `${parsedPaste.sections.length} sección(es) ${mode === 'replace' ? 'aplicadas' : 'agregadas'}. Ajusta los compases de cada una.${
        notesOut.length ? ` ${notesOut.join(' ')}` : ''
      }`
    )
  }

  const handleSave = () => {
    const errs: string[] = []
    if (!title.trim()) errs.push('El título es obligatorio.')
    if (!bpmValid) errs.push(`El BPM debe estar entre ${BPM_MIN} y ${BPM_MAX}.`)
    if (!bpbValid) errs.push(`Los tiempos por compás deben ser un entero de 1 a ${MAX_BEATS_PER_BAR}.`)
    sections.forEach((s, i) => {
      if (parseBars(s.barsText) === null) errs.push(`Sección ${i + 1}: los compases deben ser un entero mayor o igual a 1.`)
      if (s.cueMode === 'custom' && !s.cueCustom.trim()) errs.push(`Sección ${i + 1}: escribe el aviso o elige "Sin aviso".`)
    })
    setErrors(errs)
    if (errs.length > 0) return

    const outSections: SongSection[] = sections.map((s) => {
      const sec: SongSection = {
        ...(s.base ?? {}),
        id: s.id,
        kind: s.kind,
        label: s.label.trim() || SECTION_KIND_LABELS[s.kind],
        bars: parseBars(s.barsText) as number,
        chordpro: s.chordpro.replace(/\s+$/, ''),
      }
      if (s.cueMode === 'default') delete sec.cueText
      else if (s.cueMode === 'none') sec.cueText = null
      else sec.cueText = s.cueCustom.trim()
      return sec
    })
    const song: Song = {
      ...(initial ?? {}),
      id: songId,
      title: title.trim(),
      artist: artist.trim(),
      bpm,
      beatsPerBar,
      beatUnit,
      key: key.trim(),
      sections: outSections,
      updatedAt: initial?.updatedAt ?? new Date().toISOString(),
    }
    if (camelot.trim()) song.camelot = camelot.trim()
    else delete song.camelot
    if (notes.trim()) song.notes = notes.trim()
    else delete song.notes
    onSave(song)
  }

  return (
    <HubModal
      title={initial ? `EDITAR CANCIÓN // ${initial.title.toUpperCase()}` : 'NUEVA CANCIÓN'}
      onClose={onCancel}
      maxWidth="860px"
      testId="song-editor"
      closeOnEscape={false}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', minWidth: 0 }}>
        {/* DATOS DE LA CANCION */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' }}>
          <div>
            <label htmlFor="song-title" style={labelStyle}>
              TÍTULO
            </label>
            <input id="song-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ej: Medianoche en Pereira" style={inputStyle} />
          </div>
          <div>
            <label htmlFor="song-artist" style={labelStyle}>
              ARTISTA / AUTOR
            </label>
            <input id="song-artist" value={artist} onChange={(e) => setArtist(e.target.value)} style={inputStyle} />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: '10px' }}>
          <div>
            <label htmlFor="song-bpm" style={labelStyle}>
              BPM ({BPM_MIN}-{BPM_MAX})
            </label>
            <input
              id="song-bpm"
              inputMode="decimal"
              value={bpmText}
              onChange={(e) => setBpmText(e.target.value)}
              style={{ ...inputStyle, borderColor: bpmValid ? colors.border : colors.danger }}
            />
          </div>
          <div>
            <label htmlFor="song-bpb" style={labelStyle}>
              TIEMPOS / COMPÁS
            </label>
            <input
              id="song-bpb"
              inputMode="numeric"
              value={beatsPerBarText}
              onChange={(e) => setBeatsPerBarText(e.target.value)}
              style={{ ...inputStyle, borderColor: bpbValid ? colors.border : colors.danger }}
            />
          </div>
          <div>
            <label htmlFor="song-beat-unit" style={labelStyle}>
              FIGURA
            </label>
            <select id="song-beat-unit" value={beatUnit} onChange={(e) => setBeatUnit(Number(e.target.value))} style={inputStyle}>
              {[2, 4, 8].map((u) => (
                <option key={u} value={u}>
                  {beatsPerBarText || '?'}/{u}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="song-key" style={labelStyle}>
              TONO ORIGINAL
            </label>
            <input id="song-key" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Am" style={inputStyle} />
          </div>
          <div>
            <label htmlFor="song-camelot" style={labelStyle}>
              CAMELOT
            </label>
            <input id="song-camelot" value={camelot} onChange={(e) => setCamelot(e.target.value)} placeholder="8A" style={inputStyle} />
          </div>
        </div>

        <div>
          <label htmlFor="song-notes" style={labelStyle}>
            NOTAS
          </label>
          <input id="song-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ej: final con corte seco" style={inputStyle} />
        </div>

        {/* RESUMEN POR COMPASES */}
        <div
          data-testid="song-summary"
          style={{
            ...cardStyle,
            background: colors.oled,
            padding: '10px 12px',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '6px 18px',
            fontFamily: mono,
            fontSize: '12px',
            color: colors.muted,
          }}
        >
          <span>
            SECCIONES: <strong style={{ color: colors.text }}>{sections.length}</strong>
          </span>
          <span>
            TOTAL: <strong data-testid="song-total-bars" style={{ color: colors.text }}>{total}</strong> COMPASES
          </span>
          <span>
            DURACIÓN ESTIMADA:{' '}
            <strong data-testid="song-duration" style={{ color: colors.text }}>
              {duration !== null ? formatDuration(duration) : '--:--'}
            </strong>
          </span>
          {sections.length === 0 && (
            <span style={{ color: colors.warning, flexBasis: '100%' }}>
              Sin secciones el líder no conoce el final de la canción: la entrada a la siguiente será MANUAL CUE.
            </span>
          )}
        </div>

        {/* PEGAR CHORDPRO COMPLETO */}
        {!pasteOpen ? (
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button type="button" onClick={addSection} style={ghostButton}>
              <Plus size={14} /> AÑADIR SECCIÓN
            </button>
            <button type="button" onClick={() => setPasteOpen(true)} style={ghostButton}>
              <ClipboardPaste size={14} /> PEGAR CHORDPRO COMPLETO
            </button>
          </div>
        ) : (
          <div data-testid="chordpro-paste" style={{ ...cardStyle, padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <label htmlFor="chordpro-paste-text" style={labelStyle}>
              PEGA LA CANCIÓN EN CHORDPRO O CON ENCABEZADOS ([Coro], Estrofa 1, Intro...)
            </label>
            <textarea
              id="chordpro-paste-text"
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              rows={8}
              placeholder={'{title: Mi canción}\n{start_of_verse: Estrofa 1}\n[Am]Hoy vuelvo a [F]casa\n{end_of_verse}\n\nCoro:\n[F]Canta [G]fuerte'}
              style={{ ...inputStyle, fontFamily: mono, fontSize: '12px', resize: 'vertical' }}
            />
            {parsedPaste && (
              <div data-testid="chordpro-paste-result" style={{ fontFamily: mono, fontSize: '11px', color: colors.muted }}>
                {parsedPaste.title && <div>TÍTULO: {parsedPaste.title}</div>}
                {parsedPaste.artist && <div>ARTISTA: {parsedPaste.artist}</div>}
                <div>
                  {parsedPaste.sections.length} SECCIÓN(ES) DETECTADA(S): {parsedPaste.sections.map((s) => s.label).join(' · ') || 'ninguna'}
                </div>
                <div>Cada sección queda con {DEFAULT_SECTION_BARS} compases: ajústalos después.</div>
                {sections.length > 0 && (
                  <div style={{ color: colors.warning }}>
                    REEMPLAZAR conserva por posición el id y los compases de las {sections.length} secciones actuales.
                  </div>
                )}
              </div>
            )}
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {sections.length === 0 ? (
                <button type="button" disabled={!parsedPaste?.sections.length} onClick={() => applyPaste('replace')} style={primaryButton(colors.cobalt)}>
                  APLICAR SECCIONES
                </button>
              ) : (
                <>
                  <button type="button" disabled={!parsedPaste?.sections.length} onClick={() => applyPaste('replace')} style={primaryButton(colors.cobalt)}>
                    REEMPLAZAR SECCIONES
                  </button>
                  <button type="button" disabled={!parsedPaste?.sections.length} onClick={() => applyPaste('append')} style={ghostButton}>
                    AGREGAR AL FINAL
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => {
                  setPasteOpen(false)
                  setPasteText('')
                }}
                style={{ ...ghostButton, background: 'transparent', color: colors.muted }}
              >
                CANCELAR
              </button>
            </div>
          </div>
        )}
        {pasteNote && (
          <div data-testid="chordpro-paste-note" style={{ fontSize: '11px', color: colors.success, fontFamily: mono }}>
            {pasteNote}
          </div>
        )}

        {/* SECCIONES */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0 }}>
          {sections.length === 0 && (
            <div style={{ fontSize: '12px', color: colors.muted, padding: '8px 0' }}>
              Sin secciones todavía. Añade secciones o pega la canción completa en ChordPro.
            </div>
          )}
          {sections.map((s, i) => {
            const bars = parseBars(s.barsText)
            const start = starts[i]
            const end = bars ? start + bars - 1 : null
            const n = i + 1
            return (
              <div
                key={s.id}
                data-testid="section-row"
                style={{ ...cardStyle, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: mono, fontSize: '12px', fontWeight: 700 }}>
                    <span style={{ color: colors.orange }}>#{String(n).padStart(2, '0')}</span>{' '}
                    <span data-testid="section-start" style={{ color: colors.muted }}>
                      {end !== null ? `COMPÁS ${start}-${end}` : `DESDE COMPÁS ${start}`}
                    </span>
                  </span>
                  <div style={{ display: 'flex', gap: '4px' }}>
                    <button type="button" aria-label={`Subir la sección ${n}`} disabled={i === 0} onClick={() => moveSection(i, -1)} style={iconButton(colors.text, i === 0)}>
                      <ArrowUp size={13} />
                    </button>
                    <button
                      type="button"
                      aria-label={`Bajar la sección ${n}`}
                      disabled={i === sections.length - 1}
                      onClick={() => moveSection(i, 1)}
                      style={iconButton(colors.text, i === sections.length - 1)}
                    >
                      <ArrowDown size={13} />
                    </button>
                    <button
                      type="button"
                      aria-label={`Eliminar la sección ${n}`}
                      onClick={() => setSections((prev) => prev.filter((_, j) => j !== i))}
                      style={iconButton(colors.danger)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '8px' }}>
                  <div>
                    <label htmlFor={`sec-kind-${s.id}`} style={labelStyle}>
                      TIPO
                    </label>
                    <select
                      id={`sec-kind-${s.id}`}
                      aria-label={`Tipo de la sección ${n}`}
                      value={s.kind}
                      onChange={(e) => changeKind(i, e.target.value as SectionKind)}
                      style={inputStyle}
                    >
                      {SECTION_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {SECTION_KIND_LABELS[k]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor={`sec-label-${s.id}`} style={labelStyle}>
                      ETIQUETA
                    </label>
                    <input
                      id={`sec-label-${s.id}`}
                      aria-label={`Etiqueta de la sección ${n}`}
                      value={s.label}
                      onChange={(e) => updateSection(i, { label: e.target.value })}
                      style={inputStyle}
                    />
                  </div>
                  <div>
                    <label htmlFor={`sec-bars-${s.id}`} style={labelStyle}>
                      COMPASES
                    </label>
                    <input
                      id={`sec-bars-${s.id}`}
                      aria-label={`Compases de la sección ${n}`}
                      inputMode="numeric"
                      value={s.barsText}
                      onChange={(e) => updateSection(i, { barsText: e.target.value })}
                      style={{ ...inputStyle, borderColor: bars ? colors.border : colors.danger }}
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor={`sec-chordpro-${s.id}`} style={labelStyle}>
                    CHORDPRO (ACORDES ENTRE CORCHETES ANTES DE LA SÍLABA)
                  </label>
                  <textarea
                    id={`sec-chordpro-${s.id}`}
                    aria-label={`ChordPro de la sección ${n}`}
                    value={s.chordpro}
                    onChange={(e) => updateSection(i, { chordpro: e.target.value })}
                    rows={3}
                    placeholder="[Am]Hoy vuelvo a [F]casa"
                    style={{ ...inputStyle, fontFamily: mono, fontSize: '12px', resize: 'vertical' }}
                  />
                </div>

                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <div style={{ flex: '1 1 160px', minWidth: 0 }}>
                    <label htmlFor={`sec-cue-${s.id}`} style={labelStyle}>
                      AVISO DE VOZ
                    </label>
                    <select
                      id={`sec-cue-${s.id}`}
                      aria-label={`Aviso de voz de la sección ${n}`}
                      value={s.cueMode}
                      onChange={(e) => updateSection(i, { cueMode: e.target.value as CueMode })}
                      style={inputStyle}
                    >
                      <option value="default">Por defecto: "{defaultCueText(s.kind, s.label.trim() || SECTION_KIND_LABELS[s.kind])}"</option>
                      <option value="none">Sin aviso</option>
                      <option value="custom">Personalizado</option>
                    </select>
                  </div>
                  {s.cueMode === 'custom' && (
                    <div style={{ flex: '2 1 200px', minWidth: 0 }}>
                      <label htmlFor={`sec-cue-text-${s.id}`} style={labelStyle}>
                        TEXTO DEL AVISO
                      </label>
                      <input
                        id={`sec-cue-text-${s.id}`}
                        aria-label={`Texto del aviso de la sección ${n}`}
                        value={s.cueCustom}
                        onChange={(e) => updateSection(i, { cueCustom: e.target.value })}
                        placeholder="Ej: Coro final, todos"
                        style={inputStyle}
                      />
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => updateSection(i, { showPreview: !s.showPreview })}
                    style={{ ...ghostButton, padding: '8px 10px', fontSize: '11px' }}
                  >
                    {s.showPreview ? <EyeOff size={13} /> : <Eye size={13} />} {s.showPreview ? 'OCULTAR' : 'VISTA PREVIA'}
                  </button>
                </div>

                {s.showPreview && <ChordProPreview chordpro={s.chordpro} />}
              </div>
            )
          })}
        </div>

        {sections.length > 0 && (
          <div>
            <button type="button" onClick={addSection} style={ghostButton}>
              <Plus size={14} /> AÑADIR SECCIÓN
            </button>
          </div>
        )}

        {errors.length > 0 && (
          <div
            data-testid="song-editor-errors"
            style={{ border: `1px solid ${colors.danger}`, borderRadius: '4px', padding: '8px 10px', color: colors.danger, fontSize: '12px' }}
          >
            {errors.map((e) => (
              <div key={e}>{e}</div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', flexWrap: 'wrap', borderTop: `1px solid ${colors.border}`, paddingTop: '12px' }}>
          <button type="button" onClick={onCancel} style={{ ...ghostButton, background: 'transparent', color: colors.muted }}>
            CANCELAR
          </button>
          <button type="button" onClick={handleSave} style={primaryButton()} data-testid="song-save">
            GUARDAR CANCIÓN
          </button>
        </div>
        <div style={{ fontSize: '11px', color: colors.disabled, fontFamily: mono }}>
          Los cambios se guardan al pulsar GUARDAR CANCIÓN.
        </div>
      </div>
    </HubModal>
  )
}
