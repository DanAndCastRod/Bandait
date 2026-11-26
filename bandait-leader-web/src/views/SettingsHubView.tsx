import React, { useState } from 'react'
import { Mic, Palette, Radio, SlidersHorizontal } from 'lucide-react'
import { VoiceHubView } from './VoiceHubView'
import { EquipmentHubView } from './EquipmentHubView'
import { AppearanceSettings } from '../components/AppearanceSettings'
import { StudioSettings } from '../components/StudioSettings'
import { SegmentedControl } from '../components/SegmentedControl'
import { studioEnabled } from '../services/studio/flag'

export type SettingsSection = 'voice' | 'equipment' | 'studio' | 'appearance'

const ALL_SECTIONS: ReadonlyArray<{ id: SettingsSection; label: string; icon: React.ReactNode }> = [
  { id: 'voice', label: 'VOZ Y CONTEOS', icon: <Mic size={14} aria-hidden /> },
  { id: 'equipment', label: 'EQUIPAMIENTO', icon: <Radio size={14} aria-hidden /> },
  { id: 'studio', label: 'ESTUDIO', icon: <SlidersHorizontal size={14} aria-hidden /> },
  { id: 'appearance', label: 'APARIENCIA', icon: <Palette size={14} aria-hidden /> },
]

/**
 * AJUSTES: agrupa VOZ Y CONTEOS, EQUIPAMIENTO (como en el lider 2.3), ESTUDIO (solo con el
 * interruptor del Estudio) y APARIENCIA (Web 3.0).
 */
export const SettingsHubView: React.FC = () => {
  const [section, setSection] = useState<SettingsSection>('voice')
  const sections = studioEnabled() ? ALL_SECTIONS : ALL_SECTIONS.filter((s) => s.id !== 'studio')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div className="hub-view-head">
        <h1 className="hub-view-title">Ajustes</h1>
        <SegmentedControl
          ariaLabel="Secciones de ajustes"
          value={section}
          options={sections}
          onChange={setSection}
          testIdPrefix="settings-section"
          panelId="settings-panel"
        />
      </div>
      <div id="settings-panel" role="tabpanel" aria-label={sections.find((s) => s.id === section)?.label} style={{ minWidth: 0 }}>
        {section === 'voice' ? (
          <VoiceHubView />
        ) : section === 'equipment' ? (
          <EquipmentHubView />
        ) : section === 'studio' ? (
          <StudioSettings />
        ) : (
          <AppearanceSettings />
        )}
      </div>
    </div>
  )
}
