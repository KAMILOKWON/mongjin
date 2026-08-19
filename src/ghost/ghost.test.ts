import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../core/config';
import { initialState } from '../core/rules';
import { BUILT_IN_GHOSTS, GhostController, GhostStore, createGhostNickname, decodeGhost, encodeGhost, ghostFromFinishedGame } from './index';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

describe('고스트 공통 포맷', () => {
  it('iOS와 호환되는 version 1 공유 payload를 인코딩·디코딩한다', () => {
    const tape = BUILT_IN_GHOSTS[0]!;
    const decoded = decodeGhost(encodeGhost(tape));
    expect(decoded.source).toBe('imported');
    expect(decoded.id).not.toBe(tape.id);
    expect(decoded.moves).toEqual(tape.moves);
    expect(decoded.result).toEqual(tape.result);
  });

  it('첫 실행에는 iOS와 같은 기본 고스트 3개를 제공한다', () => {
    const store = new GhostStore(new MemoryStorage());
    expect(store.allTapes().map((tape) => tape.ownerName).sort()).toEqual(['단풍', '새벽', '이슬']);
    expect(store.pickChallenge(1180)?.ownerName).toBe('새벽');
  });

  it('빠른 대전 고스트는 같은 기보라도 매번 다른 표시 이름을 쓴다', () => {
    const store = new GhostStore(new MemoryStorage());
    const first = store.pickQuickMatchChallenge(1180);
    const second = store.pickQuickMatchChallenge(1180);
    expect(first?.id).toBe(second?.id);
    expect(first?.ownerName).not.toBe(second?.ownerName);
    expect(first?.ownerName).not.toBe('새벽');
    expect(second?.ownerName).not.toBe('새벽');
  });

  it('닉네임 난수가 반복돼도 직전 상대와 플레이어 이름을 피한다', () => {
    const first = createGhostNickname({ random: () => 0 });
    const second = createGhostNickname({ random: () => 0, previousName: first });
    const third = createGhostNickname({ random: () => 0, playerName: first });
    expect(second).not.toBe(first);
    expect(third).not.toBe(first);
  });

  it('앱을 다시 열어도 직전 고스트 닉네임을 반복하지 않는다', () => {
    const storage = new MemoryStorage();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const first = new GhostStore(storage).pickQuickMatchChallenge(1180);
    const second = new GhostStore(storage).pickQuickMatchChallenge(1180);
    random.mockRestore();
    expect(first?.ownerName).not.toBe(second?.ownerName);
  });

  it('기보 수가 합법이면 recorded로 재생한다', () => {
    const controller = new GhostController(BUILT_IN_GHOSTS[0]!);
    const decision = controller.choose(initialState(DEFAULT_CONFIG), DEFAULT_CONFIG);
    expect(decision?.style).toBe('recorded');
    expect(decision?.move).toEqual(BUILT_IN_GHOSTS[0]!.moves[0]);
  });

  it('종료된 게임에서 플레이어 진영의 수만 새 고스트로 저장한다', () => {
    const state = initialState(DEFAULT_CONFIG);
    const tape = ghostFromFinishedGame(
      { ...state, history: [{ kind: 'PLACE', to: { r: 7, c: 4 } }] },
      { winner: 'BLACK', reason: 'goal' },
      '플레이어',
      1200,
      'BLACK',
      'local',
    );
    expect(tape.moves).toEqual([{ kind: 'PLACE', to: { r: 7, c: 4 } }]);
    expect(tape.plyCount).toBe(1);
  });
});
