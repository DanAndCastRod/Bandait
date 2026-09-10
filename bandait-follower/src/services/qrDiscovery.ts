/**
 * QR Code discovery service for Bandait followers.
 * Scans QR codes containing leader connection info.
 */

export interface QrConnectionData {
  v?: number;
  ip: string;
  port: number;
  sessionId: string;
  proto?: string;
  role?: string;
  band?: string;
}

export function parseQrData(raw: string): QrConnectionData | null {
  if (!raw) return null;
  const trimmed = raw.trim();

  // 1. Try JSON format
  try {
    const data = JSON.parse(trimmed) as QrConnectionData;
    if (data.ip && data.port && data.sessionId) {
      return {
        v: data.v ?? 1,
        ip: String(data.ip),
        port: Number(data.port),
        sessionId: String(data.sessionId),
        proto: data.proto || 'http',
        role: data.role,
        band: data.band,
      };
    }
  } catch {
    // Continue to URL parsing
  }

  // 2. Try URL format (e.g. http://192.168.1.100:4040/?session=live_2026&role=drums)
  try {
    const candidate = trimmed.startsWith('bandait://')
      ? trimmed.replace('bandait://', 'http://')
      : trimmed;
    const url = new URL(candidate);
    const sessionId =
      url.searchParams.get('session') ||
      url.searchParams.get('s') ||
      url.pathname.replace(/^\//, '') ||
      'default';
    const role = url.searchParams.get('role') || undefined;
    const band = url.searchParams.get('band') || undefined;
    const ip = url.hostname || '127.0.0.1';
    const port = url.port ? Number(url.port) : 4040;

    if (ip && sessionId) {
      return {
        v: 1,
        ip,
        port,
        sessionId,
        proto: url.protocol.replace(':', '') || 'http',
        role,
        band,
      };
    }
  } catch {
    // Continue to fallback
  }

  return null;
}

export function buildUrlFromQr(data: QrConnectionData): string {
  return `${data.proto || 'http'}://${data.ip}:${data.port}`;
}
