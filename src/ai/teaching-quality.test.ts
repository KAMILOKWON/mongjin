import { describe, expect, it } from 'vitest';
import { applyMove } from '../core/apply';
import { DEFAULT_CONFIG } from '../core/config';
import { getResult } from '../core/result';
import {
  findKing,
  goalCellsFor,
  legalMoves,
  opponent,
  positionKey,
} from '../core/rules';
import type { GameState, Move, Piece, Player } from '../core/types';
import {
  AI_DIFFICULTY_PRESETS,
  type AiDifficulty,
} from '../game/settings';
import { chooseMove, type AiOptions } from './ai';

const CFG = { ...DEFAULT_CONFIG };
const DIFFICULTIES: AiDifficulty[] = ['easy', 'normal', 'hard'];
const SIDES: Player[] = ['BLACK', 'WHITE'];
const PRESET_SIDE_CASES = DIFFICULTIES.flatMap((difficulty, difficultyIndex) =>
  SIDES.map((side, sideIndex) => ({
    difficulty,
    side,
    seed: 10_000 + difficultyIndex * 100 + sideIndex,
  })),
);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function optionsFor(difficulty: AiDifficulty, seed: number): AiOptions {
  const preset = AI_DIFFICULTY_PRESETS[difficulty];
  return {
    maxMs: 5_000,
    maxDepth: preset.maxDepth,
    // 시간 대신 노드 수로 결과를 고정하고, 전술 픽스처의 총 실행 시간을 제한한다.
    maxNodes: Math.min(preset.maxNodes, difficulty === 'hard' ? 4_000 : 2_000),
    rootNoise: preset.rootNoise,
    choiceWindow: preset.choiceWindow,
    planStrength: preset.planStrength,
    strategyLevel: preset.strategyLevel,
    elite: preset.elite,
    rng: mulberry32(seed),
  };
}

function makeState(
  pieces: Array<[number, number, Player, Piece['type']]>,
  turn: Player,
  hands: Record<Player, number> = { BLACK: 0, WHITE: 0 },
): GameState {
  const board: (Piece | null)[][] = Array.from(
    { length: CFG.boardSize },
    () => Array.from({ length: CFG.boardSize }, () => null),
  );
  for (const [r, c, player, type] of pieces) {
    board[r]![c] = { player, type };
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

function orientedRow(side: Player, blackRow: number): number {
  return side === 'BLACK' ? blackRow : CFG.boardSize - 1 - blackRow;
}

function winningMoves(state: GameState, winner: Player): Move[] {
  return legalMoves(state, CFG).filter(
    (move) => getResult(applyMove(state, move), CFG)?.winner === winner,
  );
}

function safeDefenses(state: GameState): Move[] {
  const attacker = opponent(state.turn);
  return legalMoves(state, CFG).filter((move) => {
    const next = applyMove(state, move);
    return winningMoves(next, attacker).length === 0;
  });
}

function goalDistance(state: GameState, player: Player): number {
  const king = findKing(state, player);
  expect(king).not.toBeNull();
  return Math.min(
    ...goalCellsFor(player, CFG).map((goal) =>
      Math.max(Math.abs(goal.r - king!.r), Math.abs(goal.c - king!.c)),
    ),
  );
}

function advancingKingMoves(state: GameState, player: Player): Move[] {
  const before = goalDistance(state, player);
  return legalMoves(state, CFG).filter((move) => {
    if (move.kind !== 'MOVE') return false;
    const piece = state.board[move.from.r]![move.from.c];
    return piece?.player === player && piece.type === 'KING' &&
      goalDistance(applyMove(state, move), player) < before;
  });
}

/** 상대 왕이 전진한 뒤 즉시 잡히지 않고 살아남는 돌진 수. */
function safeRushReplies(state: GameState, rusher: Player): Move[] {
  const defender = opponent(rusher);
  return advancingKingMoves(state, rusher).filter((rush) => {
    const afterRush = applyMove(state, rush);
    if (getResult(afterRush, CFG)?.winner === rusher) return true;
    return winningMoves(afterRush, defender).length === 0;
  });
}

function markSuccessorsRepeated(state: GameState, moves: Move[]): void {
  for (const move of moves) {
    state.positionCounts[positionKey(applyMove(state, move))] = 2;
  }
}

function stateWithGuardShuttleHistory(player: Player): {
  state: GameState;
  repeatedShuttle: Move;
} {
  const guardRow = orientedRow(player, 7);
  const enemyKingRow = orientedRow(player, 2);
  let state = makeState(
    [
      [orientedRow(player, 6), 4, player, 'KING'],
      [guardRow, 0, player, 'GUARD'],
      [enemyKingRow, 4, opponent(player), 'KING'],
    ],
    player,
  );
  const repeatedShuttle: Move = {
    kind: 'MOVE',
    from: { r: guardRow, c: 0 },
    to: { r: guardRow, c: 1 },
  };
  const cycle: Move[] = [
    repeatedShuttle,
    {
      kind: 'MOVE',
      from: { r: enemyKingRow, c: 4 },
      to: { r: enemyKingRow, c: 5 },
    },
    {
      kind: 'MOVE',
      from: { r: guardRow, c: 1 },
      to: { r: guardRow, c: 0 },
    },
    {
      kind: 'MOVE',
      from: { r: enemyKingRow, c: 5 },
      to: { r: enemyKingRow, c: 4 },
    },
  ];
  for (let lap = 0; lap < 2; lap++) {
    for (const move of cycle) {
      expect(legalMoves(state, CFG)).toContainEqual(move);
      state = applyMove(state, move);
      expect(getResult(state, CFG)).toBeNull();
    }
  }
  return { state, repeatedShuttle };
}

function expectChosenMove(
  state: GameState,
  difficulty: AiDifficulty,
  seed: number,
): Move {
  const chosen = chooseMove(
    state,
    CFG,
    optionsFor(difficulty, seed),
  );
  expect(chosen).not.toBeNull();
  return chosen!;
}

describe('공유 AI의 규칙 교육 품질', () => {
  it.each(PRESET_SIDE_CASES)(
    '$difficulty/$side: 중앙에서 왕을 지나치기 전에 호위로 상대 돌진로를 줄인다',
    ({ difficulty, side: defender }) => {
      const rusher = opponent(defender);
      const state = makeState(
        [
          [orientedRow(defender, 5), 4, defender, 'KING'],
          [4, 4, rusher, 'KING'],
        ],
        defender,
        { BLACK: 8, WHITE: 8 },
      );
      const crossingMoves = advancingKingMoves(state, defender);
      expect(crossingMoves.length).toBeGreaterThan(0);
      const crossingRushReplies = Math.min(
        ...crossingMoves.map((move) =>
          safeRushReplies(applyMove(state, move), rusher).length,
        ),
      );

      // 대칭 국면은 같은 난수열로 비교해 진영에 따른 우연한 선택 차이를 없앤다.
      const preset = optionsFor(
        difficulty,
        10_000 + DIFFICULTIES.indexOf(difficulty) * 100,
      );
      let completedDepth = 0;
      const chosen = chooseMove(state, CFG, {
        ...preset,
        maxNodes: difficulty === 'easy' ? 1_500 : difficulty === 'normal' ? 6_000 : 8_000,
        onSearchComplete: (stats) => {
          completedDepth = stats.completedDepth;
        },
      });
      expect(chosen).not.toBeNull();
      expect(completedDepth).toBeGreaterThanOrEqual(2);
      expect(chosen?.kind).toBe('PLACE');
      expect(safeRushReplies(applyMove(state, chosen!), rusher).length).toBeLessThan(
        crossingRushReplies,
      );
    },
  );

  it.each(PRESET_SIDE_CASES)(
    '$difficulty/$side: 호위로 알몸 왕 돌진의 안전한 전진을 끊는다',
    ({ difficulty, side: defender, seed }) => {
      const rusher = opponent(defender);
      const state = makeState(
        [
          [orientedRow(defender, 5), 0, defender, 'KING'],
          [orientedRow(defender, 7), 3, defender, 'GUARD'],
          [orientedRow(defender, 6), 4, rusher, 'KING'],
        ],
        defender,
      );

      const interceptions = legalMoves(state, CFG).filter((move) => {
        const piece = move.kind === 'MOVE'
          ? state.board[move.from.r]![move.from.c]
          : null;
        return piece?.type === 'GUARD' &&
          safeRushReplies(applyMove(state, move), rusher).length === 0;
      });
      const ineffectiveMoves = legalMoves(state, CFG).filter(
        (move) => safeRushReplies(applyMove(state, move), rusher).length > 0,
      );
      expect(interceptions.length).toBeGreaterThan(0);
      expect(ineffectiveMoves.length).toBeGreaterThan(0);

      const chosen = expectChosenMove(state, difficulty, seed);
      expect(chosen.kind).toBe('MOVE');
      if (chosen.kind === 'MOVE') {
        expect(state.board[chosen.from.r]![chosen.from.c]?.type).toBe('GUARD');
      }
      expect(safeRushReplies(applyMove(state, chosen), rusher)).toHaveLength(0);
    },
  );

  it.each(PRESET_SIDE_CASES)(
    '$difficulty/$side: 호위가 위협받는 왕을 직접 보호한다',
    ({ difficulty, side: defender, seed }) => {
      const attacker = opponent(defender);
      const state = makeState(
        [
          [4, 4, defender, 'KING'],
          [4, 5, attacker, 'GUARD'],
          [5, 5, defender, 'GUARD'],
          [3, 3, defender, 'GUARD'],
          [3, 4, defender, 'GUARD'],
          [4, 3, defender, 'GUARD'],
          [5, 3, defender, 'GUARD'],
          [5, 4, defender, 'GUARD'],
          [orientedRow(defender, 8), 0, attacker, 'KING'],
        ],
        defender,
      );

      const defenses = safeDefenses(state);
      expect(defenses).toHaveLength(1);
      const defense = defenses[0]!;
      expect(defense.kind).toBe('MOVE');
      if (defense.kind === 'MOVE') {
        expect(state.board[defense.from.r]![defense.from.c]?.type).toBe('GUARD');
        expect(state.board[defense.to.r]![defense.to.c]).toEqual({
          player: attacker,
          type: 'GUARD',
        });
      }

      const chosen = expectChosenMove(state, difficulty, seed);
      expect(winningMoves(applyMove(state, chosen), attacker)).toHaveLength(0);
    },
  );

  it.each(PRESET_SIDE_CASES)(
    '$difficulty/$side: 반복 후보여도 즉시 승리를 우선한다',
    ({ difficulty, side: winner, seed }) => {
      const loser = opponent(winner);
      const state = makeState(
        [
          [orientedRow(winner, 1), 4, winner, 'KING'],
          [orientedRow(winner, 7), 0, loser, 'KING'],
        ],
        winner,
      );
      const wins = winningMoves(state, winner);
      expect(wins.length).toBeGreaterThan(0);
      expect(wins.length).toBeLessThan(legalMoves(state, CFG).length);
      markSuccessorsRepeated(state, wins);

      const chosen = expectChosenMove(state, difficulty, seed);
      expect(getResult(applyMove(state, chosen), CFG)?.winner).toBe(winner);
    },
  );

  it.each(PRESET_SIDE_CASES)(
    '$difficulty/$side: 반복 후보뿐이어도 유일한 방어 후퇴를 보존한다',
    ({ difficulty, side: defender, seed }) => {
      const attacker = opponent(defender);
      const state = makeState(
        [
          [4, 4, defender, 'KING'],
          [orientedRow(defender, 3), 4, attacker, 'GUARD'],
          [4, 3, attacker, 'GUARD'],
          [4, 5, attacker, 'GUARD'],
          [orientedRow(defender, 0), 0, attacker, 'KING'],
        ],
        defender,
      );
      const defenses = safeDefenses(state);
      expect(defenses).toHaveLength(1);
      const retreat = defenses[0]!;
      expect(retreat.kind).toBe('MOVE');
      if (retreat.kind === 'MOVE') {
        expect(state.board[retreat.from.r]![retreat.from.c]?.type).toBe('KING');
        expect(goalDistance(applyMove(state, retreat), defender)).toBeGreaterThan(
          goalDistance(state, defender),
        );
      }
      markSuccessorsRepeated(state, defenses);

      const chosen = expectChosenMove(state, difficulty, seed);
      expect(winningMoves(applyMove(state, chosen), attacker)).toHaveLength(0);
    },
  );

  it.each(PRESET_SIDE_CASES)(
    '$difficulty/$side: 실제 호위 왕복 이력을 반복하지 않고 왕을 전진시킨다',
    ({ difficulty, side: player, seed }) => {
      const { state, repeatedShuttle } = stateWithGuardShuttleHistory(player);
      const before = goalDistance(state, player);
      const repeatedKey = positionKey(applyMove(state, repeatedShuttle));
      expect(state.history).toHaveLength(8);
      expect(state.positionCounts[positionKey(state)]).toBe(3);
      expect(state.positionCounts[repeatedKey]).toBe(2);
      expect(advancingKingMoves(state, player).length).toBeGreaterThan(0);

      const chosen = expectChosenMove(state, difficulty, seed);
      const next = applyMove(state, chosen);
      expect(positionKey(next)).not.toBe(repeatedKey);
      expect(goalDistance(next, player)).toBeLessThan(before);
    },
  );
});
