import React, { useState } from 'react'
import { useHub } from '../context/HubContext'
import type { EquipmentCategory } from '../types/hub'
import { Radio, Plus, Trash2, Cpu, Headphones, Cable, Mic } from 'lucide-react'

export const EquipmentHubView: React.FC = () => {
  const { activeBand, equipment, addEquipment, removeEquipment } = useHub()
  const [showAddModal, setShowAddModal] = useState(false)
  const [eqName, setEqName] = useState('')
  const [eqModel, setEqModel] = useState('')
  const [eqCategory, setEqCategory] = useState<EquipmentCategory>('interface')
  const [eqAssignedTo, setEqAssignedTo] = useState('')
  const [eqRouting, setEqRouting] = useState('')
  const [eqRf, setEqRf] = useState('')
  const [eqNotes, setEqNotes] = useState('')

  const handleAddEquipment = (e: React.FormEvent) => {
    e.preventDefault()
    if (!eqName.trim()) return

    addEquipment({
      category: eqCategory,
      name: eqName.trim(),
      model: eqModel.trim(),
      assignedTo: eqAssignedTo.trim() || 'Escenario General',
      channelRouting: eqRouting.trim() || 'No especificado',
      rfFrequency: eqRf.trim() || undefined,
      notes: eqNotes.trim() || undefined,
    })

    setEqName('')
    setEqModel('')
    setEqRouting('')
    setEqRf('')
    setEqNotes('')
    setShowAddModal(false)
  }

  const categoryIcons: Record<EquipmentCategory, React.ReactNode> = {
    interface: <Cpu size={16} style={{ color: '#0066ff' }} />,
    in_ear: <Headphones size={16} style={{ color: '#ff4500' }} />,
    cabling: <Cable size={16} style={{ color: '#10b981' }} />,
    mic: <Mic size={16} style={{ color: '#f59e0b' }} />,
    instrument: <Radio size={16} style={{ color: '#a855f7' }} />,
  }

  return (
    <div style={{ padding: 'clamp(12px, 3vw, 24px)', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* HEADER BAR */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '16px',
          borderBottom: '1px solid #2a3346',
          paddingBottom: '16px',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Radio size={22} style={{ color: '#f59e0b' }} />
            <h2 style={{ margin: 0, fontSize: '22px', fontWeight: 800, letterSpacing: '-0.5px' }}>
              Rider Técnico & Ruteo de Equipos
            </h2>
          </div>
          <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: '#94a3b8' }}>
            Inventario de hardware en vivo para {activeBand?.name}: interfaces ASIO, frecuencias RF In-Ear y cableado directo.
          </p>
        </div>

        <button
          onClick={() => setShowAddModal(true)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            background: '#f59e0b',
            border: 'none',
            borderRadius: '4px',
            padding: '10px 18px',
            color: '#000000',
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: '12px',
            fontWeight: 800,
            cursor: 'pointer',
            boxShadow: '0 0 12px rgba(245, 158, 11, 0.3)',
          }}
        >
          <Plus size={16} />
          <span>+ AGREGAR EQUIPO / HARDWARE</span>
        </button>
      </div>

      {/* EQUIPMENT CARDS GRID */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: '16px',
        }}
      >
        {equipment.map((item) => (
          <div
            key={item.id}
            style={{
              background: '#131720',
              border: '1px solid #2a3346',
              borderRadius: '6px',
              padding: '18px',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
              position: 'relative',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div
                  style={{
                    background: '#1a202c',
                    padding: '6px',
                    borderRadius: '4px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {categoryIcons[item.category]}
                </div>
                <div>
                  <div style={{ fontWeight: 800, fontSize: '15px', color: '#ffffff' }}>{item.name}</div>
                  <div style={{ fontSize: '11px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
                    {item.model}
                  </div>
                </div>
              </div>

              <button
                onClick={() => removeEquipment(item.id)}
                title="Eliminar equipo"
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#ef4444',
                  cursor: 'pointer',
                  padding: '4px',
                }}
              >
                <Trash2 size={15} />
              </button>
            </div>

            <div
              style={{
                background: '#0d1017',
                border: '1px solid #2a3346',
                borderRadius: '4px',
                padding: '10px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: '11px',
              }}
            >
              <div>
                <span style={{ color: '#94a3b8' }}>ASIGNADO A:</span>{' '}
                <strong style={{ color: '#ffffff' }}>{item.assignedTo}</strong>
              </div>
              <div>
                <span style={{ color: '#94a3b8' }}>RUTEO / SALIDAS:</span>{' '}
                <strong style={{ color: '#0066ff' }}>{item.channelRouting}</strong>
              </div>
              {item.rfFrequency && (
                <div>
                  <span style={{ color: '#94a3b8' }}>FRECUENCIA RF:</span>{' '}
                  <strong style={{ color: '#f59e0b' }}>{item.rfFrequency}</strong>
                </div>
              )}
            </div>

            {item.notes && (
              <div style={{ fontSize: '11px', color: '#94a3b8', lineHeight: 1.4 }}>
                {item.notes}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ADD EQUIPMENT MODAL */}
      {showAddModal && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            background: 'rgba(0, 0, 0, 0.85)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            padding: '16px',
            boxSizing: 'border-box',
          }}
        >
          <div
            style={{
              background: '#161b26',
              border: '1px solid #2a3346',
              borderRadius: '8px',
              padding: 'clamp(16px, 4vw, 24px)',
              width: '100%',
              maxWidth: '480px',
              maxHeight: '90dvh',
              overflowY: 'auto',
            }}
          >
            <h3 style={{ margin: '0 0 16px 0', fontFamily: "'IBM Plex Mono', monospace", fontSize: '16px' }}>
              REGISTRAR EQUIPO TÉCNICO
            </h3>

            <form onSubmit={handleAddEquipment} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <label style={{ fontSize: '11px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
                  NOMBRE DEL EQUIPO
                </label>
                <input
                  type="text"
                  value={eqName}
                  onChange={(e) => setEqName(e.target.value)}
                  placeholder="Ej: Interfaz Principal FOH"
                  required
                  style={{
                    width: '100%',
                    background: '#0d1017',
                    border: '1px solid #2a3346',
                    borderRadius: '4px',
                    padding: '8px 10px',
                    color: '#ffffff',
                    marginTop: '4px',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div>
                  <label style={{ fontSize: '11px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
                    CATEGORÍA
                  </label>
                  <select
                    value={eqCategory}
                    onChange={(e) => setEqCategory(e.target.value as EquipmentCategory)}
                    style={{
                      width: '100%',
                      background: '#0d1017',
                      border: '1px solid #2a3346',
                      borderRadius: '4px',
                      padding: '8px 10px',
                      color: '#ffffff',
                      marginTop: '4px',
                      boxSizing: 'border-box',
                    }}
                  >
                    <option value="interface">Interfaz / Consola ASIO</option>
                    <option value="in_ear">Transmisor / In-Ear RF</option>
                    <option value="cabling">Cable Físico Escenario</option>
                    <option value="mic">Microfonía & DI Box</option>
                    <option value="instrument">Instrumento / Módulo</option>
                  </select>
                </div>

                <div>
                  <label style={{ fontSize: '11px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
                    MARCA / MODELO
                  </label>
                  <input
                    type="text"
                    value={eqModel}
                    onChange={(e) => setEqModel(e.target.value)}
                    placeholder="Ej: Soundcraft Ui24R"
                    required
                    style={{
                      width: '100%',
                      background: '#0d1017',
                      border: '1px solid #2a3346',
                      borderRadius: '4px',
                      padding: '8px 10px',
                      color: '#ffffff',
                      marginTop: '4px',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>
              </div>

              <div>
                <label style={{ fontSize: '11px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
                  ASIGNADO A (MÚSICO / PUESTO)
                </label>
                <input
                  type="text"
                  value={eqAssignedTo}
                  onChange={(e) => setEqAssignedTo(e.target.value)}
                  placeholder="Ej: Mateo Gómez (Batería) / FOH Soundcraft"
                  style={{
                    width: '100%',
                    background: '#0d1017',
                    border: '1px solid #2a3346',
                    borderRadius: '4px',
                    padding: '8px 10px',
                    color: '#ffffff',
                    marginTop: '4px',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div>
                <label style={{ fontSize: '11px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
                  RUTEO DE CANALES / CONECTORES
                </label>
                <input
                  type="text"
                  value={eqRouting}
                  onChange={(e) => setEqRouting(e.target.value)}
                  placeholder="Ej: Salida 1-2 PA Main • Salida 3 Drummer Cable"
                  style={{
                    width: '100%',
                    background: '#0d1017',
                    border: '1px solid #2a3346',
                    borderRadius: '4px',
                    padding: '8px 10px',
                    color: '#ffffff',
                    marginTop: '4px',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div>
                <label style={{ fontSize: '11px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
                  FRECUENCIA RF (SI APLICA)
                </label>
                <input
                  type="text"
                  value={eqRf}
                  onChange={(e) => setEqRf(e.target.value)}
                  placeholder="Ej: 518.200 MHz (Grupo 1 Canal 4)"
                  style={{
                    width: '100%',
                    background: '#0d1017',
                    border: '1px solid #2a3346',
                    borderRadius: '4px',
                    padding: '8px 10px',
                    color: '#ffffff',
                    marginTop: '4px',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '10px' }}>
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  style={{
                    background: 'transparent',
                    border: '1px solid #2a3346',
                    color: '#94a3b8',
                    padding: '8px 16px',
                    borderRadius: '4px',
                    cursor: 'pointer',
                  }}
                >
                  CANCELAR
                </button>
                <button
                  type="submit"
                  style={{
                    background: '#f59e0b',
                    border: 'none',
                    color: '#000000',
                    padding: '8px 20px',
                    borderRadius: '4px',
                    fontWeight: 800,
                    cursor: 'pointer',
                  }}
                >
                  REGISTRAR EQUIPO
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
