/**
 * NTP-lite clock synchronization for Bandait followers.
 * Uses performance.now() (monotonic) + Date.now() (wall clock) hybrid.
 */

import { io, Socket } from "socket.io-client";
import { MessageType, SessionState, SyncResult } from "../types/protocol";

const SYNC_WINDOW = 10;
const OUTLIER_THRESHOLD = 2.0;

export class SyncService {
  private socket: Socket | null = null;
  private syncResults: SyncResult[] = [];
  private stableOffsetMs: number | null = null;
  private onStateUpdate: ((state: SessionState) => void) | null = null;
  private onCommand: ((cmd: any) => void) | null = null;
  private onConnect: (() => void) | null = null;
  private onDisconnect: (() => void) | null = null;

  connect(url: string, sessionId: string): void {
    this.socket = io(url, {
      transports: ["websocket"],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    });

    this.socket.on("connect", () => {
      console.log("[SYNC] Connected to leader");
      this.socket!.emit("join_session", { sessionId });
      this.onConnect?.();
      this.startSyncLoop();
    });

    this.socket.on("disconnect", () => {
      console.log("[SYNC] Disconnected from leader");
      this.onDisconnect?.();
    });

    this.socket.on("state_update", (state: SessionState) => {
      this.onStateUpdate?.(state);
    });

    this.socket.on("full_state", (state: SessionState) => {
      this.onStateUpdate?.(state);
    });

    this.socket.on("command", (cmd: any) => {
      this.onCommand?.(cmd);
    });
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
    this.syncResults = [];
    this.stableOffsetMs = null;
  }

  private startSyncLoop(): void {
    // Run initial burst of 10 syncs, then every 5s
    let count = 0;
    const burst = setInterval(() => {
      if (count >= SYNC_WINDOW || !this.socket?.connected) {
        clearInterval(burst);
        setInterval(() => this.runSync(), 5000);
        return;
      }
      this.runSync();
      count++;
    }, 200);
  }

  private runSync(): void {
    if (!this.socket?.connected) return;

    const t0 = performance.now();
    this.socket.emit(
      "sync_request",
      {},
      (response: { type: MessageType; leaderTimeNs: number }) => {
        const t3 = performance.now();
        const leaderTimeMs = response.leaderTimeNs / 1e6;

        // NTP formula: RTT = (t3 - t0), offset = ((t1 - t0) + (t2 - t3)) / 2
        // Here t1 ≈ t2 (leader processing is negligible)
        const rttMs = t3 - t0;
        const offsetMs = leaderTimeMs - (t0 + rttMs / 2);

        const result: SyncResult = {
          rttMs,
          offsetMs,
          timestampMs: t3,
        };

        this.syncResults.push(result);
        if (this.syncResults.length > SYNC_WINDOW) {
          this.syncResults.shift();
        }
        this.computeStableOffset();
      }
    );
  }

  private computeStableOffset(): void {
    if (this.syncResults.length < 3) return;

    const offsets = this.syncResults.map((r) => r.offsetMs);
    const median = this.median(offsets);
    const mad = this.median(offsets.map((o) => Math.abs(o - median)));
    const threshold = Math.max(mad * OUTLIER_THRESHOLD, 1.0);
    const filtered = offsets.filter((o) => Math.abs(o - median) <= threshold);
    if (filtered.length === 0) return;

    const stable = filtered.reduce((a, b) => a + b, 0) / filtered.length;
    if (
      this.stableOffsetMs === null ||
      Math.abs(stable - this.stableOffsetMs) > 0.5
    ) {
      this.stableOffsetMs = stable;
      console.log(`[SYNC] Stable offset: ${stable.toFixed(2)}ms`);
    }
  }

  private median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // --- Public API ---

  getLocalTimeMs(): number {
    return performance.now();
  }

  convertToLocal(leaderTimeMs: number): number {
    if (this.stableOffsetMs === null) return leaderTimeMs;
    return leaderTimeMs - this.stableOffsetMs;
  }

  convertToLeader(localTimeMs: number): number {
    if (this.stableOffsetMs === null) return localTimeMs;
    return localTimeMs + this.stableOffsetMs;
  }

  getStableOffsetMs(): number | null {
    return this.stableOffsetMs;
  }

  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  setStateUpdateHandler(handler: (state: SessionState) => void): void {
    this.onStateUpdate = handler;
  }

  setCommandHandler(handler: (cmd: any) => void): void {
    this.onCommand = handler;
  }

  setConnectHandler(handler: () => void): void {
    this.onConnect = handler;
  }

  setDisconnectHandler(handler: () => void): void {
    this.onDisconnect = handler;
  }
}

export const syncService = new SyncService();
