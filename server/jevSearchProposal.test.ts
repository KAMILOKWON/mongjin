import { describe, expect, it } from 'vitest';
import { initialState, legalMoves } from '../src/core/rules';
import { DEFAULT_CONFIG } from '../src/core/config';
import { applyMove } from '../src/core/apply';
import type { Move } from '../src/core/types';
import { analyzeJevSearchProposal, briefJevSearchProposal, verifyJevSearchProposal } from './jevSearchProposal';

const state = initialState(DEFAULT_CONFIG);
const move: Move = { kind: 'PLACE', to: { r: 7, c: 4 } };
function fixture(line?: Move[]) {
  const reply = legalMoves(applyMove(state, move), DEFAULT_CONFIG)[0]!;
  return analyzeJevSearchProposal(state, DEFAULT_CONFIG, { deadlineMs: Date.now() + 100,
    choose: (_state, _config, options) => {
      options?.onSearchComplete?.({ nodes: 12, completedDepth: 2, elapsedMs: 1, aborted: false });
      options?.onContinuation?.(line ?? [move, reply]);
      return move;
    } })!;
}
describe('classical search proposal evidence', () => {
  it('records a canonical conditional line and no evaluation score without mutating the root', () => {
    const before = structuredClone(state); const proposal = fixture();
    expect(() => verifyJevSearchProposal(state, DEFAULT_CONFIG, proposal)).not.toThrow();
    const brief = briefJevSearchProposal(proposal)!;
    expect(brief.id).toBe('p_7_4');
    expect(brief.exampleLine).toHaveLength(2);
    expect(brief.meaning).toContain('Not a second model vote, mandatory choice, or exact win/loss proof');
    expect(JSON.stringify(brief)).not.toMatch(/"score"|BEST|LOWER/);
    expect(state).toEqual(before);
  });
  it('rejects changed roots, illegal continuation and falsified terminal or horizon data', () => {
    expect(() => fixture([{ kind: 'PLACE', to: { r: 6, c: 6 } }])).toThrow();
    for (const tamper of [
      (p: ReturnType<typeof fixture>) => { p.rootHash = 'wrong'; },
      (p: ReturnType<typeof fixture>) => { p.horizon.selfReserve = 999; },
      (p: ReturnType<typeof fixture>) => { p.terminal = { winner: 'BLACK', reason: 'goal' }; },
      (p: ReturnType<typeof fixture>) => { p.line[1] = { kind: 'PLACE', to: { r: 6, c: 6 } }; },
    ]) {
      const proposal = fixture(); tamper(proposal);
      expect(() => verifyJevSearchProposal(state, DEFAULT_CONFIG, proposal)).toThrow();
    }
  });
  it('does not search after cancellation or an exhausted allocation', () => {
    const controller = new AbortController(); controller.abort();
    const choose = () => { throw new Error('should not run'); };
    expect(() => analyzeJevSearchProposal(state, DEFAULT_CONFIG, { deadlineMs: Date.now() + 100,
      signal: controller.signal, choose })).toThrow('cancelled');
    expect(analyzeJevSearchProposal(state, DEFAULT_CONFIG, { deadlineMs: Date.now() - 1, choose })).toBeNull();
  });
});
