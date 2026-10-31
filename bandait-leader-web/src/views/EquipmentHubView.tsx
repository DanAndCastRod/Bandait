import React, { useState } from 'react'
import { useHub } from '../context/hubContextCore'
import type { EquipmentCategory, EquipmentItem } from '../types/hub'
import { Radio, Plus, Trash2, Cpu, Headphones, Cable, Mic, Pencil } from 'lucide-react'
import { HubModal } from '../components/HubModal'
import { cardStyle, colors, ghostButton, headerBarStyle, iconButton, inputStyle, labelStyle, mono, primaryButton, viewStyle } from '../components/hubStyles'

type EquipmentForm = Omit<EquipmentItem, 'id' | 'bandId'>

const EMPTY_FORM: EquipmentForm = {
  category: 'interface',
  name: '',
  model: '',
  assignedTo: '',
  channelRouting: '',
  rfFrequency: '',
  notes: '',
}

const CATEGORY_LABELS: Record<EquipmentCategory, string> = {
  interface: 'Interfaz / Consola ASIO',
  in_ear: 'Transmisor / In-Ear RF',
  cabling: 'Cable Físico Escenario',
  mic: 'Microfonía & DI Box',
  instrument: 'Instrumento / Módulo',
}

/** AJUSTES > Equipamiento: rider tecnico de la banda (agregar, editar y quitar equipos). */
export const EquipmentHubView: React.FC = () => {
  const { activeBand, equipment, addEquipment, updateEquipment, removeEquipment } = useHub()
  /** null = cerrado; 'new' = agregar; un id = editar ese equipo. */
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState<EquipmentForm>(EMPTY_FORM)

  const openNew = () => {
    setForm(EMPTY_FORM)
    setEditing('new')
  }

  const openEdit = (item: EquipmentItem) => {
    setForm({
      category: item.category,
      name: item.name,
      model: item.model,
      assignedTo: item.assignedTo,
      channelRouting: item.channelRouting,
      rfFrequency: item.rfFrequency ?? '',
      notes: item.notes ?? '',
    })
    setEditing(item.id)
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim() || !editing) return
    const data: EquipmentForm = {
      category: form.category,
      name: form.name.trim(),
      model: form.model.trim(),
      assignedTo: form.assignedTo.trim() || 'Escenario General',
      channelRouting: form.channelRouting.trim() || 'No especificado',
      rfFrequency: form.rfFrequency?.trim() || undefined,
      notes: form.notes?.trim() || undefined,
    }
    if (editing === 'new') addEquipment(data)
    else updateEquipment(editing, data)
    setEditing(null)
  }

  const set = (patch: Partial<EquipmentForm>) => setForm((prev) => ({ ...prev, ...patch }))

  const categoryIcons: Record<EquipmentCategory, React.ReactNode> = {
    interface: <Cpu size={16} style={{ color: colors.cobalt }} />,
    in_ear: <Headphones size={16} style={{ color: colors.orange }} />,
    cabling: <Cable size={16} style={{ color: colors.success }} />,
    mic: <Mic size={16} style={{ color: colors.warning }} />,
    instrument: <Radio size={16} style={{ color: colors.violet }} />,
  }

  return (
    <div style={viewStyle}>
      <div style={headerBarStyle}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Radio size={22} style={{ color: colors.warning, flexShrink: 0 }} />
            <h2 style={{ margin: 0, fontSize: '22px', fontWeight: 800, letterSpacing: '-0.5px' }}>Rider Técnico & Ruteo de Equipos</h2>
          </div>
          <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: colors.muted }}>
            Inventario de hardware en vivo para {activeBand?.name}: interfaces ASIO, frecuencias RF In-Ear y cableado directo.
          </p>
        </div>

        <button
          type="button"
          className="stx-btn"
          onClick={openNew}
          style={{ ...primaryButton(colors.warning), color: colors.onAccent, padding: '10px 18px', fontWeight: 800 }}
        >
          <Plus size={16} />
          <span>+ AGREGAR EQUIPO / HARDWARE</span>
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: '16px' }}>
        {equipment.map((item) => (
          <div
            key={item.id}
            data-testid="equipment-card"
            style={{ ...cardStyle, padding: '18px', display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                <div style={{ background: colors.elevated, padding: '6px', borderRadius: '4px', display: 'flex' }}>{categoryIcons[item.category]}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 800, fontSize: '15px', color: colors.text, overflowWrap: 'anywhere' }}>{item.name}</div>
                  <div style={{ fontSize: '11px', color: colors.muted, fontFamily: mono, overflowWrap: 'anywhere' }}>{item.model}</div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                <button type="button" className="stx-btn" onClick={() => openEdit(item)} aria-label={`Editar ${item.name}`} title="Editar equipo" style={iconButton(colors.text)}>
                  <Pencil size={13} />
                </button>
                <button
                  type="button"
                  className="stx-btn"
                  onClick={() => removeEquipment(item.id)}
                  aria-label={`Eliminar ${item.name}`}
                  title="Eliminar equipo"
                  style={iconButton(colors.danger)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>

            <div
              style={{
                background: colors.input,
                border: `1px solid ${colors.border}`,
                borderRadius: '4px',
                padding: '10px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
                fontFamily: mono,
                fontSize: '11px',
              }}
            >
              <div>
                <span style={{ color: colors.muted }}>ASIGNADO A:</span> <strong style={{ color: colors.text }}>{item.assignedTo}</strong>
              </div>
              <div>
                <span style={{ color: colors.muted }}>RUTEO / SALIDAS:</span> <strong style={{ color: colors.cobalt }}>{item.channelRouting}</strong>
              </div>
              {item.rfFrequency && (
                <div>
                  <span style={{ color: colors.muted }}>FRECUENCIA RF:</span> <strong style={{ color: colors.warning }}>{item.rfFrequency}</strong>
                </div>
              )}
            </div>

            {item.notes && <div style={{ fontSize: '11px', color: colors.muted, lineHeight: 1.4 }}>{item.notes}</div>}
          </div>
        ))}
      </div>

      {editing && (
        <HubModal
          title={editing === 'new' ? 'REGISTRAR EQUIPO TÉCNICO' : 'EDITAR EQUIPO TÉCNICO'}
          onClose={() => setEditing(null)}
          maxWidth="480px"
          testId="equipment-editor"
        >
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div>
              <label htmlFor="eq-name" style={labelStyle}>
                NOMBRE DEL EQUIPO
              </label>
              <input id="eq-name" type="text" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Ej: Interfaz Principal FOH" required style={inputStyle} />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px' }}>
              <div>
                <label htmlFor="eq-category" style={labelStyle}>
                  CATEGORÍA
                </label>
                <select id="eq-category" value={form.category} onChange={(e) => set({ category: e.target.value as EquipmentCategory })} style={inputStyle}>
                  {(Object.keys(CATEGORY_LABELS) as EquipmentCategory[]).map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABELS[c]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="eq-model" style={labelStyle}>
                  MARCA / MODELO
                </label>
                <input id="eq-model" type="text" value={form.model} onChange={(e) => set({ model: e.target.value })} placeholder="Ej: Soundcraft Ui24R" required style={inputStyle} />
              </div>
            </div>

            <div>
              <label htmlFor="eq-assigned" style={labelStyle}>
                ASIGNADO A (MÚSICO / PUESTO)
              </label>
              <input
                id="eq-assigned"
                type="text"
                value={form.assignedTo}
                onChange={(e) => set({ assignedTo: e.target.value })}
                placeholder="Ej: Mateo Gómez (Batería) / FOH Soundcraft"
                style={inputStyle}
              />
            </div>

            <div>
              <label htmlFor="eq-routing" style={labelStyle}>
                RUTEO DE CANALES / CONECTORES
              </label>
              <input
                id="eq-routing"
                type="text"
                value={form.channelRouting}
                onChange={(e) => set({ channelRouting: e.target.value })}
                placeholder="Ej: Salida 1-2 PA Main / Salida 3 Drummer Cable"
                style={inputStyle}
              />
            </div>

            <div>
              <label htmlFor="eq-rf" style={labelStyle}>
                FRECUENCIA RF (SI APLICA)
              </label>
              <input id="eq-rf" type="text" value={form.rfFrequency ?? ''} onChange={(e) => set({ rfFrequency: e.target.value })} placeholder="Ej: 518.200 MHz (Grupo 1 Canal 4)" style={inputStyle} />
            </div>

            <div>
              <label htmlFor="eq-notes" style={labelStyle}>
                NOTAS
              </label>
              <input id="eq-notes" type="text" value={form.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} placeholder="Ej: Limiter interno activado" style={inputStyle} />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '6px', flexWrap: 'wrap' }}>
              <button type="button" className="stx-btn" onClick={() => setEditing(null)} style={{ ...ghostButton, background: 'transparent', color: colors.muted }}>
                CANCELAR
              </button>
              <button type="submit" className="stx-btn" data-testid="equipment-save" style={{ ...primaryButton(colors.warning), color: colors.onAccent, fontWeight: 800 }}>
                {editing === 'new' ? 'REGISTRAR EQUIPO' : 'GUARDAR CAMBIOS'}
              </button>
            </div>
          </form>
        </HubModal>
      )}
    </div>
  )
}
