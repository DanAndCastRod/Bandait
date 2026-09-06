import { describe, it, expect, beforeEach, vi } from 'vitest'
import { StoredStem } from '../../db/indexedDb'

const memoryStore = new Map<string, StoredStem>()

vi.mock('../../db/indexedDb', () => ({
  saveStem: vi.fn(async (stem: StoredStem) => {
    memoryStore.set(stem.id, stem)
  }),
  getStem: vi.fn(async (songId: string, stemType: string) => {
    return memoryStore.get(`${songId}_${stemType}`) ?? null
  }),
  getStemsBySong: vi.fn(async (songId: string) => {
    return Array.from(memoryStore.values()).filter((s) => s.songId === songId)
  }),
  deleteStemsBySong: vi.fn(async (songId: string) => {
    for (const [k, v] of Array.from(memoryStore.entries())) {
      if (v.songId === songId) memoryStore.delete(k)
    }
  }),
  getAllStems: vi.fn(async () => {
    return Array.from(memoryStore.values())
  }),
  clearStems: vi.fn(async () => {
    memoryStore.clear()
  }),
}))

import { stemCacheService, StemDownloadProgress } from '../stemCacheService'

describe('StemCacheService', () => {
  beforeEach(async () => {
    memoryStore.clear()
    await stemCacheService.clearAllCache()
  })

  it('prefetches and synthesizes fallback stems when offline', async () => {
    const songId = 'song_test_01'
    const progressList: StemDownloadProgress[] = []

    const success = await stemCacheService.prefetchSongStems(songId, undefined, (p) => {
      progressList.push(p)
    })

    expect(success).toBe(true)
    expect(progressList.length).toBeGreaterThan(0)

    const status = await stemCacheService.isSongFullyCached(songId)
    expect(status.cached).toBe(true)
    expect(status.availableStems).toEqual(['drums', 'bass', 'vocals', 'other'])
    expect(status.missingStems).toEqual([])
  })

  it('calculates storage status correctly', async () => {
    await stemCacheService.prefetchSongStems('song_a')
    await stemCacheService.prefetchSongStems('song_b')

    const storage = await stemCacheService.getStorageStatus()
    expect(storage.totalSongsCached).toBe(2)
    expect(storage.totalStemFiles).toBe(8)
    expect(storage.totalBytes).toBeGreaterThan(0)
    expect(typeof storage.formattedSize).toBe('string')
  })

  it('purges song stems properly', async () => {
    await stemCacheService.prefetchSongStems('song_to_delete')
    let status = await stemCacheService.isSongFullyCached('song_to_delete')
    expect(status.cached).toBe(true)

    await stemCacheService.purgeSongStems('song_to_delete')
    status = await stemCacheService.isSongFullyCached('song_to_delete')
    expect(status.cached).toBe(false)
    expect(status.availableStems.length).toBe(0)
  })

  it('prefetches multiple songs in a setlist', async () => {
    const setlist = [
      { id: 'track_1' },
      { id: 'track_2' },
    ]

    const log: string[] = []
    await stemCacheService.prefetchSetlist(setlist, (idx, total, id, stat) => {
      log.push(`${idx}/${total} ${id} ${stat}`)
    })

    expect(log.length).toBe(4) // PREFETCHING + READY for each of the 2 songs
    const status1 = await stemCacheService.isSongFullyCached('track_1')
    const status2 = await stemCacheService.isSongFullyCached('track_2')
    expect(status1.cached).toBe(true)
    expect(status2.cached).toBe(true)
  })
})
