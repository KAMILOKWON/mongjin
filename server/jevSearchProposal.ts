import { chooseMove, type AiSearchStats } from '../src/ai/ai';
import { strict as assert } from 'node:assert';
import { applyMove } from '../src/core/apply';
import type { RuleConfig } from '../src/core/config';
import { getResult } from '../src/core/result';
import { legalMoves } from '../src/core/rules';
import type { GameState, Move } from '../src/core/types';
import { JevError } from './jev';
import { jevMoveId, jevStateHash } from './jevPolicy';
import { replyHorizon } from './jevReplyRollouts';

export const JEV_SEARCH_PROPOSAL_LIMITS = { maxMs: 4_300, maxDepth: 14, maxNodes: 100_000,
  choiceWindow: 2, planStrength: 1.7, strategyLevel: 3, elite: true } as const;

/** One extra alternative, never a filter, proof, vote, or final move override. */
export function analyzeJevSearchProposal(state: GameState, config: RuleConfig,
  options: { deadlineMs: number; signal?: AbortSignal; choose?: typeof chooseMove }) {
  if (!Number.isFinite(options.deadlineMs)) throw new Error('Invalid search proposal deadline');
  if (options.signal?.aborted) throw new JevError('aborted', 'Search proposal cancelled');
  const maxMs = Math.min(JEV_SEARCH_PROPOSAL_LIMITS.maxMs, options.deadlineMs - Date.now());
  if (maxMs <= 0 || getResult(state, config)) return null;
  const capture: { search?: AiSearchStats; line?: Move[] } = {};
  const move = (options.choose ?? chooseMove)(structuredClone(state), config, {
    ...JEV_SEARCH_PROPOSAL_LIMITS, maxMs, botSide: state.turn,
    onSearchComplete: stats => { capture.search = stats; },
    onContinuation: line => { capture.line = structuredClone(line); },
  });
  if (options.signal?.aborted) throw new JevError('aborted', 'Search proposal cancelled');
  if (!move || !capture.search || !capture.line?.length) throw new Error('Missing search proposal evidence');
  const id = jevMoveId(move);
  if (jevMoveId(capture.line[0]!) !== id) throw new Error('Search proposal line differs from its move');
  let end = state;
  for (const item of capture.line) {
    if (getResult(end, config)) throw new Error('Search proposal continued past terminal');
    const canonical = legalMoves(end, config).find(m => jevMoveId(m) === jevMoveId(item));
    if (!canonical) throw new Error('Illegal search proposal line');
    end = applyMove(end, canonical);
  }
  const terminal = getResult(end, config);
  const result = { version: 'jev-search-proposal-1' as const,
    scope: 'one-classical-proposal-with-conditional-tt-line-not-proof' as const,
    rootHash: jevStateHash(state), id, move, line: capture.line, search: capture.search,
    limits: { ...JEV_SEARCH_PROPOSAL_LIMITS, maxMs }, terminal,
    horizon: replyHorizon(end, state.turn, !!terminal) };
  verifyJevSearchProposal(state, config, result);
  return result;
}

export function verifyJevSearchProposal(state: GameState, config: RuleConfig,
  proposal: NonNullable<ReturnType<typeof analyzeJevSearchProposal>>): void {
  assert.equal(proposal.version, 'jev-search-proposal-1');
  assert.equal(proposal.scope, 'one-classical-proposal-with-conditional-tt-line-not-proof');
  assert.equal(proposal.rootHash, jevStateHash(state));
  assert.equal(proposal.id, jevMoveId(proposal.move));
  for (const [key, value] of Object.entries(JEV_SEARCH_PROPOSAL_LIMITS)) {
    if (key !== 'maxMs') assert.equal(proposal.limits[key as keyof typeof proposal.limits], value);
  }
  assert(proposal.limits.maxMs > 0 && proposal.limits.maxMs <= JEV_SEARCH_PROPOSAL_LIMITS.maxMs);
  assert(Number.isSafeInteger(proposal.search.completedDepth) && proposal.search.completedDepth >= 0
    && proposal.search.completedDepth <= proposal.limits.maxDepth);
  assert(Number.isSafeInteger(proposal.search.nodes) && proposal.search.nodes >= 0 && proposal.search.nodes <= proposal.limits.maxNodes);
  assert(Number.isFinite(proposal.search.elapsedMs) && proposal.search.elapsedMs >= 0 && typeof proposal.search.aborted === 'boolean');
  assert(Array.isArray(proposal.line) && proposal.line.length > 0
    && proposal.line.length <= Math.max(1, proposal.search.completedDepth));
  assert.equal(jevMoveId(proposal.line[0]!), proposal.id);
  let end = state;
  for (const move of proposal.line) {
    assert(!getResult(end, config));
    const canonical = legalMoves(end, config).find(m => jevMoveId(m) === jevMoveId(move));
    assert(canonical); end = applyMove(end, canonical);
  }
  const terminal = getResult(end, config);
  assert.deepEqual(proposal.terminal, terminal);
  assert.deepEqual(proposal.horizon, replyHorizon(end, state.turn, !!terminal));
}

export function briefJevSearchProposal(proposal: ReturnType<typeof analyzeJevSearchProposal>) {
  if (!proposal) return null;
  return { id: proposal.id, exampleLine: proposal.line.map(jevMoveId), search: proposal.search,
    limits: proposal.limits, conditionalTerminal: proposal.terminal, horizon: proposal.horizon,
    meaning: 'One classical search alternative with a legal example continuation. Not a second model vote, mandatory choice, or exact win/loss proof. The line follows transposition-table moves and may reflect a later partial iteration or bound. Other replies and future plans remain possible. Compare its actual consequences with every other candidate; your final ID is still played unchanged.' };
}
