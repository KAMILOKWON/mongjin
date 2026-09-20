import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState, legalMoves } from '../src/core/rules';
import { applyMove } from '../src/core/apply';
import { getResult } from '../src/core/result';
import type { Move } from '../src/core/types';
import { analyzeJevPressure } from './jevPressure';
import { jevMoveId } from './jevPolicy';

const record = JSON.parse(readFileSync(new URL('./fixtures/jev-first-loss.json', import.meta.url), 'utf8')) as { moves: Move[] };
let state = initialState(DEFAULT_CONFIG);
for (const move of record.moves.slice(0, 6)) state = applyMove(state, move);
const moves = legalMoves(state, DEFAULT_CONFIG).filter((m) => ['m_5_4_4_3', 'p_4_4'].includes(jevMoveId(m)));
const options = () => ({ deadlineMs: Date.now() + 5_000, maxNodes: 20_000 });

it('exposes the recorded king chase omitted by the heuristic PV and verifies each safe response', () => {
  const result = analyzeJevPressure(state, DEFAULT_CONFIG, moves, options());
  expect(result.complete).toBe(true);
  const chase = result.candidates.find((c) => c.id === 'm_5_4_4_3')!.examples
    .find((e) => jevMoveId(e.opponentReply) === 'p_3_3')!;
  expect(chase.responsesComplete).toBe(true);
  expect(chase.safeResponses.length).toBeGreaterThan(0);
  expect(chase.safeResponses.every((r) => r.action === 'king' && !r.advancesRow)).toBe(true);
  for (const entry of result.candidates) {
    const after = applyMove(state, moves.find((m) => jevMoveId(m) === entry.id)!);
    expect(entry.checkedOpponentReplies).toBe(entry.totalOpponentReplies);
    for (const example of entry.examples) {
      expect(legalMoves(after, DEFAULT_CONFIG).map(jevMoveId)).toContain(jevMoveId(example.opponentReply));
      const threat = applyMove(after, example.opponentReply);
      for (const capture of example.captureThreatsIfUnanswered) {
        const virtual = { ...threat, turn: after.turn };
        expect(legalMoves(virtual, DEFAULT_CONFIG).map(jevMoveId)).toContain(jevMoveId(capture));
        expect(getResult(applyMove(virtual, capture), DEFAULT_CONFIG)?.winner).toBe(after.turn);
      }
      for (const response of example.safeResponses) {
        expect(legalMoves(threat, DEFAULT_CONFIG).map(jevMoveId)).toContain(jevMoveId(response.move));
        const escaped = applyMove(threat, response.move);
        if (getResult(escaped, DEFAULT_CONFIG)?.winner === state.turn) continue;
        expect(legalMoves(escaped, DEFAULT_CONFIG).every((reply) =>
          getResult(applyMove(escaped, reply), DEFAULT_CONFIG)?.winner !== after.turn)).toBe(true);
      }
    }
  }
});

it('reports incomplete pressure analysis at its node budget without asserting missing replies safe', () => {
  const result = analyzeJevPressure(state, DEFAULT_CONFIG, moves, { ...options(), maxNodes: 12 });
  expect(result).toMatchObject({ complete: false, stopReason: 'node-budget', nodes: 12 });
  expect(result.candidates.some((c) => !c.complete)).toBe(true);
});

it.each(['deadline', 'aborted'] as const)('stops pressure analysis on %s', (reason) => {
  const result = analyzeJevPressure(state, DEFAULT_CONFIG, moves, {
    ...options(), deadlineMs: reason === 'deadline' ? Date.now() - 1 : Date.now() + 1_000,
    signal: reason === 'aborted' ? AbortSignal.abort() : undefined,
  });
  expect(result).toMatchObject({ complete: false, stopReason: reason, nodes: 0 });
});

it('rejects illegal candidate moves', () => {
  expect(() => analyzeJevPressure(state, DEFAULT_CONFIG, [{ kind: 'PLACE', to: { r: -1, c: 0 } }], options())).toThrow();
});
