import React from 'react'
import { SongsHubView } from './SongsHubView'
import { StemsHubView } from './StemsHubView'
import { SegmentedControl } from '../components/SegmentedControl'
import type { SongsSegment } from '../components/shell/hubViews'

interface Props {
  segment: SongsSegment
  onSegmentChange: (segment: SongsSegment) => void
  /** Cancion a abrir en el editor de la LIBRERIA (pedido desde Ensayo). */
  openSongId?: string | null
}

const SEGMENTS: ReadonlyArray<{ id: SongsSegment; label: string }> = [
  { id: 'library', label: 'LIBRERÍA' },
  { id: 'stems', label: 'STEMS Y PISTAS' },
]

/**
 * Canciones y Stems (Web 3.0): la libreria de canciones y la antigua vista PISTAS bajo un mismo
 * techo, con un selector segmentado LIBRERIA | STEMS Y PISTAS. Cada segmento conserva su vista
 * tal cual (SongsHubView y StemsHubView).
 */
export const SongsStemsHubView: React.FC<Props> = ({ segment, onSegmentChange, openSongId = null }) => (
  <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
    <div className="hub-view-head">
      <h1 className="hub-view-title">Canciones y Stems</h1>
      <SegmentedControl
        ariaLabel="Canciones y Stems"
        value={segment}
        options={SEGMENTS}
        onChange={onSegmentChange}
        testIdPrefix="songs-segment"
        panelId="songs-stems-panel"
      />
    </div>
    <div id="songs-stems-panel" role="tabpanel" aria-label={segment === 'library' ? 'Librería' : 'Stems y pistas'} style={{ minWidth: 0 }}>
      {segment === 'library' ? <SongsHubView openSongId={openSongId} /> : <StemsHubView />}
    </div>
  </div>
)
