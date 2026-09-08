import React, { createContext, useContext, useState, useEffect } from 'react'
import type {
  UserProfile,
  Band,
  BandMember,
  Playlist,
  SongStems,
  EquipmentItem,
  MemberRole,
  PlaylistSong,
} from '../types/hub'
import { authService } from '../services/authService'

// INITIAL MOCK DATA PER BAND
const INITIAL_BANDS: Band[] = [
  {
    id: 'band_01',
    name: 'Los Inquietos del Rock',
    genre: 'Rock Latino / Pop',
    ownerId: 'usr_director_01',
    currentUserRole: 'MusicDirector',
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

const INITIAL_MEMBERS: Record<string, BandMember[]> = {
  band_01: [
    {
      id: 'mem_01',
      bandId: 'band_01',
      userId: 'usr_director_01',
      name: 'Carlos Mendoza',
      email: 'carlos.director@bandait.live',
      phone: '+57 310 555 0101',
      role: 'MusicDirector',
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
      role: 'Musician',
      instrument: 'Voz Líder',
      joinedAt: '2025-11-15',
    },
  ],
  band_02: [
    {
      id: 'mem_10',
      bandId: 'band_02',
      userId: 'usr_director_01',
      name: 'Carlos Mendoza',
      email: 'carlos.director@bandait.live',
      phone: '+57 310 555 0101',
      role: 'Owner',
      instrument: 'Piano & Acústica',
      joinedAt: '2026-01-20',
    },
  ],
}

const INITIAL_PLAYLISTS: Record<string, Playlist[]> = {
  band_01: [
    {
      id: 'pl_01',
      bandId: 'band_01',
      name: 'Gira 2026 — Show Central',
      description: 'Setlist principal de 90 minutos con transiciones calibradas.',
      createdAt: '2026-02-01',
      updatedAt: '2026-09-05',
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
          durationSec: 245,
          transitionMode: 'manual_cue',
          countInBars: 2,
          notes: 'Inicio con intro de sintetizador. Charla de bienvenida antes del coro 2.',
        },
        {
          id: 'song_02',
          orderIndex: 2,
          title: 'Ritmo de Calle',
          artist: 'Los Inquietos del Rock',
          bpm: 128,
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
          showKey: 'F#', // Transportado para cantante
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

const INITIAL_STEMS: Record<string, SongStems> = {
  song_01: {
    songId: 'song_01',
    songTitle: 'Medianoche en Pereira',
    bpm: 124,
    tracks: [
      {
        channel: 1,
        id: 'stem_drm_01',
        name: 'Batería Stems',
        code: '[DRM]',
        filename: 'medianoche_drums_48k.wav',
        fileSizeMb: 42.1,
        volumeDb: 0.0,
        pan: 0,
        limiterSafe: true,
        demucsStatus: 'ready',
      },
      {
        channel: 2,
        id: 'stem_bas_01',
        name: 'Bajo Eléctrico',
        code: '[BAS]',
        filename: 'medianoche_bass_48k.wav',
        fileSizeMb: 38.4,
        volumeDb: -1.5,
        pan: 0,
        limiterSafe: true,
        demucsStatus: 'ready',
      },
      {
        channel: 3,
        id: 'stem_vox_01',
        name: 'Voces de Apoyo',
        code: '[VOX]',
        filename: 'medianoche_backing_vox.wav',
        fileSizeMb: 35.0,
        volumeDb: -2.0,
        pan: 0,
        limiterSafe: true,
        demucsStatus: 'ready',
      },
      {
        channel: 4,
        id: 'stem_oth_01',
        name: 'Armonía / Teclados',
        code: '[OTH]',
        filename: 'medianoche_synths.wav',
        fileSizeMb: 40.2,
        volumeDb: -0.5,
        pan: 0.1,
        limiterSafe: true,
        demucsStatus: 'ready',
      },
      {
        channel: 5,
        id: 'stem_clk_01',
        name: 'Clic Metrónomo FOH',
        code: '[CLK]',
        filename: 'click_124bpm_4_4.wav',
        fileSizeMb: 12.0,
        volumeDb: +1.0,
        pan: 0,
        limiterSafe: true,
        demucsStatus: 'ready',
      },
      {
        channel: 6,
        id: 'stem_voz_01',
        name: 'Guía Vocal & Cues',
        code: '[VOZ]',
        filename: 'cues_structure_124.wav',
        fileSizeMb: 15.6,
        volumeDb: +2.0,
        pan: 0,
        limiterSafe: true,
        demucsStatus: 'ready',
      },
    ],
  },
}

const INITIAL_EQUIPMENT: Record<string, EquipmentItem[]> = {
  band_01: [
    {
      id: 'eq_01',
      bandId: 'band_01',
      category: 'interface',
      name: 'Consola Digital FOH',
      model: 'Soundcraft Ui24R (24ch USB/Ethernet)',
      assignedTo: 'Alejandro Vélez (FOH)',
      channelRouting: 'Salidas 1-2 PA Main • Salida 3 Drummer Click • Aux 1-4 In-Ear',
      notes: 'Controlada vía Wi-Fi 5 GHz dedicado para evitar interferencias.',
    },
    {
      id: 'eq_02',
      bandId: 'band_01',
      category: 'in_ear',
      name: 'Sistema In-Ear Cantante',
      model: 'Sennheiser EW IEM G4',
      assignedTo: 'Laura Valencia (Voz Líder)',
      channelRouting: 'Aux 1 (Estéreo)',
      rfFrequency: '518.200 MHz (Grupo 1 / Canal 4)',
      notes: 'Receptor estéreo con auriculares Shure SE535.',
    },
    {
      id: 'eq_03',
      bandId: 'band_01',
      category: 'in_ear',
      name: 'Sistema In-Ear Bajista',
      model: 'Shure PSM 300 Pro',
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

interface HubContextType {
  user: UserProfile | null
  bands: Band[]
  activeBand: Band | null
  members: BandMember[]
  playlists: Playlist[]
  activePlaylist: Playlist | null
  songStems: SongStems | null
  equipment: EquipmentItem[]
  loginWithGoogle: (profile?: UserProfile) => void
  logout: () => void
  switchBand: (bandId: string) => void
  createBand: (name: string, genre: string) => void
  updateMemberRole: (memberId: string, newRole: MemberRole) => void
  inviteMember: (name: string, email: string, role: MemberRole, instrument: string) => void
  createPlaylist: (name: string, description: string) => void
  setActivePlaylist: (playlist: Playlist) => void
  updatePlaylistSong: (songId: string, updates: Partial<PlaylistSong>) => void
  reorderSongs: (fromIndex: number, toIndex: number) => void
  addSongToPlaylist: (song: Omit<PlaylistSong, 'id' | 'orderIndex'>) => void
  removeSongFromPlaylist: (songId: string) => void
  updateStemTrackVolume: (channel: number, volumeDb: number) => void
  addEquipment: (item: Omit<EquipmentItem, 'id' | 'bandId'>) => void
  removeEquipment: (id: string) => void
  exportMasterXlsxJson: () => void
}

const HubContext = createContext<HubContextType | undefined>(undefined)

export const HubProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<UserProfile | null>(() => authService.getCurrentUser())
  const [bands, setBands] = useState<Band[]>(INITIAL_BANDS)
  const [activeBandId, setActiveBandId] = useState<string>(() => {
    return localStorage.getItem('bandait_active_band') || 'band_01'
  })

  const [membersMap, setMembersMap] = useState(INITIAL_MEMBERS)
  const [playlistsMap, setPlaylistsMap] = useState(INITIAL_PLAYLISTS)
  const [equipmentMap, setEquipmentMap] = useState(INITIAL_EQUIPMENT)
  const [activePlaylistId, setActivePlaylistId] = useState<string>('pl_01')

  const activeBand = bands.find((b) => b.id === activeBandId) || bands[0] || null
  const members = activeBand ? membersMap[activeBand.id] || [] : []
  const playlists = activeBand ? playlistsMap[activeBand.id] || [] : []
  const activePlaylist = playlists.find((p) => p.id === activePlaylistId) || playlists[0] || null
  const equipment = activeBand ? equipmentMap[activeBand.id] || [] : []
  const songStems = INITIAL_STEMS['song_01'] || null

  useEffect(() => {
    if (activeBand) {
      localStorage.setItem('bandait_active_band', activeBand.id)
    }
  }, [activeBand])

  const loginWithGoogle = (profile?: UserProfile) => {
    const loggedUser = authService.loginWithGoogle(profile)
    setUser(loggedUser)
  }

  const logout = () => {
    authService.logout()
    setUser(null)
  }

  const switchBand = (bandId: string) => {
    setActiveBandId(bandId)
    const bandPlaylists = playlistsMap[bandId] || []
    if (bandPlaylists.length > 0) {
      setActivePlaylistId(bandPlaylists[0].id)
    }
  }

  const createBand = (name: string, genre: string) => {
    const newBandId = `band_${Date.now()}`
    const newBand: Band = {
      id: newBandId,
      name,
      genre,
      ownerId: user?.id || 'usr_director_01',
      currentUserRole: 'Owner',
      membersCount: 1,
      createdAt: new Date().toISOString().slice(0, 10),
    }

    setBands((prev) => [...prev, newBand])
    setActiveBandId(newBandId)

    if (user) {
      const ownerMember: BandMember = {
        id: `mem_${Date.now()}`,
        bandId: newBandId,
        userId: user.id,
        name: user.name,
        email: user.email,
        role: 'Owner',
        instrument: 'Director General',
        joinedAt: new Date().toISOString().slice(0, 10),
      }
      setMembersMap((prev) => ({ ...prev, [newBandId]: [ownerMember] }))
    }
  }

  const updateMemberRole = (memberId: string, newRole: MemberRole) => {
    if (!activeBand) return
    setMembersMap((prev) => ({
      ...prev,
      [activeBand.id]: (prev[activeBand.id] || []).map((m) =>
        m.id === memberId ? { ...m, role: newRole } : m
      ),
    }))
  }

  const inviteMember = (name: string, email: string, role: MemberRole, instrument: string) => {
    if (!activeBand) return
    const newMember: BandMember = {
      id: `mem_${Date.now()}`,
      bandId: activeBand.id,
      userId: `usr_invited_${Date.now()}`,
      name,
      email,
      role,
      instrument,
      joinedAt: new Date().toISOString().slice(0, 10),
    }
    setMembersMap((prev) => ({
      ...prev,
      [activeBand.id]: [...(prev[activeBand.id] || []), newMember],
    }))
  }

  const createPlaylist = (name: string, description: string) => {
    if (!activeBand) return
    const newPl: Playlist = {
      id: `pl_${Date.now()}`,
      bandId: activeBand.id,
      name,
      description,
      songs: [],
      createdAt: new Date().toISOString().slice(0, 10),
      updatedAt: new Date().toISOString().slice(0, 10),
    }
    setPlaylistsMap((prev) => ({
      ...prev,
      [activeBand.id]: [...(prev[activeBand.id] || []), newPl],
    }))
    setActivePlaylistId(newPl.id)
  }

  const updatePlaylistSong = (songId: string, updates: Partial<PlaylistSong>) => {
    if (!activeBand || !activePlaylist) return
    setPlaylistsMap((prev) => ({
      ...prev,
      [activeBand.id]: (prev[activeBand.id] || []).map((pl) => {
        if (pl.id !== activePlaylist.id) return pl
        return {
          ...pl,
          updatedAt: new Date().toISOString().slice(0, 10),
          songs: pl.songs.map((s) => (s.id === songId ? { ...s, ...updates } : s)),
        }
      }),
    }))
  }

  const reorderSongs = (fromIndex: number, toIndex: number) => {
    if (!activeBand || !activePlaylist) return
    const currentSongs = [...activePlaylist.songs]
    const [moved] = currentSongs.splice(fromIndex, 1)
    currentSongs.splice(toIndex, 0, moved)
    // Reindex order
    const reindexed = currentSongs.map((s, idx) => ({ ...s, orderIndex: idx + 1 }))

    setPlaylistsMap((prev) => ({
      ...prev,
      [activeBand.id]: (prev[activeBand.id] || []).map((pl) => {
        if (pl.id !== activePlaylist.id) return pl
        return {
          ...pl,
          updatedAt: new Date().toISOString().slice(0, 10),
          songs: reindexed,
        }
      }),
    }))
  }

  const addSongToPlaylist = (songData: Omit<PlaylistSong, 'id' | 'orderIndex'>) => {
    if (!activeBand || !activePlaylist) return
    const newSong: PlaylistSong = {
      ...songData,
      id: `song_${Date.now()}`,
      orderIndex: activePlaylist.songs.length + 1,
    }
    setPlaylistsMap((prev) => ({
      ...prev,
      [activeBand.id]: (prev[activeBand.id] || []).map((pl) => {
        if (pl.id !== activePlaylist.id) return pl
        return {
          ...pl,
          updatedAt: new Date().toISOString().slice(0, 10),
          songs: [...pl.songs, newSong],
        }
      }),
    }))
  }

  const removeSongFromPlaylist = (songId: string) => {
    if (!activeBand || !activePlaylist) return
    const filtered = activePlaylist.songs
      .filter((s) => s.id !== songId)
      .map((s, idx) => ({ ...s, orderIndex: idx + 1 }))

    setPlaylistsMap((prev) => ({
      ...prev,
      [activeBand.id]: (prev[activeBand.id] || []).map((pl) => {
        if (pl.id !== activePlaylist.id) return pl
        return {
          ...pl,
          updatedAt: new Date().toISOString().slice(0, 10),
          songs: filtered,
        }
      }),
    }))
  }

  const updateStemTrackVolume = (channel: number, volumeDb: number) => {
    if (!songStems) return
    songStems.tracks = songStems.tracks.map((t) =>
      t.channel === channel ? { ...t, volumeDb } : t
    )
  }

  const addEquipment = (itemData: Omit<EquipmentItem, 'id' | 'bandId'>) => {
    if (!activeBand) return
    const newItem: EquipmentItem = {
      ...itemData,
      id: `eq_${Date.now()}`,
      bandId: activeBand.id,
    }
    setEquipmentMap((prev) => ({
      ...prev,
      [activeBand.id]: [...(prev[activeBand.id] || []), newItem],
    }))
  }

  const removeEquipment = (id: string) => {
    if (!activeBand) return
    setEquipmentMap((prev) => ({
      ...prev,
      [activeBand.id]: (prev[activeBand.id] || []).filter((eq) => eq.id !== id),
    }))
  }

  const exportMasterXlsxJson = () => {
    if (!activeBand) return
    const masterExport = {
      bandait_version: '3.0.0-PRO',
      exported_at: new Date().toISOString(),
      agrupacion: activeBand,
      miembros: members,
      setlists: playlists,
      stems_catalogo: songStems,
      equipamiento: equipment,
    }

    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(masterExport, null, 2))
    const dl = document.createElement('a')
    dl.setAttribute('href', dataStr)
    dl.setAttribute('download', `bandait_${activeBand.name.toLowerCase().replace(/\s+/g, '_')}_master.json`)
    document.body.appendChild(dl)
    dl.click()
    dl.remove()
  }

  return (
    <HubContext.Provider
      value={{
        user,
        bands,
        activeBand,
        members,
        playlists,
        activePlaylist,
        songStems,
        equipment,
        loginWithGoogle,
        logout,
        switchBand,
        createBand,
        updateMemberRole,
        inviteMember,
        createPlaylist,
        setActivePlaylist: (pl) => setActivePlaylistId(pl.id),
        updatePlaylistSong,
        reorderSongs,
        addSongToPlaylist,
        removeSongFromPlaylist,
        updateStemTrackVolume,
        addEquipment,
        removeEquipment,
        exportMasterXlsxJson,
      }}
    >
      {children}
    </HubContext.Provider>
  )
}

export const useHub = () => {
  const context = useContext(HubContext)
  if (!context) {
    throw new Error('useHub must be used within a HubProvider')
  }
  return context
}
