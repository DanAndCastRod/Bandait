import { describe, it, expect } from 'vitest'
import {
  PageContext,
  buildLeaderUrl,
  decideConnection,
  isLoopbackHost,
  qrEntryMode,
  shouldRegisterServiceWorker,
} from '../connectionGuard'
import { registerServiceWorkerSafely } from '../serviceWorker'

const https: PageContext = {
  protocol: 'https:',
  hostname: 'bandait.releven.cc',
  isSecureContext: true,
  hasCameraApi: true,
  hasServiceWorker: true,
}
/** Served by the leader over plain HTTP on the LAN: insecure context. */
const leaderHttp: PageContext = {
  protocol: 'http:',
  hostname: '192.168.1.20',
  isSecureContext: false,
  hasCameraApi: false,
  hasServiceWorker: false,
}
const devLocalhost: PageContext = { ...leaderHttp, hostname: 'localhost', isSecureContext: true, hasCameraApi: true, hasServiceWorker: true }

const target = { ip: '192.168.1.20', port: '4040', sessionId: 'gira' }

describe('HTTPS guard (contract section 8)', () => {
  it('never dials a LAN leader from an HTTPS page; offers the leader-served follower instead', () => {
    const d = decideConnection(https, target, { role: 'director', alias: 'Dir Uno' })
    expect(d.kind).toBe('open_from_leader')
    if (d.kind !== 'open_from_leader') return
    const url = new URL(d.url)
    expect(url.protocol).toBe('http:')
    expect(url.host).toBe('192.168.1.20:4040')
    expect(url.pathname).toBe('/')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      ip: '192.168.1.20',
      port: '4040',
      session: 'gira',
      role: 'director',
      alias: 'Dir Uno',
      auto: '1',
    })
  })

  it('allows loopback targets from HTTPS and anything from HTTP', () => {
    for (const ip of ['localhost', '127.0.0.1', '127.1.2.3', '[::1]', '::1']) {
      expect(decideConnection(https, { ...target, ip }).kind, ip).toBe('connect')
    }
    expect(decideConnection(leaderHttp, target).kind).toBe('connect')
    expect(decideConnection(devLocalhost, target).kind).toBe('connect')
  })

  it('recognises loopback hosts only', () => {
    expect(isLoopbackHost('LOCALHOST')).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('192.168.1.20')).toBe(false)
    expect(isLoopbackHost('127.0.0.1.evil.com')).toBe(false)
    expect(isLoopbackHost('localhost.example')).toBe(false)
  })

  it('keeps the user params, replaces the core ones and always sets auto=1', () => {
    const keep = new URLSearchParams('band=los-inquietos&ip=10.0.0.9&auto=0&role=bass&utm=qr')
    const url = new URL(buildLeaderUrl({ ip: '10.0.0.5', port: 4041, sessionId: 'show 1' }, { role: 'drums', keep }))
    expect(url.searchParams.get('ip')).toBe('10.0.0.5')
    expect(url.searchParams.get('port')).toBe('4041')
    expect(url.searchParams.get('session')).toBe('show 1')
    expect(url.searchParams.get('role')).toBe('drums')
    expect(url.searchParams.getAll('auto')).toEqual(['1'])
    expect(url.searchParams.get('band')).toBe('los-inquietos')
    expect(url.searchParams.get('utm')).toBe('qr')
    expect(url.searchParams.has('alias')).toBe(false)
  })
})

describe('insecure-context branches', () => {
  it('QR: in-app camera only in secure contexts with a camera API', () => {
    expect(qrEntryMode(https)).toBe('in_app')
    expect(qrEntryMode(devLocalhost)).toBe('in_app')
    expect(qrEntryMode(leaderHttp)).toBe('native_camera')
    expect(qrEntryMode({ ...https, hasCameraApi: false })).toBe('native_camera')
  })

  it('service worker: production + secure context + API only', () => {
    expect(shouldRegisterServiceWorker(https, true)).toBe(true)
    expect(shouldRegisterServiceWorker(https, false)).toBe(false) // dev: no sw.js
    expect(shouldRegisterServiceWorker(leaderHttp, true)).toBe(false)
    expect(shouldRegisterServiceWorker({ ...https, hasServiceWorker: false }, true)).toBe(false)
  })

  it('registerServiceWorkerSafely skips insecure contexts and swallows rejections', async () => {
    const calls: string[] = []
    const register = (url: string) => {
      calls.push(url)
      return Promise.reject(new Error('SecurityError'))
    }
    expect(registerServiceWorkerSafely({ page: leaderHttp, isProd: true, register, onLoad: (fn) => fn() })).toBe(false)
    expect(calls).toEqual([])

    // The rejected register() must be swallowed: vitest fails the run on any
    // unhandled rejection, so letting a tick pass is the assertion.
    expect(registerServiceWorkerSafely({ page: https, isProd: true, register, onLoad: (fn) => fn() })).toBe(true)
    expect(calls).toEqual(['./sw.js'])
    await new Promise((r) => setTimeout(r, 0))
    expect(
      registerServiceWorkerSafely({
        page: https,
        isProd: true,
        register: () => {
          throw new Error('sync throw')
        },
        onLoad: (fn) => fn(),
      }),
    ).toBe(true)
  })
})
