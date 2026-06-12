import { describe, expect, it } from 'vitest';
import type { GameState, Move, Piece, Player } from './types';
import { DEFAULT_CONFIG, type RuleConfig } from './config';
import { initialState, legalMoves, positionKey } from './rules';
import { applyMove } from './apply';
import { getResult } from './result';

// 기본 메커니즘 테스트는 목적지 금지/왕 잡기 규칙을 끄고 검증한다 (전용 테스트는 아래 별도 블록)
const CFG: RuleConfig = { ...DEFAULT_CONFIG, noGuardOnGoal: false, kingCapture: false };

/** 테스트용 커스텀 국면 생성. pieces: [r, c, player, type] */
function makeState(
  pieces: Array<[number, number, Player, Piece['type']]>,
  turn: Player,
  hands: { BLACK: number; WHITE: number },
  config: RuleConfig = CFG,
): GameState {
  const n = config.boardSize;
  const board: (Piece | null)[][] = Array.from({ length: n }, () =>
    Array.from({ length: n }, () => null),
  );
  for (const [r, c, player, type] of pieces) {
    board[r][c] = { player, type };
  }
  const state: GameState = {
    board,
    turn,
    guardsInHand: { ...hands },
    history: [],
    positionCounts: {},
  };
  state.positionCounts[positionKey(state)] = 1;
  return state;
}

function moveSet(moves: Move[]): Set<string> {
  return new Set(
    moves.map((m) =>
      m.kind === 'PLACE'
        ? `P:${m.to.r},${m.to.c}`
        : `M:${m.from.r},${m.from.c}>${m.to.r},${m.to.c}`,
    ),
  );
}

describe('초기 국면', () => {
  it('흑 선공, 왕 2개 배치, 호위는 손에 8개씩', () => {
    const s = initialState(CFG);
    expect(s.turn).toBe('BLACK');
    expect(s.board[8][4]).toEqual({ player: 'BLACK', type: 'KING' });
    expect(s.board[0][4]).toEqual({ player: 'WHITE', type: 'KING' });
    expect(s.guardsInHand).toEqual({ BLACK: 8, WHITE: 8 });
  });

  it('흑의 첫 수: 왕 이동 5개 + 인접 착수 3개 = 8개', () => {
    const s = initialState(CFG);
    const moves = legalMoves(s, CFG);
    expect(moves.filter((m) => m.kind === 'MOVE')).toHaveLength(5);
    expect(moves.filter((m) => m.kind === 'PLACE')).toHaveLength(3);
    const set = moveSet(moves);
    expect(set.has('P:7,4')).toBe(true);
    expect(set.has('P:8,3')).toBe(true);
    expect(set.has('P:8,5')).toBe(true);
    expect(set.has('M:8,4>7,3')).toBe(true);
  });
});

describe('착수 규칙', () => {
  it('손에 호위가 없으면 착수 불가', () => {
    const s = makeState([[8, 4, 'BLACK', 'KING']], 'BLACK', { BLACK: 0, WHITE: 8 });
    expect(legalMoves(s, CFG).every((m) => m.kind === 'MOVE')).toBe(true);
  });

  it('착수하면 손이 줄고 인접 착수 범위가 넓어진다', () => {
    const s0 = initialState(CFG);
    const s1 = applyMove(s0, { kind: 'PLACE', to: { r: 7, c: 4 } });
    expect(s1.guardsInHand.BLACK).toBe(7);
    expect(s1.board[7][4]).toEqual({ player: 'BLACK', type: 'GUARD' });
    expect(s1.turn).toBe('WHITE');
    // 백이 한 수 둔 뒤, 흑은 새 호위 주변에도 착수 가능
    const s2 = applyMove(s1, { kind: 'MOVE', from: { r: 0, c: 4 }, to: { r: 1, c: 4 } });
    const set = moveSet(legalMoves(s2, CFG));
    expect(set.has('P:6,4')).toBe(true);
    expect(set.has('P:7,3')).toBe(true);
  });

  it('own-half 모드: 자기 진영 절반의 빈 칸 어디든 착수 가능', () => {
    const cfg: RuleConfig = { ...CFG, placement: 'own-half' };
    const s = initialState(cfg);
    const set = moveSet(legalMoves(s, cfg));
    expect(set.has('P:5,0')).toBe(true); // 인접하지 않은 자기 진영 칸
    expect(set.has('P:4,4')).toBe(false); // 중립 중앙 행
    expect(set.has('P:3,0')).toBe(false); // 상대 진영
  });
});

describe('이동/잡기 규칙', () => {
  it('호위는 상대 호위를 대체 잡기로 잡는다', () => {
    const s = makeState(
      [
        [8, 4, 'BLACK', 'KING'],
        [0, 4, 'WHITE', 'KING'],
        [4, 4, 'BLACK', 'GUARD'],
        [3, 4, 'WHITE', 'GUARD'],
      ],
      'BLACK',
      { BLACK: 0, WHITE: 0 },
    );
    const set = moveSet(legalMoves(s, CFG));
    expect(set.has('M:4,4>3,4')).toBe(true);
    const s2 = applyMove(s, { kind: 'MOVE', from: { r: 4, c: 4 }, to: { r: 3, c: 4 } });
    expect(s2.board[3][4]).toEqual({ player: 'BLACK', type: 'GUARD' });
    expect(s2.board[4][4]).toBeNull();
  });

  it('호위는 상대 왕을 잡을 수 없다 (kingCapture 끔)', () => {
    const s = makeState(
      [
        [8, 4, 'BLACK', 'KING'],
        [0, 4, 'WHITE', 'KING'],
        [1, 4, 'BLACK', 'GUARD'],
      ],
      'BLACK',
      { BLACK: 0, WHITE: 0 },
    );
    const set = moveSet(legalMoves(s, CFG));
    expect(set.has('M:1,4>0,4')).toBe(false);
  });

  it('왕은 빈 칸으로만 8방향 이동, 잡기 불가', () => {
    const s = makeState(
      [
        [4, 4, 'BLACK', 'KING'],
        [3, 4, 'WHITE', 'GUARD'],
        [0, 0, 'WHITE', 'KING'],
      ],
      'BLACK',
      { BLACK: 0, WHITE: 0 },
    );
    const set = moveSet(legalMoves(s, CFG));
    expect(set.has('M:4,4>3,4')).toBe(false); // 잡기 불가
    expect(set.has('M:4,4>3,3')).toBe(true); // 대각선 이동 가능
  });

  it('slide 모드: 호위가 직선으로 미끄러지고 첫 상대 호위에서 멈춰 잡는다', () => {
    const cfg: RuleConfig = { ...CFG, guardMove: 'slide' };
    const s = makeState(
      [
        [8, 0, 'BLACK', 'KING'],
        [0, 0, 'WHITE', 'KING'],
        [4, 1, 'BLACK', 'GUARD'],
        [4, 5, 'WHITE', 'GUARD'],
      ],
      'BLACK',
      { BLACK: 0, WHITE: 0 },
    );
    const set = moveSet(legalMoves(s, cfg));
    expect(set.has('M:4,1>4,4')).toBe(true); // 빈 칸 슬라이드
    expect(set.has('M:4,1>4,5')).toBe(true); // 잡기에서 멈춤
    expect(set.has('M:4,1>4,6')).toBe(false); // 통과 불가
  });
});

describe('호위 목적지 금지 (noGuardOnGoal, 기본 켬)', () => {
  const cfg: RuleConfig = { ...DEFAULT_CONFIG };

  it('자기 진영 끝줄 중앙(=상대 목적지)에는 착수할 수 없다', () => {
    const s = initialState(cfg);
    const set = moveSet(legalMoves(s, cfg));
    expect(set.has('P:7,4')).toBe(true); // 일반 칸은 가능
    expect(set.has('P:8,3')).toBe(false); // 백의 목적지 칸
    expect(set.has('P:8,5')).toBe(false);
  });

  it('호위는 목적지 칸으로 이동할 수 없지만 왕은 들어갈 수 있다', () => {
    const s = makeState(
      [
        [1, 3, 'BLACK', 'GUARD'],
        [1, 5, 'BLACK', 'KING'],
        [4, 8, 'WHITE', 'KING'],
      ],
      'BLACK',
      { BLACK: 0, WHITE: 0 },
      cfg,
    );
    const set = moveSet(legalMoves(s, cfg));
    expect(set.has('M:1,3>0,3')).toBe(false); // 호위 → 흑 목적지 진입 금지
    expect(set.has('M:1,3>1,2')).toBe(true); // 일반 이동은 가능
    expect(set.has('M:1,5>0,5')).toBe(true); // 왕은 목적지 진입 가능
  });

  it('규칙을 끄면 목적지 칸에도 착수할 수 있다', () => {
    const s = initialState({ ...cfg, noGuardOnGoal: false });
    const set = moveSet(legalMoves(s, { ...cfg, noGuardOnGoal: false }));
    expect(set.has('P:8,3')).toBe(true);
  });
});

describe('왕 잡기 (kingCapture, 기본 켬)', () => {
  const cfg: RuleConfig = { ...DEFAULT_CONFIG };

  it('호위가 상대 왕을 잡으면 즉시 승리한다', () => {
    const s = makeState(
      [
        [4, 4, 'WHITE', 'KING'],
        [4, 5, 'BLACK', 'GUARD'],
        [8, 0, 'BLACK', 'KING'],
      ],
      'BLACK',
      { BLACK: 0, WHITE: 0 },
      cfg,
    );
    const set = moveSet(legalMoves(s, cfg));
    expect(set.has('M:4,5>4,4')).toBe(true);
    const s2 = applyMove(s, { kind: 'MOVE', from: { r: 4, c: 5 }, to: { r: 4, c: 4 } });
    expect(getResult(s2, cfg)).toEqual({ winner: 'BLACK', reason: 'capture' });
  });

  it('목적지 칸 위의 왕도 잡을 수 있다 (목적지 금지의 예외)', () => {
    // 백 왕이 시작점 e9 = 흑의 목적지 칸에 눌러앉아 있어도 잡기 가능해야 한다
    const s = makeState(
      [
        [0, 4, 'WHITE', 'KING'],
        [1, 4, 'BLACK', 'GUARD'],
        [8, 0, 'BLACK', 'KING'],
      ],
      'BLACK',
      { BLACK: 0, WHITE: 0 },
      cfg,
    );
    expect(moveSet(legalMoves(s, cfg)).has('M:1,4>0,4')).toBe(true);
  });

  it('왕은 여전히 잡기를 할 수 없다', () => {
    const s = makeState(
      [
        [4, 4, 'BLACK', 'KING'],
        [4, 5, 'WHITE', 'GUARD'],
        [0, 0, 'WHITE', 'KING'],
      ],
      'BLACK',
      { BLACK: 0, WHITE: 0 },
      cfg,
    );
    expect(moveSet(legalMoves(s, cfg)).has('M:4,4>4,5')).toBe(false);
  });
});

describe('승패 판정', () => {
  it('왕이 목적지(중앙 3칸)에 도달하면 승리', () => {
    const s = makeState(
      [
        [1, 4, 'BLACK', 'KING'],
        [8, 0, 'WHITE', 'KING'],
      ],
      'BLACK',
      { BLACK: 0, WHITE: 0 },
    );
    const s2 = applyMove(s, { kind: 'MOVE', from: { r: 1, c: 4 }, to: { r: 0, c: 4 } });
    expect(getResult(s2, CFG)).toEqual({ winner: 'BLACK', reason: 'goal' });
  });

  it('목적지가 아닌 끝줄 칸은 승리가 아니다', () => {
    const s = makeState(
      [
        [0, 0, 'BLACK', 'KING'], // 끝줄이지만 중앙 3칸 밖
        [8, 8, 'WHITE', 'KING'],
      ],
      'WHITE',
      { BLACK: 8, WHITE: 8 },
    );
    expect(getResult(s, CFG)).toBeNull();
  });

  it('왕이 상하좌우로 포위되면 패배', () => {
    const s = makeState(
      [
        [0, 4, 'WHITE', 'KING'],
        [0, 3, 'BLACK', 'GUARD'],
        [0, 5, 'BLACK', 'GUARD'],
        [1, 4, 'BLACK', 'GUARD'],
        [8, 4, 'BLACK', 'KING'],
      ],
      'WHITE',
      { BLACK: 0, WHITE: 8 },
    );
    expect(getResult(s, CFG)).toEqual({ winner: 'BLACK', reason: 'surround' });
    // 규칙을 끄면 패배가 아니다
    expect(getResult(s, { ...CFG, kingSurroundLoss: false })).toBeNull();
  });

  it('동형 국면 3회 반복 시 반복을 만든 쪽이 패배', () => {
    let s = makeState(
      [
        [8, 4, 'BLACK', 'KING'],
        [0, 4, 'WHITE', 'KING'],
      ],
      'BLACK',
      { BLACK: 0, WHITE: 0 },
    );
    const cycle: Move[] = [
      { kind: 'MOVE', from: { r: 8, c: 4 }, to: { r: 8, c: 3 } },
      { kind: 'MOVE', from: { r: 0, c: 4 }, to: { r: 0, c: 3 } },
      { kind: 'MOVE', from: { r: 8, c: 3 }, to: { r: 8, c: 4 } },
      { kind: 'MOVE', from: { r: 0, c: 3 }, to: { r: 0, c: 4 } },
    ];
    // 2바퀴 돌면 초기 국면이 3번째 등장 — 마지막 수는 백
    for (let lap = 0; lap < 2; lap++) {
      for (const m of cycle) {
        expect(getResult(s, CFG)).toBeNull();
        s = applyMove(s, m);
      }
    }
    expect(getResult(s, CFG)).toEqual({ winner: 'BLACK', reason: 'repetition' });
  });
});
