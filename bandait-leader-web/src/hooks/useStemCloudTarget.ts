import { useMemo } from 'react'
import { useHub } from '../context/hubContextCore'
import { cloudBandKey, type CloudTarget } from '../services/stemCloud'
import { stemCloudTarget } from '../services/stemCloudConfig'

/**
 * Destino de la nube de stems para la banda activa: null sin URL del Worker compilada o sin
 * sesion de nube. `bandKey` es el uuid de la banda compartida o 'me'; `canEdit` dice si el rol
 * puede escribir (Owner o Director en compartidas, siempre en el workspace personal).
 */
export function useStemCloudTarget(): { target: CloudTarget | null; bandKey: string; canEdit: boolean } {
  const { sharing, activeBand } = useHub()
  const bandKey = cloudBandKey(activeBand?.id, sharing.activeShared)
  const enabled = sharing.cloudSignedIn && !!activeBand
  const target = useMemo(() => (enabled ? stemCloudTarget(bandKey) : null), [enabled, bandKey])
  return { target, bandKey, canEdit: sharing.activeCanEdit }
}
