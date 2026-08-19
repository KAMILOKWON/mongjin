/** 배포된 클라이언트가 공통으로 사용하는 온라인 서버 WebSocket URL */
export const PRODUCTION_WS_URL = 'wss://mongjin-api.onrender.com';

export function resolveWsUrl(): string {
  const fromEnv = import.meta.env.VITE_WS_URL as string | undefined;
  if (fromEnv) return fromEnv;

  if (typeof location === 'undefined') return 'ws://localhost:3001';

  const { hostname } = location;
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return 'ws://localhost:3001';
  }
  return PRODUCTION_WS_URL;
}
