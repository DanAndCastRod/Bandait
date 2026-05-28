import { io, Socket } from 'socket.io-client';

export interface SessionState {
  sessionId: string;
  leaderIp: string;
  status: 'IDLE' | 'COUNTING' | 'PLAYING' | 'PAUSED';
  currentSongId: string | null;
  nextEventTimestamp: number;
  bpm: number;
  currentTime: number;
  currentBeat: number;
}

export interface Song {
  id: string;
  title: string;
  artist: string;
  bpm: number;
  key: string;
  duration: number;
  segments: Array<{ label: string; bars: number }>;
  lyrics?: Array<{ time: number; text: string }>;
}

export interface SyncData {
  leaderTimeNs: number;
}

class SocketService {
  private socket: Socket | null = null;
  private sessionId: string = 'default';
  private onStateUpdateCallbacks: Array<(state: SessionState) => void> = [];
  private onBeatCallbacks: Array<(beat: number, bpm: number) => void> = [];
  private onConnectCallbacks: Array<() => void> = [];
  private onDisconnectCallbacks: Array<() => void> = [];

  connect(leaderUrl: string, sessionId: string = 'default'): void {
    this.sessionId = sessionId;
    this.socket = io(leaderUrl, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    });

    this.socket.on('connect', () => {
      console.log('[Socket] Conectado al líder');
      this.socket!.emit('join_session', { sessionId });
      this.onConnectCallbacks.forEach(cb => cb());
    });

    this.socket.on('disconnect', () => {
      console.log('[Socket] Desconectado del líder');
      this.onDisconnectCallbacks.forEach(cb => cb());
    });

    this.socket.on('state_update', (state: SessionState) => {
      this.onStateUpdateCallbacks.forEach(cb => cb(state));
    });

    this.socket.on('full_state', (state: SessionState) => {
      this.onStateUpdateCallbacks.forEach(cb => cb(state));
    });

    this.socket.on('beat', (data: { beat: number; bpm: number }) => {
      this.onBeatCallbacks.forEach(cb => cb(data.beat, data.bpm));
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  sendControl(command: string, data: Record<string, unknown> = {}): void {
    if (!this.socket?.connected) return;
    this.socket.emit('control_command', {
      sessionId: this.sessionId,
      command,
      ...data,
    });
  }

  syncRequest(): Promise<SyncData> {
    return new Promise((resolve) => {
      if (!this.socket?.connected) {
        resolve({ leaderTimeNs: 0 });
        return;
      }
      // const t0 = performance.now(); // Para cálculo de RTT en futuro
      this.socket!.emit('sync_request', {}, (response: SyncData) => {
        resolve(response);
      });
    });
  }

  onStateUpdate(callback: (state: SessionState) => void): () => void {
    this.onStateUpdateCallbacks.push(callback);
    return () => {
      this.onStateUpdateCallbacks = this.onStateUpdateCallbacks.filter(cb => cb !== callback);
    };
  }

  onBeat(callback: (beat: number, bpm: number) => void): () => void {
    this.onBeatCallbacks.push(callback);
    return () => {
      this.onBeatCallbacks = this.onBeatCallbacks.filter(cb => cb !== callback);
    };
  }

  onConnect(callback: () => void): () => void {
    this.onConnectCallbacks.push(callback);
    return () => {
      this.onConnectCallbacks = this.onConnectCallbacks.filter(cb => cb !== callback);
    };
  }

  onDisconnect(callback: () => void): () => void {
    this.onDisconnectCallbacks.push(callback);
    return () => {
      this.onDisconnectCallbacks = this.onDisconnectCallbacks.filter(cb => cb !== callback);
    };
  }

  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }
}

export const socketService = new SocketService();
