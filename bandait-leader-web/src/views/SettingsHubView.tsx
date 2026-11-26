import React, { useState } from 'react'
import { Mic, Palette, Radio } from 'lucide-react'
import { VoiceHubView } from './VoiceHubView'
import { EquipmentHubView } from './EquipmentHubView'
import { AppearanceSettings } from '../components/AppearanceSettings'
import { SegmentedControl } from '../components/SegmentedControl'

export type SettingsSection = 'voice' | 'equipment' | 'appearance'

const SECTIONS: ReadonlyArray<{ id: SettingsSection; label: string; icon: React.ReactNode }> = [
  { id: 'voice', label: 'VOZ Y CONTEOS', icon: <Mic size={14} aria-hidden /> },
  { id: 'equipment', label: 'EQUIPAMIENTO', icon: <Radio size={14} aria-hidden /> },
  { id: 'appearance', label: 'APARIENCIA', icon: <Palette size={14} aria-hidden /> },
]

/** AJUSTES: agrupa VOZ Y CONTEOS, EQUIPAMIENTO (como en el lider 2.3) y APARIENCIA (Web 3.0). */
export const SettingsHubView: React.FC = () => {
  const [section, setSection] = useState<SettingsSection>('voice')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div className="hub-view-head">
        <h1 className="hub-view-title">Ajustes</h1>
        <SegmentedControl
          ariaLabel="Secciones de ajustes"
          value={section}
          options={SECTIONS}
          onChange={setSection}
          testIdPrefix="settings-section"
          panelId="settings-panel"
        />
      </div>
      <div id="settings-panel" role="tabpanel" aria-label={SECTIONS.find((s) => s.id === section)?.label} style={{ minWidth: 0 }}>
        {section === 'voice' ? <VoiceHubView /> : section === 'equipment' ? <EquipmentHubView /> : <AppearanceSettings />}
      </div>
    </div>
  )
}
