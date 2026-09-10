import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
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
import { authService, DEMO_PROFILES } from '../services/authService'
import {
  syncWorkspaceToCloud,
  fetchWorkspaceFromCloud,
  subscribeToWorkspaceChanges,
} from '../services/supabaseClient'

// INITIAL SEED DATA FOR DEMO SCENARIOS
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
}

const INITIAL_PLAYLISTS: Record<string, Playlist[]> = {
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
        pan: -1.0,
        limiterSafe: true,
        demucsStatus: 'ready',
      },
      {
        channel: 6,
        id: 'stem_voz_01',
        name: 'Guía de Voz de Tarima',
        code: '[VOZ]',
        filename: 'medianoche_stage_cues.wav',
        fileSizeMb: 14.5,
        volumeDb: 0.0,
        pan: 1.0,
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

interface WorkspaceStore {
  bands: Band[]
  activeBandId: string
  membersMap: Record<string, BandMember[]>
  playlistsMap: Record<string, Playlist[]>
  equipmentMap: Record<string, EquipmentItem[]>
  stemsMap: Record<string, SongStems>
}

function loadUserWorkspace(currentUser: UserProfile | null): WorkspaceStore {
  if (!currentUser) {
    return {
      bands: INITIAL_BANDS,
      activeBandId: 'band_01',
      membersMap: INITIAL_MEMBERS,
      playlistsMap: INITIAL_PLAYLISTS,
      equipmentMap: INITIAL_EQUIPMENT,
      stemsMap: INITIAL_STEMS,
    }
  }

  const storageKey = `bandait_workspace_${currentUser.id}`
  const saved = localStorage.getItem(storageKey)
  if (saved) {
    try {
      const parsed = JSON.parse(saved)
      if (parsed.bands && parsed.bands.length > 0) {
        return parsed
      }
    } catch (err) {
      console.error('Error parsing stored workspace:', err)
    }
  }

  // If user is a demo profile, use default demo data
  const isDemo = DEMO_PROFILES.some((p) => p.id === currentUser.id)
  if (isDemo) {
    return {
      bands: INITIAL_BANDS,
      activeBandId: 'band_01',
      membersMap: INITIAL_MEMBERS,
      playlistsMap: INITIAL_PLAYLISTS,
      equipmentMap: INITIAL_EQUIPMENT,
      stemsMap: INITIAL_STEMS,
    }
  }

  // Real user: create clean personal workspace
  const cleanId = currentUser.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10)
  const primaryBandId = `band_${cleanId}_01`
  const firstName = currentUser.name.split(' ')[0]

  const initialBand: Band = {
    id: primaryBandId,
    name: `Banda de ${firstName}`,
    genre: 'Live Show / En Vivo',
    ownerId: currentUser.id,
    currentUserRole: 'Owner',
    membersCount: 1,
    createdAt: new Date().toISOString().slice(0, 10),
  }

  const initialMember: BandMember = {
    id: `mem_${cleanId}_owner`,
    bandId: primaryBandId,
    userId: currentUser.id,
    name: currentUser.name,
    email: currentUser.email,
    role: 'Owner',
    instrument: 'Director Musical',
    joinedAt: new Date().toISOString().slice(0, 10),
  }

  const initialPlaylist: Playlist = {
    id: `pl_${cleanId}_01`,
    bandId: primaryBandId,
    name: 'Setlist Principal — Gira 2026',
    description: `Repertorio oficial configurado en el Web Hub para ${initialBand.name}`,
    createdAt: new Date().toISOString().slice(0, 10),
    updatedAt: new Date().toISOString().slice(0, 10),
    songs: [
      {
        id: `song_${cleanId}_01`,
        orderIndex: 1,
        title: 'Tema 1 (Apertura Show)',
        artist: initialBand.name,
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
  }

  const initialEquipment: EquipmentItem[] = [
    {
      id: `eq_${cleanId}_01`,
      bandId: primaryBandId,
      category: 'interface',
      name: 'Interfaz ASIO Multicanal FOH',
      model: 'Interfaz USB ASIO 8x8 (64 samples)',
      assignedTo: `${currentUser.name} (FOH)`,
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
  ]

  const newWorkspace: WorkspaceStore = {
    bands: [initialBand],
    activeBandId: primaryBandId,
    membersMap: { [primaryBandId]: [initialMember] },
    playlistsMap: { [primaryBandId]: [initialPlaylist] },
    equipmentMap: { [primaryBandId]: initialEquipment },
    stemsMap: INITIAL_STEMS,
  }

  localStorage.setItem(storageKey, JSON.stringify(newWorkspace))
  return newWorkspace
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
  googleClientId: string
  setGoogleClientId: (clientId: string) => void
  loginWithGoogleCredential: (credentialJwt: string) => void
  loginWithPersonalAccount: (name: string, email: string) => void
  loginWithDemoProfile: (profile: UserProfile) => void
  loginWithGoogle: (profile?: UserProfile) => void
  resetWorkspaceToDemo: () => void
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
  const [googleClientId, setGoogleClientIdState] = useState<string>(() => authService.getGoogleClientId())

  // Load initial workspace according to user
  const [workspace, setWorkspace] = useState<WorkspaceStore>(() => loadUserWorkspace(user))

  const activeBand = workspace.bands.find((b) => b.id === workspace.activeBandId) || workspace.bands[0] || null
  const members = activeBand ? workspace.membersMap[activeBand.id] || [] : []
  const playlists = activeBand ? workspace.playlistsMap[activeBand.id] || [] : []
  const [activePlaylistId, setActivePlaylistId] = useState<string>(() => playlists[0]?.id || '')
  const activePlaylist = playlists.find((p) => p.id === activePlaylistId) || playlists[0] || null
  const equipment = activeBand ? workspace.equipmentMap[activeBand.id] || [] : []
  const songStems = activePlaylist?.songs[0] ? workspace.stemsMap[activePlaylist.songs[0].id] || workspace.stemsMap['song_01'] : workspace.stemsMap['song_01']

  // Auto-persist workspace changes per user (Local-First + Background Cloud Sync)
  useEffect(() => {
    if (user) {
      const storageKey = `bandait_workspace_${user.id}`
      localStorage.setItem(storageKey, JSON.stringify(workspace))
      // Background Supabase Cloud Sync (fails silently if unconfigured or offline)
      syncWorkspaceToCloud(user.id, workspace).catch(() => {})
    }
  }, [user, workspace])

  // Real-time Cloud Sync & initial pull from Supabase
  useEffect(() => {
    if (!user) return
    let isMounted = true

    // Fetch cloud workspace on sign-in
    fetchWorkspaceFromCloud(user.id).then((cloudWs) => {
      if (isMounted && cloudWs && cloudWs.bands && cloudWs.bands.length > 0) {
        setWorkspace(cloudWs)
      }
    })

    // Subscribe to multi-device real-time updates
    const unsubscribe = subscribeToWorkspaceChanges(user.id, (remoteWs) => {
      if (isMounted && remoteWs) {
        setWorkspace(remoteWs)
      }
    })

    return () => {
      isMounted = false
      if (unsubscribe) unsubscribe()
    }
  }, [user])

  // Sync workspace on user change
  const applyUser = useCallback((newUser: UserProfile | null) => {
    setUser(newUser)
    const newWs = loadUserWorkspace(newUser)
    setWorkspace(newWs)
    const band = newWs.bands.find((b) => b.id === newWs.activeBandId) || newWs.bands[0]
    if (band) {
      const pls = newWs.playlistsMap[band.id] || []
      if (pls.length > 0) {
        setActivePlaylistId(pls[0].id)
      }
    }
  }, [])

  const setGoogleClientId = (clientId: string) => {
    authService.setGoogleClientId(clientId)
    setGoogleClientIdState(clientId.trim())
  }

  const loginWithGoogleCredential = (credentialJwt: string) => {
    const loggedUser = authService.loginWithGoogleCredential(credentialJwt)
    if (loggedUser) {
      applyUser(loggedUser)
    }
  }

  const loginWithPersonalAccount = (name: string, email: string) => {
    const loggedUser = authService.loginWithPersonalAccount(name, email)
    applyUser(loggedUser)
  }

  const loginWithDemoProfile = (profile: UserProfile) => {
    const loggedUser = authService.loginWithDemoProfile(profile)
    applyUser(loggedUser)
  }

  const loginWithGoogle = (profile?: UserProfile) => {
    if (profile) {
      loginWithDemoProfile(profile)
    } else {
      // If direct Google auth clicked without profile and without Google credential, fallback to first demo
      loginWithDemoProfile(DEMO_PROFILES[0])
    }
  }

  const resetWorkspaceToDemo = () => {
    if (!user) return
    const demoWs: WorkspaceStore = {
      bands: INITIAL_BANDS,
      activeBandId: 'band_01',
      membersMap: INITIAL_MEMBERS,
      playlistsMap: INITIAL_PLAYLISTS,
      equipmentMap: INITIAL_EQUIPMENT,
      stemsMap: INITIAL_STEMS,
    }
    setWorkspace(demoWs)
    localStorage.setItem(`bandait_workspace_${user.id}`, JSON.stringify(demoWs))
  }

  const logout = () => {
    authService.logout()
    applyUser(null)
  }

  const switchBand = (bandId: string) => {
    setWorkspace((prev) => ({ ...prev, activeBandId: bandId }))
    const bandPlaylists = workspace.playlistsMap[bandId] || []
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
      ownerId: user?.id || 'usr_personal',
      currentUserRole: 'Owner',
      membersCount: 1,
      createdAt: new Date().toISOString().slice(0, 10),
    }

    const ownerMember: BandMember = {
      id: `mem_${Date.now()}`,
      bandId: newBandId,
      userId: user?.id || 'usr_personal',
      name: user?.name || 'Director General',
      email: user?.email || '',
      role: 'Owner',
      instrument: 'Director General',
      joinedAt: new Date().toISOString().slice(0, 10),
    }

    setWorkspace((prev) => ({
      ...prev,
      bands: [...prev.bands, newBand],
      activeBandId: newBandId,
      membersMap: {
        ...prev.membersMap,
        [newBandId]: [ownerMember],
      },
      playlistsMap: {
        ...prev.playlistsMap,
        [newBandId]: [],
      },
      equipmentMap: {
        ...prev.equipmentMap,
        [newBandId]: [],
      },
    }))
  }

  const updateMemberRole = (memberId: string, newRole: MemberRole) => {
    if (!activeBand) return
    setWorkspace((prev) => ({
      ...prev,
      membersMap: {
        ...prev.membersMap,
        [activeBand.id]: (prev.membersMap[activeBand.id] || []).map((m) =>
          m.id === memberId ? { ...m, role: newRole } : m
        ),
      },
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
    setWorkspace((prev) => ({
      ...prev,
      membersMap: {
        ...prev.membersMap,
        [activeBand.id]: [...(prev.membersMap[activeBand.id] || []), newMember],
      },
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
    setWorkspace((prev) => ({
      ...prev,
      playlistsMap: {
        ...prev.playlistsMap,
        [activeBand.id]: [...(prev.playlistsMap[activeBand.id] || []), newPl],
      },
    }))
    setActivePlaylistId(newPl.id)
  }

  const updatePlaylistSong = (songId: string, updates: Partial<PlaylistSong>) => {
    if (!activeBand || !activePlaylist) return
    setWorkspace((prev) => ({
      ...prev,
      playlistsMap: {
        ...prev.playlistsMap,
        [activeBand.id]: (prev.playlistsMap[activeBand.id] || []).map((pl) => {
          if (pl.id !== activePlaylist.id) return pl
          return {
            ...pl,
            updatedAt: new Date().toISOString().slice(0, 10),
            songs: pl.songs.map((s) => (s.id === songId ? { ...s, ...updates } : s)),
          }
        }),
      },
    }))
  }

  const reorderSongs = (fromIndex: number, toIndex: number) => {
    if (!activeBand || !activePlaylist) return
    const currentSongs = [...activePlaylist.songs]
    const [moved] = currentSongs.splice(fromIndex, 1)
    currentSongs.splice(toIndex, 0, moved)
    const reindexed = currentSongs.map((s, idx) => ({ ...s, orderIndex: idx + 1 }))

    setWorkspace((prev) => ({
      ...prev,
      playlistsMap: {
        ...prev.playlistsMap,
        [activeBand.id]: (prev.playlistsMap[activeBand.id] || []).map((pl) => {
          if (pl.id !== activePlaylist.id) return pl
          return {
            ...pl,
            updatedAt: new Date().toISOString().slice(0, 10),
            songs: reindexed,
          }
        }),
      },
    }))
  }

  const addSongToPlaylist = (songData: Omit<PlaylistSong, 'id' | 'orderIndex'>) => {
    if (!activeBand || !activePlaylist) return
    const newSong: PlaylistSong = {
      ...songData,
      id: `song_${Date.now()}`,
      orderIndex: activePlaylist.songs.length + 1,
    }
    setWorkspace((prev) => ({
      ...prev,
      playlistsMap: {
        ...prev.playlistsMap,
        [activeBand.id]: (prev.playlistsMap[activeBand.id] || []).map((pl) => {
          if (pl.id !== activePlaylist.id) return pl
          return {
            ...pl,
            updatedAt: new Date().toISOString().slice(0, 10),
            songs: [...pl.songs, newSong],
          }
        }),
      },
    }))
  }

  const removeSongFromPlaylist = (songId: string) => {
    if (!activeBand || !activePlaylist) return
    const filtered = activePlaylist.songs
      .filter((s) => s.id !== songId)
      .map((s, idx) => ({ ...s, orderIndex: idx + 1 }))

    setWorkspace((prev) => ({
      ...prev,
      playlistsMap: {
        ...prev.playlistsMap,
        [activeBand.id]: (prev.playlistsMap[activeBand.id] || []).map((pl) => {
          if (pl.id !== activePlaylist.id) return pl
          return {
            ...pl,
            updatedAt: new Date().toISOString().slice(0, 10),
            songs: filtered,
          }
        }),
      },
    }))
  }

  const updateStemTrackVolume = (channel: number, volumeDb: number) => {
    if (!songStems) return
    setWorkspace((prev) => {
      const currentSongId = activePlaylist?.songs[0]?.id || 'song_01'
      const existing = prev.stemsMap[currentSongId] || prev.stemsMap['song_01']
      if (!existing) return prev
      const updatedTracks = existing.tracks.map((t) =>
        t.channel === channel ? { ...t, volumeDb } : t
      )
      return {
        ...prev,
        stemsMap: {
          ...prev.stemsMap,
          [currentSongId]: { ...existing, tracks: updatedTracks },
        },
      }
    })
  }

  const addEquipment = (itemData: Omit<EquipmentItem, 'id' | 'bandId'>) => {
    if (!activeBand) return
    const newItem: EquipmentItem = {
      ...itemData,
      id: `eq_${Date.now()}`,
      bandId: activeBand.id,
    }
    setWorkspace((prev) => ({
      ...prev,
      equipmentMap: {
        ...prev.equipmentMap,
        [activeBand.id]: [...(prev.equipmentMap[activeBand.id] || []), newItem],
      },
    }))
  }

  const removeEquipment = (id: string) => {
    if (!activeBand) return
    setWorkspace((prev) => ({
      ...prev,
      equipmentMap: {
        ...prev.equipmentMap,
        [activeBand.id]: (prev.equipmentMap[activeBand.id] || []).filter((eq) => eq.id !== id),
      },
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
        bands: workspace.bands,
        activeBand,
        members,
        playlists,
        activePlaylist,
        songStems,
        equipment,
        googleClientId,
        setGoogleClientId,
        loginWithGoogleCredential,
        loginWithPersonalAccount,
        loginWithDemoProfile,
        loginWithGoogle,
        resetWorkspaceToDemo,
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
