import { describe, it, expect, vi, afterEach } from 'vitest'
import { decodeLeaderInfo } from '../../protocol/wire'
import { FetchLike, FetchResponseLike, LEADER_INFO_TIMEOUT_MS, detectLeaderInfo } from '../leaderInfo'

/** GET /leader-info.json per CONTRACT_V3 section 8. */
const VALID = {
  protocol_version: 3,
  leader_instance_id: '0b7e3f2a-5c19-4d8e-9a61-7f2c4b8d1e05',
  session_id: 'gira',
  ip: '192.168.1.20',
  port: 4040,
  follower_url: 'http://192.168.1.20:4040/?ip=192.168.1.20&port=4040&session=gira&auto=1',
  director_url: 'http://192.168.1.20:4040/?ip=192.168.1.20&port=4040&session=gira&auto=1&role=director',
}

function response(body: string, contentType = 'application/json', status = 200): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: () => Promise.resolve(body),
  }
}

function fetchReturning(res: FetchResponseLike): { fn: FetchLike; calls: Array<{ url: string; init: unknown }> } {
  const calls: Array<{ url: string; init: unknown }> = []
  return {
    calls,
    fn: (url, init) => {
      calls.push({ url, init })
      return Promise.resolve(res)
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('decodeLeaderInfo', () => {
  it('decodes the contract payload', () => {
    const res = decodeLeaderInfo(VALID)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value).toEqual({
      protocolVersion: 3,
      leaderInstanceId: VALID.leader_instance_id,
      sessionId: 'gira',
      ip: '192.168.1.20',
      port: 4040,
      followerUrl: VALID.follower_url,
      directorUrl: VALID.director_url,
    })
  })

  it('rejects malformed payloads', () => {
    const bad: Array<Record<string, unknown>> = [
      { ...VALID, protocol_version: 2 },
      { ...VALID, port: 0 },
      { ...VALID, port: '4040' },
      { ...VALID, ip: '' },
      { ...VALID, ip: 'http://192.168.1.20' },
      { ...VALID, ip: '192.168.1.20:4040' },
      { ...VALID, session_id: '' },
      { ...VALID, leader_instance_id: 3 },
    ]
    for (const b of bad) expect(decodeLeaderInfo(b).ok, JSON.stringify(b)).toBe(false)
    const { follower_url: _omit, ...missing } = VALID
    void _omit
    expect(decodeLeaderInfo(missing).ok).toBe(false)
    expect(decodeLeaderInfo(null).ok).toBe(false)
    expect(decodeLeaderInfo('<!doctype html>').ok).toBe(false)
  })
})

describe('detectLeaderInfo', () => {
  it('served: valid v3 JSON, fetched with no-store', async () => {
    const f = fetchReturning(response(JSON.stringify(VALID)))
    const out = await detectLeaderInfo({ fetchFn: f.fn })
    expect(out.kind).toBe('served')
    if (out.kind === 'served') expect(out.info.ip).toBe('192.168.1.20')
    expect(f.calls[0].url).toBe('./leader-info.json')
    expect(f.calls[0].init).toMatchObject({ cache: 'no-store' })
  })

  it('ignores the SPA rewrite (index.html) by content type or by body', async () => {
    const html = '<!doctype html><html><head></head><body><div id="root"></div></body></html>'
    expect(await detectLeaderInfo({ fetchFn: fetchReturning(response(html, 'text/html; charset=utf-8')).fn })).toEqual({
      kind: 'absent',
      reason: 'html',
    })
    expect(await detectLeaderInfo({ fetchFn: fetchReturning(response(html, 'application/octet-stream')).fn })).toEqual({
      kind: 'absent',
      reason: 'html',
    })
  })

  it('reports a leader on another protocol version', async () => {
    const out = await detectLeaderInfo({ fetchFn: fetchReturning(response(JSON.stringify({ ...VALID, protocol_version: 2 }))).fn })
    expect(out).toMatchObject({ kind: 'absent', reason: 'version' })
  })

  it('invalid JSON, contract violations, HTTP errors and network errors are "absent"', async () => {
    expect(await detectLeaderInfo({ fetchFn: fetchReturning(response('{nope')).fn })).toMatchObject({ reason: 'invalid' })
    expect(
      await detectLeaderInfo({ fetchFn: fetchReturning(response(JSON.stringify({ ...VALID, port: 99999 }))).fn }),
    ).toMatchObject({ reason: 'invalid' })
    expect(await detectLeaderInfo({ fetchFn: fetchReturning(response('', 'text/plain', 404)).fn })).toMatchObject({
      reason: 'http',
      detail: '404',
    })
    expect(await detectLeaderInfo({ fetchFn: () => Promise.reject(new TypeError('Failed to fetch')) })).toMatchObject({
      reason: 'network',
    })
    expect(await detectLeaderInfo({ fetchFn: null })).toEqual({ kind: 'absent', reason: 'unsupported' })
  })

  it('times out after ~1.5 s and aborts the request', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const pending = detectLeaderInfo({
      fetchFn: (_url, init) => {
        signal = init.signal
        return new Promise<FetchResponseLike>(() => undefined) // never answers
      },
    })
    await vi.advanceTimersByTimeAsync(LEADER_INFO_TIMEOUT_MS - 1)
    let settled = false
    void pending.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect(await pending).toEqual({ kind: 'absent', reason: 'timeout' })
    expect(signal?.aborted).toBe(true)
  })
})
