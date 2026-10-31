import React, { useState } from 'react'
import { Mic, Radio, Settings } from 'lucide-react'
import { VoiceHubView } from './VoiceHubView'
import { EquipmentHubView } from './EquipmentHubView'
import { colors, mono } from '../components/hubStyles'

export type SettingsSection = 'voice' | 'equipment'

const SECTIONS: Array<{ id: SettingsSection; label: string; icon: React.ReactNode; accent: string }> = [
  { id: 'voice', label: 'VOZ Y CONTEOS', icon: <Mic size={14} />, accent: colors.cyan },
  { id: 'equipment', label: 'EQUIPAMIENTO', icon: <Radio size={14} />, accent: colors.warning },
]

/** AJUSTES: agrupa VOZ Y CONTEOS y EQUIPAMIENTO, como en el lider 2.3. */
export const SettingsHubView: React.FC = () => {
  const [section, setSection] = useState<SettingsSection>('voice')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div
        style={{
          padding: 'clamp(12px, 3vw, 24px) clamp(12px, 3vw, 24px) 0',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontFamily: mono, fontSize: '12px', fontWeight: 700, color: colors.muted }}>
          <Settings size={14} /> AJUSTES
        </span>
        <div role="tablist" aria-label="Secciones de ajustes" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {SECTIONS.map((s) => {
            const active = section === s.id
            return (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={active}
                className="stx-btn"
                onClick={() => setSection(s.id)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '7px 12px',
                  borderRadius: '4px',
                  border: `1px solid ${active ? s.accent : colors.border}`,
                  background: active ? colors.elevated : 'transparent',
                  color: active ? colors.text : colors.muted,
                  fontFamily: mono,
                  fontSize: '12px',
                  fontWeight: active ? 700 : 400,
                  cursor: 'pointer',
                }}
              >
                <span style={{ color: active ? s.accent : 'inherit', display: 'inline-flex' }}>{s.icon}</span>
                {s.label}
              </button>
            )
          })}
        </div>
      </div>
      {section === 'voice' ? <VoiceHubView /> : <EquipmentHubView />}
    </div>
  )
}
