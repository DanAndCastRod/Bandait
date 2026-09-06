import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { FlywheelClock } from '../flywheelClock'

describe('FlywheelClock', () => {
  let clock: FlywheelClock

  beforeEach(() => {
    // Mock Web Audio API
    const mockDestination = {}
    const mockLimiter = {
      threshold: { setValueAtTime: vi.fn() },
      knee: { setValueAtTime: vi.fn() },
      ratio: { setValueAtTime: vi.fn() },
      attack: { setValueAtTime: vi.fn() },
      release: { setValueAtTime: vi.fn() },
      connect: vi.fn(),
    }
    const mockGain = {
      gain: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    }
    const mockOscillator = {
      type: 'sine',
      frequency: { setValueAtTime: vi.fn() },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    }

    const MockAudioContext = vi.fn().mockImplementation(() => ({
      currentTime: 10.0,
      state: 'running',
      resume: vi.fn(),
      destination: mockDestination,
      createDynamicsCompressor: vi.fn().mockReturnValue(mockLimiter),
      createGain: vi.fn().mockReturnValue(mockGain),
      createOscillator: vi.fn().mockReturnValue(mockOscillator),
    }))

    vi.stubGlobal('AudioContext', MockAudioContext)
    clock = new FlywheelClock()
  })

  afterEach(() => {
    clock.stop()
    vi.unstubAllGlobals()
  })

  it('initializes with default values and stops correctly', () => {
    const state = clock.getState()
    expect(state.bpm).toBe(120)
    expect(state.isPlaying).toBe(false)
    expect(state.isAutonomous).toBe(false)
    expect(state.currentBeat).toBe(1)
  })

  it('forces beat = 1 and bar = 1 on start', () => {
    clock.start(130, 4)
    const state = clock.getState()

    expect(state.isPlaying).toBe(true)
    expect(state.bpm).toBe(130)
    expect(state.currentBeat).toBe(1)
    expect(state.currentBar).toBe(1)
    expect(state.isAutonomous).toBe(false)
  })

  it('activates autonomous flywheel inertia on Wi-Fi disconnect during playback', () => {
    let modeReported = false
    clock.setCallbacks(
      vi.fn(),
      (autonomous) => {
        modeReported = autonomous
      }
    )

    clock.start(120)
    expect(clock.getState().isAutonomous).toBe(false)

    // Simulate Wi-Fi drop
    clock.setConnected(false)
    expect(clock.getState().isAutonomous).toBe(true)
    expect(modeReported).toBe(true)

    // Reconnection
    clock.setConnected(true)
    expect(clock.getState().isAutonomous).toBe(false)
    expect(modeReported).toBe(false)
  })

  it('limits volume to valid range [0, 1.0]', () => {
    // Should not crash on invalid inputs
    clock.setVolume(1.5)
    clock.setVolume(-0.2)
    clock.setBpm(600) // Clamps to 500
    expect(clock.getState().bpm).toBe(500)
    clock.setBpm(10) // Clamps to 20
    expect(clock.getState().bpm).toBe(20)
  })
})
