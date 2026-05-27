/**
 * QR Code discovery service for Bandait followers.
 * Scans QR codes containing leader connection info.
 */

export interface QrConnectionData {
  v: number;
  ip: string;
  port: number;
  sessionId: string;
  proto: string;
}

export function parseQrData(raw: string): QrConnectionData | null {
  try {
    const data = JSON.parse(raw) as QrConnectionData;
    if (!data.ip || !data.port || !data.sessionId) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

export function buildUrlFromQr(data: QrConnectionData): string {
  return `${data.proto}://${data.ip}:${data.port}`;
}
