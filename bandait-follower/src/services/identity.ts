/**
 * Follower identity: persistent client_id, UUIDs and role mapping.
 *
 * crypto.randomUUID() only exists in secure contexts (HTTPS or localhost).
 * On the stage LAN the PWA is often served over plain http://192.168.x.x, so
 * there is a getRandomValues fallback (available in insecure contexts too).
 */

import { FollowerRole } from '../types/protocol'

const CLIENT_ID_KEY = 'bandait_client_id'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

let memoryClientId: string | null = null

export function uuidv4(): string {
  const c = (typeof globalThis !== 'undefined' ? globalThis.crypto : undefined) as Crypto | undefined
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID()
    } catch {
      // Insecure context in some engines: fall through.
    }
  }
  const bytes = new Uint8Array(16)
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

/** Stable per device; survives reloads. Falls back to memory if storage is blocked. */
export function getOrCreateClientId(): string {
  const s = storage()
  try {
    const saved = s?.getItem(CLIENT_ID_KEY)
    if (saved && isUuid(saved)) return saved
  } catch {
    // Storage blocked: use memory.
  }
  if (memoryClientId) return memoryClientId
  const id = uuidv4()
  memoryClientId = id
  try {
    s?.setItem(CLIENT_ID_KEY, id)
  } catch {
    // Keep the in-memory id.
  }
  return id
}

/** Musical profile role (drums, bass, director...) to protocol role. */
export function protocolRoleFor(profileRole: string | null | undefined): FollowerRole {
  return profileRole === 'director' ? 'director' : 'musician'
}

export function sanitizeAlias(alias: string | null | undefined): string {
  const trimmed = (alias ?? '').trim().slice(0, 40)
  return trimmed.length > 0 ? trimmed : 'Musico'
}
