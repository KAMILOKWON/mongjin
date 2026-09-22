import { createHash } from 'node:crypto';
import type { GameState, Move } from '../src/core/types';

export const JEV_PARALLEL_POLICY = {
  version: 'parallel-v18', rulesVersion: 'mongjin-core-1', protocolVersion: 1,
  turnLimitMs: 30_000, maxPlies: 240, targetP95Ms: 8_000,
  factsBudgetMs: 2_000, proposalBudgetMs: 8_000, searchBudgetMs: 3_000,
  searchProposalBudgetMs: 4_300,
  finalBudgetMs: 8_000, maxDepth: 4, maxNodes: 100_000, maxReproposals: 1,
  terminalProofDepth: 8,
  maxGuardAlternatives: 2,
  maxKingLaneAlternatives: 3,
  pressureBudgetMs: 1_000, pressureMaxNodes: 20_000,
  rolloutBudgetMs: 4_000, rolloutMaxPlies: 8, rolloutDecisionNodes: 64,
  // Provisional until fixed-condition timing measurements; never claim these targets were achieved.
  budgetStatus: 'provisional',
} as const;

export const JEV_ROLES = [
  { id: 'survival', purpose: 'Reduce the risk of our king being captured or surrounded and preserve escape routes. Compare deploying a guard with moving the king again; repeated retreat can surrender the goal race.', priority: 'Should preserving or opening our king escape routes take priority now?' },
  { id: 'blocking', purpose: 'Build guard deployment anchors early, before the kings meet, then intercept the opposing king approach and sideways bypasses. Compare a persistent guard line with rushing our undeveloped king. Delay the opponent long enough to advance our king; do not wait until their goal is one move away.', priority: 'Should developing or extending our guard interception line take priority now?' },
  { id: 'breakthrough', purpose: 'Open an obstructed route for our king, using guards to challenge opposing blockers where useful. Compare developing a guard with repeatedly moving the king around the same obstacle.', priority: 'Should using guards to open a currently blocked route take priority now?' },
  { id: 'exchange', purpose: 'Find a favorable guard exchange, considering the opponent recapture and both reserves and deployed guards.', priority: 'Is there a favorable guard exchange opportunity now, after considering recapture?' },
  { id: 'advance', purpose: 'Find a timely king advance after considering guard preparation. Shorter frozen distance is insufficient: identify how our guards will answer the opposing king approach or bypass. In an undeveloped opening, abstain when building a guard anchor should come first. Immediate wins and urgent escapes remain valid.', priority: 'Is now the time to advance our king rather than establish or extend guard interception?' },
  { id: 'general', purpose: 'Choose the move most likely to help us win against resistance. Apply the development plan: establish guard anchors before an unsupported king rush, intercept the enemy approach, then use the delay for our king. Check concrete counterplay and stop building when king progress is better.', priority: null },
] as const;

export function jevMoveId(move: Move): string {
  return move.kind === 'PLACE' ? `p_${move.to.r}_${move.to.c}` : `m_${move.from.r}_${move.from.c}_${move.to.r}_${move.to.c}`;
}

export function jevStateHash(state: GameState): string {
  return createHash('sha256').update(JSON.stringify({
    board: state.board.map((row) => row.map((piece) => piece ? `${piece.player}:${piece.type}` : null)),
    turn: state.turn, guards: [state.guardsInHand.BLACK, state.guardsInHand.WHITE],
    history: state.history.map(jevMoveId),
    positions: Object.entries(state.positionCounts).sort(([a], [b]) => a.localeCompare(b)),
  })).digest('hex');
}
