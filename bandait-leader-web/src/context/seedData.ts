import type { Band, BandMember, EquipmentItem, Playlist, SongStems, UserProfile, WorkspaceStore } from '../types/hub'

// DATOS DE DEMOSTRACION (MODO DEMO). Nunca se suben a la nube.
const DEMO_BANDS: Band[] = [
  {
    id: 'band_01',
    name: 'Los Inquietos del Rock',
    genre: 'Rock Latino / Pop',
    ownerId: 'usr_director_01',
    currentUserRole: 'Owner',
    membersCount: 5,
    createdAt: '2025-11-01',
  },
  {
    id: 'band_02',
    name: 'Trío Acústico Pereira',
    genre: 'Acústico / Balada',
    ownerId: 'usr_director_01',
    currentUserRole: 'Owner',
    membersCount: 3,
    createdAt: '2026-01-20',
  },
  {
    id: 'band_03',
    name: 'Sinfónica Pop Bogotá',
    genre: 'Orquesta Pop Fusión',
    ownerId: 'usr_foh_02',
    currentUserRole: 'Musician',
    membersCount: 14,
    createdAt: '2026-02-15',
  },
]

const DEMO_MEMBERS: Record<string, BandMember[]> = {
  band_01: [
    {
      id: 'mem_01',
      bandId: 'band_01',
      userId: 'usr_director_01',
      name: 'Carlos Mendoza',
      email: 'carlos.director@bandait.live',
      phone: '+57 310 555 0101',
      role: 'Owner',
      instrument: 'Director / Teclados',
      joinedAt: '2025-11-01',
    },
    {
      id: 'mem_02',
      bandId: 'band_01',
      userId: 'usr_drummer_03',
      name: 'Mateo Gómez',
      email: 'mateo.drums@bandait.live',
      phone: '+57 311 555 0202',
      role: 'Musician',
      instrument: 'Batería Principal',
      joinedAt: '2025-11-05',
    },
    {
      id: 'mem_03',
      bandId: 'band_01',
      userId: 'usr_foh_02',
      name: 'Alejandro Vélez',
      email: 'alejandro.foh@soundcraft.live',
      phone: '+57 315 555 0303',
      role: 'SoundEngineer',
      instrument: 'Ingeniero FOH & Monitores',
      joinedAt: '2025-11-10',
    },
    {
      id: 'mem_04',
      bandId: 'band_01',
      userId: 'usr_bass_04',
      name: 'Felipe Restrepo',
      email: 'felipe.bass@bandait.live',
      phone: '+57 300 555 0404',
      role: 'Musician',
      instrument: 'Bajo Eléctrico',
      joinedAt: '2025-11-12',
    },
    {
      id: 'mem_05',
      bandId: 'band_01',
      userId: 'usr_vox_05',
      name: 'Laura Valencia',
      email: 'laura.lead@bandait.live',
      phone: '+57 320 555 0505',
      role: 'MusicDirector',
      instrument: 'Voz Líder',
      joinedAt: '2025-11-15',
    },
  ],
}

const DEMO_PLAYLISTS: Record<string, Playlist[]> = {
  band_01: [
    {
      id: 'pl_01',
      bandId: 'band_01',
      name: 'Gira Nacional 2026 — Setlist Principal',
      description: 'Repertorio oficial para salas y festivales. Orden inmutable salvo indicación expresa del Director.',
      createdAt: '2026-02-01',
      updatedAt: '2026-03-02',
      songs: [
        {
          id: 'song_01',
          orderIndex: 1,
          title: 'Medianoche en Pereira',
          artist: 'Los Inquietos del Rock',
          bpm: 124,
          key: 'Am',
          showKey: 'Am',
          camelot: '8A',
          durationSec: 215,
          transitionMode: 'manual_cue',
          countInBars: 2,
          notes: 'Inicio con intro de sintetizador y claqueta en compás 3. Alerta de solo de guitarra en c4.',
        },
        {
          id: 'song_02',
          orderIndex: 2,
          title: 'Ruta del Café',
          artist: 'Los Inquietos del Rock',
          bpm: 130,
          key: 'Dm',
          showKey: 'Dm',
          camelot: '7A',
          durationSec: 198,
          transitionMode: 'auto_count_in',
          countInBars: 1,
          notes: 'Auto conteo de 4 pulsos. Batería entra directo en el compás 1.',
        },
        {
          id: 'song_03',
          orderIndex: 3,
          title: 'Desde Lejos (Balada)',
          artist: 'Los Inquietos del Rock',
          bpm: 88,
          key: 'G',
          showKey: 'F#',
          camelot: '11B',
          durationSec: 280,
          transitionMode: 'manual_cue',
          countInBars: 2,
          notes: 'Tono bajado medio tono (F#) para comodidad vocal. Silencio de batería al final.',
        },
        {
          id: 'song_04',
          orderIndex: 4,
          title: 'Fuego en Tarima',
          artist: 'Los Inquietos del Rock',
          bpm: 140,
          key: 'Em',
          showKey: 'Em',
          camelot: '9A',
          durationSec: 230,
          transitionMode: 'gapless',
          countInBars: 1,
          notes: 'Final con solo de bajo y batería extendido.',
        },
      ],
    },
  ],
}

const DEMO_STEMS: Record<string, SongStems> = {
  song_01: {
    songId: 'song_01',
    songTitle: 'Medianoche en Pereira',
    bpm: 124,
    tracks: [
      { channel: 1, id: 'stem_drm_01', name: 'Batería Stems', code: '[DRM]', filename: 'medianoche_drums_48k.wav', fileSizeMb: 42.1, volumeDb: 0.0, pan: 0, limiterSafe: true, demucsStatus: 'ready' },
      { channel: 2, id: 'stem_bas_01', name: 'Bajo Eléctrico', code: '[BAS]', filename: 'medianoche_bass_48k.wav', fileSizeMb: 38.4, volumeDb: -1.5, pan: 0, limiterSafe: true, demucsStatus: 'ready' },
      { channel: 3, id: 'stem_vox_01', name: 'Voces de Apoyo', code: '[VOX]', filename: 'medianoche_backing_vox.wav', fileSizeMb: 35.0, volumeDb: -2.0, pan: 0, limiterSafe: true, demucsStatus: 'ready' },
      { channel: 4, id: 'stem_oth_01', name: 'Armonía / Teclados', code: '[OTH]', filename: 'medianoche_synths.wav', fileSizeMb: 40.2, volumeDb: -0.5, pan: 0.1, limiterSafe: true, demucsStatus: 'ready' },
      { channel: 5, id: 'stem_clk_01', name: 'Clic Metrónomo FOH', code: '[CLK]', filename: 'click_124bpm_4_4.wav', fileSizeMb: 12.0, volumeDb: +1.0, pan: -1.0, limiterSafe: true, demucsStatus: 'ready' },
      { channel: 6, id: 'stem_voz_01', name: 'Guía de Voz de Tarima', code: '[VOZ]', filename: 'medianoche_stage_cues.wav', fileSizeMb: 14.5, volumeDb: 0.0, pan: 1.0, limiterSafe: true, demucsStatus: 'ready' },
    ],
  },
}

const DEMO_EQUIPMENT: Record<string, EquipmentItem[]> = {
  band_01: [
    {
      id: 'eq_01',
      bandId: 'band_01',
      category: 'interface',
      name: 'Interfaz ASIO FOH Master',
      model: 'Focusrite Scarlett 18i20 3rd Gen (USB)',
      assignedTo: 'Alejandro Vélez (FOH)',
      channelRouting: 'Salidas 1-2 PA Principal (XLR) / Salida 3 In-Ear Baterista',
      notes: 'Driver ASIO a 48kHz / 64 samples (latencia 1.4ms).',
    },
    {
      id: 'eq_02',
      bandId: 'band_01',
      category: 'in_ear',
      name: 'Transmisor In-Ear Shure PSM300',
      model: 'P3T / P3RA Bodypack Receptor',
      assignedTo: 'Carlos Mendoza (Director)',
      channelRouting: 'Aux 1 (Mezcla Director)',
      rfFrequency: '518.200 MHz (Grupo 1 / Canal 1)',
      notes: 'Frecuencia coordinada. Sin interferencia en tarima.',
    },
    {
      id: 'eq_03',
      bandId: 'band_01',
      category: 'in_ear',
      name: 'Transmisor In-Ear Sennheiser G4',
      model: 'SR IEM G4 / EK G4',
      assignedTo: 'Felipe Restrepo (Bajo)',
      channelRouting: 'Aux 2 (Mono Mix)',
      rfFrequency: '542.400 MHz (Grupo 2 / Canal 1)',
      notes: 'Limiter interno activado.',
    },
    {
      id: 'eq_04',
      bandId: 'band_01',
      category: 'cabling',
      name: 'Cable Físico Clic Baterista',
      model: 'Cable Blindado Neutrik Jack TRS 1/4" a XLR (10 metros)',
      assignedTo: 'Mateo Gómez (Batería)',
      channelRouting: 'Salida Física Ch 3 de la Interfaz FOH',
      notes: 'Conexión cableada directa obligatoria (latencia < 1.5ms garantizada).',
    },
  ],
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function createDemoWorkspace(): WorkspaceStore {
  return clone({
    bands: DEMO_BANDS,
    activeBandId: 'band_01',
    membersMap: DEMO_MEMBERS,
    playlistsMap: DEMO_PLAYLISTS,
    equipmentMap: DEMO_EQUIPMENT,
    stemsMap: DEMO_STEMS,
  })
}

/** Workspace limpio para un usuario real (perfil local o cuenta de nube nueva). */
export function createPersonalWorkspace(user: UserProfile): WorkspaceStore {
  const today = new Date().toISOString().slice(0, 10)
  const cleanId = user.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10)
  const primaryBandId = `band_${cleanId}_01`
  const firstName = user.name.split(' ')[0] || 'Musico'
  const bandName = `Banda de ${firstName}`

  return {
    bands: [
      {
        id: primaryBandId,
        name: bandName,
        genre: 'Live Show / En Vivo',
        ownerId: user.id,
        currentUserRole: 'Owner',
        membersCount: 1,
        createdAt: today,
      },
    ],
    activeBandId: primaryBandId,
    membersMap: {
      [primaryBandId]: [
        {
          id: `mem_${cleanId}_owner`,
          bandId: primaryBandId,
          userId: user.id,
          name: user.name,
          email: user.email,
          role: 'Owner',
          instrument: 'Director Musical',
          joinedAt: today,
        },
      ],
    },
    playlistsMap: {
      [primaryBandId]: [
        {
          id: `pl_${cleanId}_01`,
          bandId: primaryBandId,
          name: 'Setlist Principal — Gira 2026',
          description: `Repertorio oficial configurado en el Web Hub para ${bandName}`,
          createdAt: today,
          updatedAt: today,
          songs: [
            {
              id: `song_${cleanId}_01`,
              orderIndex: 1,
              title: 'Tema 1 (Apertura Show)',
              artist: bandName,
              bpm: 120,
              key: 'Am',
              showKey: 'Am',
              camelot: '8A',
              durationSec: 210,
              transitionMode: 'manual_cue',
              countInBars: 2,
              notes: 'Inicio de show. Conteo de 8 pulsos por claqueta.',
            },
          ],
        },
      ],
    },
    equipmentMap: {
      [primaryBandId]: [
        {
          id: `eq_${cleanId}_01`,
          bandId: primaryBandId,
          category: 'interface',
          name: 'Interfaz ASIO Multicanal FOH',
          model: 'Interfaz USB ASIO 8x8 (64 samples)',
          assignedTo: `${user.name} (FOH)`,
          channelRouting: 'Ch 1-2 PA Master (XLR) / Ch 3 In-Ear Baterista',
          notes: 'Driver ASIO a 48kHz. Conexión directa por cable Neutrik a baterista.',
        },
        {
          id: `eq_${cleanId}_02`,
          bandId: primaryBandId,
          category: 'cabling',
          name: 'Cable Físico Baterista (Salida 3)',
          model: 'Neutrik Jack TRS 1/4" a XLR Balanceado (10m)',
          assignedTo: 'Batería',
          channelRouting: 'Salida 3 de interfaz a audífonos baterista',
          notes: 'Conexión cableada obligatoria: latencia cero y cero desconexión.',
        },
      ],
    },
    stemsMap: clone(DEMO_STEMS),
  }
}
