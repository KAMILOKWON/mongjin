import { describe, expect, it } from 'vitest';
import { applyMove } from '../src/core/apply';
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState, legalMoves } from '../src/core/rules';
import type { GameState } from '../src/core/types';
import { analyzeJevFacts } from './jevAnalysis';
import { getJevThreatEscapeIds } from './jevEscapeCoverage';
import { jevMoveId } from './jevPolicy';

function play(state: GameState, id: string): GameState {
  const move = legalMoves(state, DEFAULT_CONFIG).find((candidate) => jevMoveId(candidate) === id);
  if (!move) throw new Error(`Expected legal setup move ${id}`);
  return applyMove(state, move);
}

function threatenedWhiteState(): GameState {
  let state = initialState(DEFAULT_CONFIG);
  for (const id of [
    'm_8_4_7_4',
    'm_0_4_1_4',
    'm_7_4_6_4',
    'm_1_4_2_4',
    'm_6_4_5_4',
    'm_2_4_3_4',
    'p_4_4',
  ]) state = play(state, id);
  return state;
}

function factsFor(state: GameState) {
  return analyzeJevFacts(state, DEFAULT_CONFIG, { deadlineMs: Date.now() + 5_000 });
}

describe('JEV threatened-king escape proposal coverage', () => {
  it('includes every completely checked safe king escape, including sideways and backward moves', () => {
    const state = threatenedWhiteState();
    const ids = getJevThreatEscapeIds(state, DEFAULT_CONFIG, factsFor(state));

    expect(ids).toEqual([
      'm_3_4_2_3',
      'm_3_4_2_4',
      'm_3_4_2_5',
      'm_3_4_3_3',
      'm_3_4_3_5',
    ]);
    expect(ids).toContain('m_3_4_3_3');
    expect(ids).toContain('m_3_4_3_5');
    expect(ids).toContain('m_3_4_2_4');
    expect(ids).not.toContain('m_3_4_4_3');
    expect(ids).not.toContain('m_3_4_4_5');
  });

  it('returns no coverage when the current king has no canonical capture threat', () => {
    const state = initialState(DEFAULT_CONFIG);
    expect(getJevThreatEscapeIds(state, DEFAULT_CONFIG, factsFor(state))).toEqual([]);
  });

  it('does not advertise an incompletely checked escape as safe', () => {
    const state = threatenedWhiteState();
    const facts = factsFor(state);
    const incomplete = facts.candidates.find((candidate) => jevMoveId(candidate.move) === 'm_3_4_3_3');
    if (!incomplete) throw new Error('Expected sideways escape facts');
    incomplete.repliesComplete = false;

    const ids = getJevThreatEscapeIds(state, DEFAULT_CONFIG, facts);
    expect(ids).not.toContain('m_3_4_3_3');
    expect(ids).toContain('m_3_4_3_5');
  });
});
