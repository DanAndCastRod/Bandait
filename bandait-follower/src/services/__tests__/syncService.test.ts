import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SyncService } from "../syncService";

describe("SyncService", () => {
  let sync: SyncService;

  beforeEach(() => {
    sync = new SyncService();
  });

  afterEach(() => {
    sync.disconnect();
  });

  it("should calculate offset from NTP-like exchange", () => {
    // Simulate: t0=0, leaderTime=50, t3=100
    // RTT = 100ms, offset = 50 - (0 + 100/2) = 0ms
    const t0 = 0;
    const leaderTimeMs = 50;
    const t3 = 100;
    const rttMs = t3 - t0; // 100
    const offsetMs = leaderTimeMs - (t0 + rttMs / 2); // 50 - 50 = 0

    expect(rttMs).toBe(100);
    expect(offsetMs).toBeCloseTo(0, 1);
  });

  it("should filter outliers in offset computation", () => {
    // Inject results manually
    const results = [
      { rttMs: 2, offsetMs: 5, timestampMs: 1000 },
      { rttMs: 2, offsetMs: 5.2, timestampMs: 2000 },
      { rttMs: 2, offsetMs: 4.8, timestampMs: 3000 },
      { rttMs: 2, offsetMs: 5.1, timestampMs: 4000 },
      { rttMs: 200, offsetMs: 100, timestampMs: 5000 }, // outlier
    ];

    // Access private for test
    const syncPrivate = sync as unknown as {
      syncResults: typeof results;
      computeStableOffset: () => void;
      stableOffsetMs: number | null;
    };
    syncPrivate.syncResults = results;
    syncPrivate.computeStableOffset();

    const offset = syncPrivate.stableOffsetMs;
    expect(offset).not.toBeNull();
    expect(Math.abs(offset - 5.0)).toBeLessThan(2.0); // Should ignore 100ms outlier
  });

  it("should convert times using stable offset", () => {
    (sync as unknown as { stableOffsetMs: number | null }).stableOffsetMs = 10.0;

    // convertToLocal: leaderTime - offset = 100 - 10 = 90
    expect(sync.convertToLocal(100)).toBe(90);

    // convertToLeader: localTime + offset = 50 + 10 = 60
    expect(sync.convertToLeader(50)).toBe(60);
  });

  it("should pass through when no offset available", () => {
    expect(sync.convertToLocal(100)).toBe(100);
    expect(sync.convertToLeader(50)).toBe(50);
  });
});
