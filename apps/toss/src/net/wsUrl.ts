/** GitHub Pages 등 정적 호스트에서 쓸 온라인 서버 WebSocket URL */
export const PRODUCTION_WS_URL = 'wss://mongjin-api.onrender.com';

export function resolveWsUrl(): string {
  const fromEnv = import.meta.env.VITE_WS_URL as string | undefined;
  if (fromEnv) return fromEnv;

  if (typeof location === 'undefined') return 'ws://localhost:3001';

  const { hostname, protocol } = location;
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return 'ws://localhost:3001';
  }
  if (hostname.endsWith('.github.io') || hostname === 'kamilokwon.github.io') {
    return PRODUCTION_WS_URL;
  }

  return `${protocol === 'https:' ? 'wss' : 'ws'}://${hostname}:3001`;
}

/** 토스 로그인 등 HTTP API용 서버 주소. resolveWsUrl과 같은 서버를 http(s)로 변환한다. */
export function resolveHttpUrl(): string {
  return resolveWsUrl().replace(/^ws/, 'http');
}
