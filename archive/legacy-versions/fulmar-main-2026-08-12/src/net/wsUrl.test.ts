import { describe, expect, it, vi } from 'vitest';
import { PRODUCTION_WS_URL, resolveWsUrl } from './wsUrl';

describe('resolveWsUrl', () => {
  it('uses VITE_WS_URL when set', () => {
    vi.stubEnv('VITE_WS_URL', 'wss://example.test/ws');
    expect(resolveWsUrl()).toBe('wss://example.test/ws');
    vi.unstubAllEnvs();
  });

  it('points GitHub Pages to production server', () => {
    vi.stubGlobal('location', {
      hostname: 'kamilokwon.github.io',
      protocol: 'https:',
    } as Location);
    expect(resolveWsUrl()).toBe(PRODUCTION_WS_URL);
  });

  it('uses localhost in dev', () => {
    vi.stubGlobal('location', {
      hostname: 'localhost',
      protocol: 'http:',
    } as Location);
    expect(resolveWsUrl()).toBe('ws://localhost:3001');
  });
});
