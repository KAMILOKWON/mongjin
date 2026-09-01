import { describe, expect, it } from 'vitest';
import { mergeOnlineProgress, onlineProgressSnapshot } from './catalog';

describe('앱인토스 공식 Elo 승계 상태', () => {
  it('서버의 승계 완료 표시를 기기 스냅샷에 유지한다', () => {
    const progress = mergeOnlineProgress(null, {
      playerId: 'player-a',
      name: '따뜻보스',
      wins: 42,
      losses: 18,
      rating: 1799,
      rank: 1,
      totalPlayers: 14,
      legacyMigrationComplete: true,
    });
    expect(onlineProgressSnapshot(progress)).toMatchObject({
      rating: 1799,
      rank: 1,
      legacyMigrationComplete: true,
    });
  });
});
