import type { MatchPlatform } from './profileRepository';

/**
 * 이미 배포된 클라이언트를 바꾸지 않고 WebSocket 연결 헤더만으로 거친 플랫폼을 구분한다.
 * 원문 헤더는 저장하지 않으며, 확실하지 않은 연결은 unknown으로 남긴다.
 */
export function inferMatchPlatform(origin?: string, userAgent?: string): MatchPlatform {
  const source = `${origin ?? ''} ${userAgent ?? ''}`.toLowerCase();
  if (/apps?[- ]?in[- ]?toss|appintoss|\btoss\b|granite/.test(source)) return 'toss';
  if (/valve steam|steam client|electron/.test(source)) return 'steam';
  if (/react[- ]?native|expo|okhttp|cfnetwork|darwin/.test(source)) return 'mobile';
  if (/^https?:\/\//.test((origin ?? '').toLowerCase()) || /mozilla\//.test(source)) return 'web';
  return 'unknown';
}
