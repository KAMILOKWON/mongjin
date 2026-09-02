import { describe, expect, it } from 'vitest';
import { inferMatchPlatform } from './matchAnalytics';

describe('대국 플랫폼 분류', () => {
  it('토스 WebView를 웹보다 우선 분류한다', () => {
    expect(inferMatchPlatform('https://game.apps-in-toss.com', 'Mozilla/5.0 Toss')).toBe('toss');
  });

  it('Steam·모바일·일반 웹 연결을 거친 플랫폼으로 구분한다', () => {
    expect(inferMatchPlatform(undefined, 'Valve Steam Client Electron')).toBe('steam');
    expect(inferMatchPlatform(undefined, 'okhttp/4.12')).toBe('mobile');
    expect(inferMatchPlatform('https://mongjin.example', 'Mozilla/5.0')).toBe('web');
  });

  it('근거가 없는 연결은 추측하지 않는다', () => {
    expect(inferMatchPlatform()).toBe('unknown');
  });
});
