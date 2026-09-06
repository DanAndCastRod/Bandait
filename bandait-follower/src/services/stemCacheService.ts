/**
 * Bandait 3.0 — Offline Stem Pre-Cache Service
 * 
 * Manages pre-fetching and local caching of multi-track audio stems
 * (drums, bass, vocals, other, click, prompts) into IndexedDB.
 * Designed for offline-first resilience on stage.
 */

import {
  saveStem,
  getStem,
  getStemsBySong,
  deleteStemsBySong,
  getAllStems,
  clearStems,
  StoredStem,
} from '../db/indexedDb'

export type StemType = 'drums' | 'bass' | 'vocals' | 'other' | 'click' | 'prompts'

export const DEFAULT_STEM_TYPES: StemType[] = ['drums', 'bass', 'vocals', 'other']

export interface StemDownloadProgress {
  songId: string
  stemType: StemType
  bytesLoaded: number
  totalBytes: number
  progressPercent: number
  status: 'PENDING' | 'DOWNLOADING' | 'CACHED' | 'ERROR'
}

export interface StorageStatus {
  totalSongsCached: number
  totalStemFiles: number
  totalBytes: number
  formattedSize: string
}

class StemCacheService {
  private activeDownloads: Map<string, AbortController> = new Map()

  /**
   * Pre-downloads stems for a single song into IndexedDB.
   * If URL fetching fails (e.g. offline demo mode), creates a valid synthesized silent/pulse WAV buffer
   * so audio nodes and mixers have real data to process offline.
   */
  public async prefetchSongStems(
    songId: string,
    stemUrls?: Partial<Record<StemType, string>>,
    onProgress?: (progress: StemDownloadProgress) => void
  ): Promise<boolean> {
    const stemsToFetch: StemType[] = (Object.keys(stemUrls || {}) as StemType[]).length > 0
      ? (Object.keys(stemUrls!) as StemType[])
      : DEFAULT_STEM_TYPES

    let success = true

    for (const stemType of stemsToFetch) {
      const downloadKey = `${songId}_${stemType}`
      const url = stemUrls?.[stemType]

      // Check if already in IndexedDB
      const existing = await getStem(songId, stemType)
      if (existing && existing.size > 0) {
        if (onProgress) {
          onProgress({
            songId,
            stemType,
            bytesLoaded: existing.size,
            totalBytes: existing.size,
            progressPercent: 100,
            status: 'CACHED',
          })
        }
        continue
      }

      if (onProgress) {
        onProgress({
          songId,
          stemType,
          bytesLoaded: 0,
          totalBytes: 1000,
          progressPercent: 0,
          status: 'DOWNLOADING',
        })
      }

      try {
        let arrayBuffer: ArrayBuffer

        if (url && typeof fetch !== 'undefined') {
          const abortCtrl = new AbortController()
          this.activeDownloads.set(downloadKey, abortCtrl)

          const response = await fetch(url, { signal: abortCtrl.signal })
          this.activeDownloads.delete(downloadKey)

          if (!response.ok) {
            throw new Error(`HTTP ${response.status} loading stem ${stemType}`)
          }
          arrayBuffer = await response.arrayBuffer()
        } else {
          // Synthetic audio buffer fallback for offline simulation / testing
          arrayBuffer = this.generateSyntheticStemBuffer(stemType)
        }

        const stemRecord: StoredStem = {
          id: downloadKey,
          songId,
          stemType,
          data: arrayBuffer,
          size: arrayBuffer.byteLength,
          mimeType: 'audio/wav',
          updatedAt: Date.now(),
        }

        await saveStem(stemRecord)

        if (onProgress) {
          onProgress({
            songId,
            stemType,
            bytesLoaded: arrayBuffer.byteLength,
            totalBytes: arrayBuffer.byteLength,
            progressPercent: 100,
            status: 'CACHED',
          })
        }
      } catch (err) {
        this.activeDownloads.delete(downloadKey)
        success = false
        if (onProgress) {
          onProgress({
            songId,
            stemType,
            bytesLoaded: 0,
            totalBytes: 0,
            progressPercent: 0,
            status: 'ERROR',
          })
        }
      }
    }

    return success
  }

  /**
   * Pre-downloads stems for an entire setlist in sequence.
   */
  public async prefetchSetlist(
    songs: Array<{ id: string; stemUrls?: Partial<Record<StemType, string>> }>,
    onSongProgress?: (songIndex: number, totalSongs: number, songId: string, status: string) => void
  ): Promise<void> {
    for (let i = 0; i < songs.length; i++) {
      const song = songs[i]
      if (onSongProgress) {
        onSongProgress(i + 1, songs.length, song.id, 'PREFETCHING')
      }
      await this.prefetchSongStems(song.id, song.stemUrls)
      if (onSongProgress) {
        onSongProgress(i + 1, songs.length, song.id, 'READY')
      }
    }
  }

  /**
   * Verifies if all specified stems for a song are fully cached in IndexedDB.
   */
  public async isSongFullyCached(
    songId: string,
    requiredTypes: StemType[] = DEFAULT_STEM_TYPES
  ): Promise<{ cached: boolean; availableStems: StemType[]; missingStems: StemType[] }> {
    const cachedRecords = await getStemsBySong(songId)
    const cachedTypes = new Set(cachedRecords.map((r) => r.stemType as StemType))

    const availableStems: StemType[] = []
    const missingStems: StemType[] = []

    for (const type of requiredTypes) {
      if (cachedTypes.has(type)) {
        availableStems.push(type)
      } else {
        missingStems.push(type)
      }
    }

    return {
      cached: missingStems.length === 0,
      availableStems,
      missingStems,
    }
  }

  /**
   * Retrieves an audio blob URL for playback in an Audio element or AudioContext.
   */
  public async getStemBlobUrl(songId: string, stemType: StemType): Promise<string | null> {
    const stem = await getStem(songId, stemType)
    if (!stem || !stem.data) return null

    if (typeof URL !== 'undefined' && typeof Blob !== 'undefined') {
      const blob = new Blob([stem.data], { type: stem.mimeType || 'audio/wav' })
      return URL.createObjectURL(blob)
    }
    return null
  }

  /**
   * Retrieves ArrayBuffer directly for Web Audio API decodeAudioData.
   */
  public async getStemBuffer(songId: string, stemType: StemType): Promise<ArrayBuffer | null> {
    const stem = await getStem(songId, stemType)
    return stem?.data ?? null
  }

  /**
   * Removes all cached stems for a given song.
   */
  public async purgeSongStems(songId: string): Promise<void> {
    await deleteStemsBySong(songId)
  }

  /**
   * Computes offline storage telemetry for stems in IndexedDB.
   */
  public async getStorageStatus(): Promise<StorageStatus> {
    const all = await getAllStems()
    const songIds = new Set(all.map((s) => s.songId))
    const totalBytes = all.reduce((sum, item) => sum + item.size, 0)

    return {
      totalSongsCached: songIds.size,
      totalStemFiles: all.length,
      totalBytes,
      formattedSize: this.formatBytes(totalBytes),
    }
  }

  /**
   * Clears the entire stem cache.
   */
  public async clearAllCache(): Promise<void> {
    await clearStems()
  }

  /**
   * Cancels any in-flight stem download.
   */
  public cancelDownload(songId: string, stemType: StemType): void {
    const downloadKey = `${songId}_${stemType}`
    const ctrl = this.activeDownloads.get(downloadKey)
    if (ctrl) {
      ctrl.abort()
      this.activeDownloads.delete(downloadKey)
    }
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
  }

  /**
   * Generates a 1-second synthetic 44.1kHz 16-bit PCM WAV buffer for offline testing.
   */
  private generateSyntheticStemBuffer(stemType: StemType): ArrayBuffer {
    const sampleRate = 44100
    const durationSec = 1.0
    const numSamples = Math.floor(sampleRate * durationSec)
    const headerByteLength = 44
    const dataByteLength = numSamples * 2
    const totalByteLength = headerByteLength + dataByteLength

    const buffer = new ArrayBuffer(totalByteLength)
    const view = new DataView(buffer)

    // WAV RIFF header
    this.writeString(view, 0, 'RIFF')
    view.setUint32(4, 36 + dataByteLength, true)
    this.writeString(view, 8, 'WAVE')
    this.writeString(view, 12, 'fmt ')
    view.setUint32(16, 16, true) // PCM chunk size
    view.setUint16(20, 1, true)  // Audio format 1 (PCM)
    view.setUint16(22, 1, true)  // Mono
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * 2, true) // byte rate
    view.setUint16(32, 2, true)  // block align
    view.setUint16(34, 16, true) // 16-bit
    this.writeString(view, 36, 'data')
    view.setUint32(40, dataByteLength, true)

    // Generate tonal impulse frequency based on stem type
    let freq = 440
    if (stemType === 'drums') freq = 80
    else if (stemType === 'bass') freq = 120
    else if (stemType === 'vocals') freq = 520
    else if (stemType === 'other') freq = 330
    else if (stemType === 'click') freq = 1000
    else if (stemType === 'prompts') freq = 650

    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate
      // Exponential envelope decaying
      const env = Math.exp(-4 * t)
      const sample = Math.sin(2 * Math.PI * freq * t) * env * 0.5
      const int16 = Math.max(-32768, Math.min(32767, Math.floor(sample * 32767)))
      view.setInt16(44 + i * 2, int16, true)
    }

    return buffer
  }

  private writeString(view: DataView, offset: number, str: string): void {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i))
    }
  }
}

export const stemCacheService = new StemCacheService()
