import { useSyncExternalStore } from 'react'
import { getWaveformPreferences, subscribeWaveformPreferences } from '../../services/appearanceDom'
import { defaultWaveformPreferences, type WaveformPreferences } from '../../services/waveform'

const serverWaveform = defaultWaveformPreferences()

/**
 * Forma de onda vigente (uiPreferences.waveform, la aplica applyAppearance). Devuelve el mismo
 * objeto hasta que cambia: los lienzos la guardan en una ref y repintan solo entonces.
 */
export function useWaveformPreferences(): WaveformPreferences {
  return useSyncExternalStore(subscribeWaveformPreferences, getWaveformPreferences, () => serverWaveform)
}
