import { useState } from 'react'
import { DiffPreview, DiffItem, ExcelSongRow, ExcelSetlistRow, ExcelEquipoRow } from '../types/xlsx'

interface Props {
  diff: DiffPreview
  isOpen: boolean
  onConfirm: () => void
  onCancel: () => void
}

type TabType = 'canciones' | 'setlists' | 'equipo'

export default function DiffPreviewModal({ diff, isOpen, onConfirm, onCancel }: Props) {
  const [activeTab, setActiveTab] = useState<TabType>('canciones')

  if (!isOpen) return null

  const renderBadge = (type: string) => {
    switch (type) {
      case 'added':
        return (
          <span style={{ color: 'var(--accent-success)', border: '1px solid var(--accent-success)', padding: '2px 6px', borderRadius: '3px', fontSize: '10px', fontFamily: 'var(--font-mono)' }}>
            [NUEVO]
          </span>
        )
      case 'updated':
        return (
          <span style={{ color: 'var(--accent-warning)', border: '1px solid var(--accent-warning)', padding: '2px 6px', borderRadius: '3px', fontSize: '10px', fontFamily: 'var(--font-mono)' }}>
            [MODIFICADO]
          </span>
        )
      case 'deleted':
        return (
          <span style={{ color: 'var(--accent-danger)', border: '1px solid var(--accent-danger)', padding: '2px 6px', borderRadius: '3px', fontSize: '10px', fontFamily: 'var(--font-mono)' }}>
            [ELIMINADO]
          </span>
        )
      default:
        return (
          <span style={{ color: 'var(--text-disabled)', border: '1px solid var(--text-disabled)', padding: '2px 6px', borderRadius: '3px', fontSize: '10px', fontFamily: 'var(--font-mono)' }}>
            [SIN CAMBIOS]
          </span>
        )
    }
  }

  const renderItemDetails = (item: DiffItem<ExcelSongRow> | DiffItem<ExcelSetlistRow> | DiffItem<ExcelEquipoRow>) => {
    if (activeTab === 'canciones') {
      const song = item.details as unknown as ExcelSongRow
      return (
        <div>
          <div style={{ fontWeight: 'bold', fontSize: '13px' }}>{song.titulo || item.entity_id}</div>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
            {song.artista} • {song.bpm_original} BPM • {song.tono_original || 'S/T'}
          </div>
        </div>
      )
    } else if (activeTab === 'setlists') {
      const setlist = item.details as unknown as ExcelSetlistRow
      return (
        <div>
          <div style={{ fontWeight: 'bold', fontSize: '13px' }}>{setlist.nombre_show || item.entity_id}</div>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
            Orden #{setlist.orden} • Modo: {setlist.modo_transicion} • {setlist.tono_show}
          </div>
        </div>
      )
    } else {
      const member = item.details as unknown as ExcelEquipoRow
      return (
        <div>
          <div style={{ fontWeight: 'bold', fontSize: '13px' }}>{member.nombre || item.entity_id}</div>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
            Rol: {member.rol} • Tel: {member.telefono}
          </div>
        </div>
      )
    }
  }

  const items = activeTab === 'canciones'
    ? diff.canciones
    : activeTab === 'setlists'
      ? diff.setlists
      : diff.equipo

  return (
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
      }}
    >
      <div
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--theme-border)',
          borderRadius: '8px',
          width: '100%',
          maxWidth: '680px',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 20px 50px rgba(0, 0, 0, 0.9)',
        }}
      >
        {/* HEADER */}
        <div style={{ padding: '20px', borderBottom: '1px solid var(--theme-border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <h3 style={{ fontFamily: 'var(--font-mono)', fontSize: '15px', letterSpacing: '1px', margin: 0 }}>
              DIFF PREVIEW // LIBRO MAESTRO XLSX
            </h3>
            <span style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--accent-active)' }}>
              {diff.has_changes ? '[CAMBIOS DETECTADOS]' : '[SIN MODIFICACIONES]'}
            </span>
          </div>

          {/* SUMMARY BADGES */}
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '12px' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--accent-success)' }}>
              +{diff.summary.added} NUEVOS
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--accent-warning)' }}>
              ~{diff.summary.updated} MODIFICADOS
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--accent-danger)' }}>
              -{diff.summary.deleted} ELIMINADOS
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-disabled)' }}>
              ={diff.summary.unchanged} SIN CAMBIOS
            </span>
          </div>
        </div>

        {/* TAB SELECTOR */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--theme-border)', background: 'var(--bg-elevated)' }}>
          {(['canciones', 'setlists', 'equipo'] as TabType[]).map((tab) => {
            const isCurrent = activeTab === tab
            return (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  flex: 1,
                  background: isCurrent ? 'var(--bg-surface)' : 'transparent',
                  border: 'none',
                  borderBottom: isCurrent ? '2px solid var(--accent-focus)' : 'none',
                  color: isCurrent ? 'var(--text-primary)' : 'var(--text-secondary)',
                  padding: '12px',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '12px',
                  cursor: 'pointer',
                  textTransform: 'uppercase',
                }}
              >
                [{tab}]
              </button>
            )
          })}
        </div>

        {/* CONTENT LIST */}
        <div style={{ padding: '16px', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {items.length === 0 && (
            <div style={{ textAlign: 'center', padding: '32px', color: 'var(--text-secondary)', fontSize: '13px' }}>
              No hay elementos en la pestaña [{activeTab}]
            </div>
          )}

          {items.map((item) => (
            <div
              key={item.entity_id}
              style={{
                border: '1px solid var(--theme-border)',
                borderRadius: '4px',
                padding: '12px',
                background: 'var(--bg-surface)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '6px' }}>
                {renderItemDetails(item)}
                {renderBadge(item.change_type)}
              </div>

              {/* FIELD LEVEL DIFF DISPLAY */}
              {item.diff_fields && (
                <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px dashed var(--theme-border)', fontSize: '11px', fontFamily: 'var(--font-mono)' }}>
                  {Object.entries(item.diff_fields).map(([fieldName, change]) => (
                    <div key={fieldName} style={{ color: 'var(--text-secondary)', marginTop: '2px' }}>
                      <span style={{ color: 'var(--accent-active)' }}>{fieldName}:</span>{' '}
                      <span style={{ textDecoration: 'line-through', color: 'var(--accent-danger)' }}>
                        {String(change.before)}
                      </span>{' '}
                      -&gt;{' '}
                      <span style={{ color: 'var(--accent-success)' }}>
                        {String(change.after)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* FOOTER ACTIONS */}
        <div style={{ padding: '16px', borderTop: '1px solid var(--theme-border)', display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
          <button
            onClick={onCancel}
            style={{
              background: 'transparent',
              border: '1px solid var(--text-secondary)',
              color: 'var(--text-secondary)',
              padding: '10px 20px',
              borderRadius: '4px',
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
              cursor: 'pointer',
            }}
          >
            [CANCELAR]
          </button>
          <button
            onClick={onConfirm}
            style={{
              background: 'var(--accent-focus)',
              border: 'none',
              color: '#FFFFFF',
              padding: '10px 24px',
              borderRadius: '4px',
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
              fontWeight: 'bold',
              cursor: 'pointer',
            }}
          >
            [APLICAR CAMBIOS]
          </button>
        </div>
      </div>
    </div>
  )
}
