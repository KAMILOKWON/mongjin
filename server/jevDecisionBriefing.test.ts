import { describe, expect, it } from 'vitest';
import { initialState, legalMoves } from '../src/core/rules';
import { DEFAULT_CONFIG } from '../src/core/config';
import { applyMove } from '../src/core/apply';
import { analyzeJevFacts, type JevAnalyzedCandidate } from './jevAnalysis';
import { analyzeJevPressure } from './jevPressure';
import { analyzeJevReplyRollouts } from './jevReplyRollouts';
import { jevMoveId } from './jevPolicy';
import { buildJevDecisionBriefing } from './jevDecisionBriefing';

function fixture() {
  let state = initialState(DEFAULT_CONFIG);
  for (const id of ['m_8_4_7_4', 'm_0_4_1_4', 'm_7_4_6_4', 'm_1_4_2_4', 'm_6_4_5_4']) {
    state = applyMove(state, legalMoves(state, DEFAULT_CONFIG).find(m => jevMoveId(m) === id)!);
  }
  const ids = ['m_2_4_3_4', 'm_2_4_3_3', 'p_3_4'];
  const moves = legalMoves(state, DEFAULT_CONFIG).filter(m => ids.includes(jevMoveId(m)));
  const facts = analyzeJevFacts(state, DEFAULT_CONFIG, { deadlineMs: Date.now() + 2_000 });
  const candidates: JevAnalyzedCandidate[] = moves.map(move => {
    const f = facts.candidates.find(c => jevMoveId(c.move) === jevMoveId(move))!;
    return { move, score: 987654321, searchedDepth: 1, proven: 'unknown', proof: null,
      principalVariation: [move], afterFacts: { terminal: null, material: f.material, routes: f.routes, complete: true },
      horizonFacts: null, extension: null };
  });
  const pressure = analyzeJevPressure(state, DEFAULT_CONFIG, moves, { deadlineMs: Date.now() + 2_000, maxNodes: 20_000 });
  const rollouts = analyzeJevReplyRollouts(state, DEFAULT_CONFIG, moves, { deadlineMs: Date.now() + 2_000, maxPlies: 2 });
  return { state, candidates, pressure, rollouts };
}

describe('action-centred JEV decision evidence', () => {
  it('puts a verified chase beside its option without labelling untested future play safe', () => {
    const f = fixture();
    const out = buildJevDecisionBriefing(f.state, DEFAULT_CONFIG, f.candidates, f.pressure, f.rollouts, [], []);
    const card = out.state.decisionCards.find(c => c.id === 'm_2_4_3_4')!;
    const threat = card.opponentCapturePressure.examples.find(e => e.opponentReply === 'p_4_4')!;
    expect(threat.allResponsesChecked).toBe(true);
    expect(threat.safeResponseCounts[0]).toBe(0);
    expect(threat.safeResponseCounts[3]).toBe(0);
    expect(threat.consequence).toBe('only-sideways-or-backward-king');
    expect(out.questions.move.criteria.m_2_4_3_4).toContain('no safe forward king or guard response');
    expect(out.questions.move.criteria.m_2_4_3_3).toContain('longer threats unknown');
    expect(JSON.stringify(out)).not.toMatch(/987654321|"score"|BEST|LOWER/);
    expect(new Set(Object.keys(out.questions.move.criteria))).toEqual(new Set(f.candidates.map(c => jevMoveId(c.move))));
  });

  it('preserves every first reply and exact horizon including reserves through table encoding', () => {
    const f = fixture();
    const out = buildJevDecisionBriefing(f.state, DEFAULT_CONFIG, f.candidates, f.pressure, f.rollouts, [], []);
    const brief = out.state.conditionalContinuations;
    for (const candidate of f.rollouts.candidates) {
      const encoded = brief.candidates.find(c => c.id === candidate.id)!;
      expect(encoded.replies).toHaveLength(candidate.scenarios.length);
      for (const [i, scenario] of candidate.scenarios.entries()) {
        const row = encoded.replies[i]!;
        expect(brief.replyIds[row[0] as number]).toBe(jevMoveId(scenario.forcedReply!));
        const horizon = brief.horizons[row[2] as number] as any[];
        const h = scenario.horizon!;
        const cell = (p: {r: number; c: number} | null) => p ? `${p.r},${p.c}` : null;
        expect([horizon[0], horizon[1], brief.guardSets[horizon[2]], brief.guardSets[horizon[3]], ...horizon.slice(4)])
          .toEqual([cell(h.selfKing), cell(h.opponentKing), h.selfGuards.map(cell), h.opponentGuards.map(cell),
            h.selfReserve, h.opponentReserve, h.nextPlayer === null ? null : h.nextPlayer === f.state.turn ? 'SELF' : 'OPPONENT']);
      }
    }
  });

  it('does not promote incomplete response checks to a forced sideways/backward response', () => {
    const f = fixture();
    const entry = f.pressure.candidates.find(c => c.id === 'm_2_4_3_4')!;
    entry.complete = false;
    entry.examples.forEach(e => { e.responsesComplete = false; });
    const out = buildJevDecisionBriefing(f.state, DEFAULT_CONFIG, f.candidates, f.pressure, f.rollouts, [], []);
    expect(out.questions.move.criteria.m_2_4_3_4).not.toContain('no safe forward');
    expect(out.state.decisionCards.find(c => c.id === 'm_2_4_3_4')!.opponentCapturePressure.examples[0]!.consequence).toBe('incomplete');
  });

  it('keeps an earlier exact proof source separate from a newer shallower search', () => {
    const f = fixture();
    const candidate = f.candidates[0]!;
    const retained = { id: jevMoveId(candidate.move), proven: 'loss' as const,
      proof: { winner: 'BLACK' as const, reason: 'capture' as const, plies: 4 },
      searchedDepth: 4, sourceSearch: 0, principalVariation: [candidate.move] };
    const out = buildJevDecisionBriefing(f.state, DEFAULT_CONFIG, f.candidates, f.pressure, f.rollouts, [retained], []);
    const card = out.state.decisionCards.find(c => c.id === retained.id)!;
    expect(card.search).toMatchObject({ completedDepth: 1, proven: 'unknown', proof: null });
    expect(card.retainedTerminalProof).toEqual({ proven: 'loss', proof: retained.proof, searchedDepth: 4, sourceSearch: 0,
      proofLine: retained.principalVariation.map(jevMoveId) });
  });
});
