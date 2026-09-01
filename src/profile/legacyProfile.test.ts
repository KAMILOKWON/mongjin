import { describe, expect, it } from 'vitest';
import { buildLegacyProfileClaim } from './legacyProfile';

describe('웹 기존 Elo 승계', () => {
  it('기존 브라우저 프로필을 새 서버 프로필로 그대로 승계한다', () => {
    expect(buildLegacyProfileClaim(
      { name: '따뜻보스', wins: 59, losses: 9, rating: 1799 },
      { name: '나그네1234', wins: 0, losses: 0, rating: 1200 },
    )).toEqual({ name: '따뜻보스', wins: 59, losses: 9, rating: 1799 });
  });

  it('승계 전 서버에 쌓인 전적과 로컬 Elo 증감을 합친다', () => {
    expect(buildLegacyProfileClaim(
      { name: '웹고수', wins: 4, losses: 1, rating: 1260 },
      { name: '나그네1234', wins: 2, losses: 1, rating: 1210 },
    )).toEqual({ name: '웹고수', wins: 6, losses: 2, rating: 1270 });
  });

  it('기본 로컬 프로필은 서버 전적을 중복하지 않는다', () => {
    expect(buildLegacyProfileClaim(
      { name: '나그네', wins: 0, losses: 0, rating: 1200 },
      { name: '온라인유저', wins: 3, losses: 2, rating: 1224 },
    )).toEqual({ name: '온라인유저', wins: 3, losses: 2, rating: 1224 });
  });

  it('손상된 로컬 값도 서버 허용 범위로 제한한다', () => {
    expect(buildLegacyProfileClaim(
      { name: '<bad>', wins: Number.POSITIVE_INFINITY, losses: -3, rating: 2999 },
      { name: '안전유저', wins: 1, losses: 0, rating: 1200 },
    )).toEqual({ name: '안전유저', wins: 1, losses: 0, rating: 1224 });
  });
});
