import { describe, expect, it, vi } from 'vitest';
import { applyMove } from '../src/core/apply';
import { DEFAULT_CONFIG } from '../src/core/config';
import { getResult } from '../src/core/result';
import { initialState, legalMoves } from '../src/core/rules';
import { jevMoveId } from './jevPolicy';
import { analyzeJevReplyRollouts, replySearchSummary } from './jevReplyRollouts';
import { verifyJevReplyRollouts } from './jevReplyRolloutReplay';
import { briefJevRollouts } from './jevRolloutBriefing';
import type { JevRolloutChooseMove } from './jevRollouts';

const first: JevRolloutChooseMove = (state, config, options) => {
  options.onSearchComplete?.({ nodes: 1, completedDepth: 1, elapsedMs: 0, aborted: false });
  return legalMoves(state, config)[0] ?? null;
};

describe('all-reply continuations', () => {
  it('retains every legal first reply including quiet guard deployments at equal depth', () => {
    const root = initialState(DEFAULT_CONFIG);
    const original = structuredClone(root);
    const moves = legalMoves(root, DEFAULT_CONFIG).slice(0, 3);
    const data = analyzeJevReplyRollouts(root, DEFAULT_CONFIG, moves, {
      deadlineMs: Date.now() + 5_000, maxPlies: 4, choose: first,
    });
    expect(root).toEqual(original);
    expect(data).toMatchObject({ complete: true, commonCompletedPlies: 4, firstReplyCoverage: 'all-legal' });
    for (const c of data.candidates) {
      const replies = legalMoves(applyMove(root, c.move), DEFAULT_CONFIG).map(jevMoveId).sort();
      expect(c.scenarios.map(s => jevMoveId(s.forcedReply!)).sort()).toEqual(replies);
      expect(c.scenarios.some(s => s.forcedReply?.kind === 'PLACE')).toBe(true);
      expect(c.scenarios.every(s => s.terminal || s.plies === 4)).toBe(true);
    }
    expect(() => verifyJevReplyRollouts(root, DEFAULT_CONFIG, data, moves.map(jevMoveId))).not.toThrow();
    const briefing = briefJevRollouts(data, root.turn);
    expect(briefing.meaning).toContain('not probabilities');
    expect(JSON.stringify(briefing)).toContain('selfGuardCells');
  });

  it('discards a partial breadth round instead of selectively displaying the first favorable lines', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const root = initialState(DEFAULT_CONFIG);
      const moves = legalMoves(root, DEFAULT_CONFIG).slice(0, 2);
      let calls = 0;
      const data = analyzeJevReplyRollouts(root, DEFAULT_CONFIG, moves, {
        deadlineMs: 100, maxPlies: 8,
        choose: (s, c, o) => { if (++calls === 3) vi.setSystemTime(101); return first(s, c, o); },
      });
      expect(data).toMatchObject({ complete: false, stopReason: 'deadline', commonCompletedPlies: 2 });
      expect(data.candidates.flatMap(c => c.scenarios).every(s => s.plies === 2 && s.decisions.length === 0)).toBe(true);
      expect(() => verifyJevReplyRollouts(root, DEFAULT_CONFIG, data)).not.toThrow();
    } finally { vi.useRealTimers(); }
  });

  it('rejects omitted replies, fabricated horizon facts and illegal continuation moves', () => {
    const root = initialState(DEFAULT_CONFIG);
    const moves = legalMoves(root, DEFAULT_CONFIG).slice(0, 1);
    const data = analyzeJevReplyRollouts(root, DEFAULT_CONFIG, moves, { deadlineMs: Date.now() + 5_000, maxPlies: 3, choose: first });
    const omitted = structuredClone(data); omitted.candidates[0]!.scenarios.pop();
    expect(() => verifyJevReplyRollouts(root, DEFAULT_CONFIG, omitted)).toThrow();
    const facts = structuredClone(data); facts.candidates[0]!.scenarios[0]!.horizon!.selfKing = { r: 90, c: 90 };
    expect(() => verifyJevReplyRollouts(root, DEFAULT_CONFIG, facts)).toThrow();
    const illegal = structuredClone(data); illegal.candidates[0]!.scenarios[0]!.line[2] = { kind: 'PLACE', to: { r: 90, c: 90 } };
    expect(() => verifyJevReplyRollouts(root, DEFAULT_CONFIG, illegal)).toThrow();
  });

  it('rejects removed search records even when the attacker recomputes the summary', () => {
    const root = initialState(DEFAULT_CONFIG);
    const data = analyzeJevReplyRollouts(root, DEFAULT_CONFIG, legalMoves(root, DEFAULT_CONFIG).slice(0, 1), {
      deadlineMs: Date.now() + 1000, maxPlies: 3, choose: first,
    });
    const scenario = data.candidates[0]!.scenarios.find(s => s.decisions.length)!;
    scenario.decisions[0]!.search = null; scenario.decisions[0]!.cutoff = null;
    scenario.searchSummary = replySearchSummary(scenario.decisions);
    expect(() => verifyJevReplyRollouts(root, DEFAULT_CONFIG, data)).toThrow();
  });

  it('retains exact terminal root outcomes without inventing an opponent turn', () => {
    const config = { ...DEFAULT_CONFIG, boardSize: 3, guardCount: 0, goalCells: 'full-row' as const };
    const root = initialState(config);
    root.board = [[null, null, { player: 'WHITE', type: 'KING' }], [{ player: 'BLACK', type: 'KING' }, null, null], [null, null, null]];
    const winning = legalMoves(root, config).find(m => getResult(applyMove(root, m), config)?.winner === root.turn);
    expect(winning).toBeDefined();
    const data = analyzeJevReplyRollouts(root, config, [winning!], { deadlineMs: Date.now() + 1000 });
    expect(data.candidates[0]!.scenarios).toHaveLength(1);
    expect(data.candidates[0]!.scenarios[0]).toMatchObject({ forcedReply: null, plies: 1, status: 'terminal' });
    expect(() => verifyJevReplyRollouts(root, config, data)).not.toThrow();
  });
});
