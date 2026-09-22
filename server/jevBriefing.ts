import type { RuleConfig } from '../src/core/config';
import { findKing, opponent } from '../src/core/rules';
import type { GameState, Move, Player } from '../src/core/types';
import type { JevRoutePair, JevStateFacts } from './jevAnalysis';
import { describeJevState } from './jev';
import type { JevPressureAnalysis } from './jevPressure';

export const JEV_BRIEFING_VERSION = 'mongjin-briefing-5';

/** Human coaching is a strategic prior, not a new rule or a forced opening. */
export const JEV_DEVELOPMENT_PLAN = [
  'Opening plan: establish useful guard deployment anchors BEFORE rushing the king. An undeveloped king rush can let the opponent approach while we have no guard line to intercept it; repeated capture threats can then consume every turn we needed for deployment. Prefer building that infrastructure early over merely reducing frozen king distance.',
  'Develop a connected guard line toward the opponent approach, threaten its king, and cover sideways bypasses as needed. New guards preserve deployment access after our king leaves. Judge the concrete cells and enemy routes, not the number of guards or placement cells. A guard line is not impenetrable: the opponent can detour, deploy, capture and exchange guards.',
  'Convert the delay into our king progress once interception holds long enough. Before advancing, identify the next enemy approach or flank bypass and our guard answer. Preserve our king exit and route. A deployment spends a turn, so its worse frozen race is NOT by itself a reason to deploy again. More placement cells are not progress by themselves. Add a guard only for a concrete interception, protection or breakthrough benefit; otherwise advance or open our route.',
  'An immediate win, an urgent king escape, or a concretely supported breakthrough overrides the opening preference. This plan is human strategic guidance, not a proven winning opening. Exact rules and terminal proofs take priority; JEV still selects the final action.',
] as const;
const cell = (at: { r: number; c: number }) => `(${at.r},${at.c})`;

export function describeJevAction(state: GameState, move: Move): string {
  if (move.kind === 'PLACE') return `Deploy one reserve SELF guard at ${cell(move.to)}. SELF king stays in place; OPPONENT acts next.`;
  const piece = state.board[move.from.r]?.[move.from.c];
  const target = state.board[move.to.r]?.[move.to.c];
  return `Move SELF ${piece?.type === 'KING' ? 'king' : 'guard'} ${cell(move.from)} -> ${cell(move.to)}.`
    + (target ? ` Capture OPPONENT ${target.type.toLowerCase()}.` : '')
    + ' OPPONENT acts next.';
}

/** Describes the actual config; strategic guidance is separate from game rules. */
export function buildJevBriefing(state: GameState, config: RuleConfig) {
  const other = opponent(state.turn);
  const position = describeJevState(state, config);
  const guardCells = (player: Player) => state.board.flatMap((row, r) => row.flatMap((piece, c) =>
    piece?.player === player && piece.type === 'GUARD' ? [cell({ r, c })] : []));
  return {
    version: JEV_BRIEFING_VERSION,
    game: 'Mongjin: a two-player king race with deployable guards. You choose one action for SELF now.',
    win: 'Win immediately by reaching a SELF goal with the SELF king, or by an enabled capture/surround/no-move win. Reaching a goal ends the game before the opponent can reply. Shorter distance alone is not victory.',
    turnEconomy: 'Players alternate. ONE action per turn: move the king, move a deployed guard, OR deploy one reserve guard. You cannot advance the king and deploy a guard on the same turn. After our action, the opponent can move OR deploy too.',
    exactRules: [...position.rules,
      'Kings cannot capture any piece, including a lone enemy guard; they cannot jump over an occupied cell.',
      'Unlike chess, kings do NOT attack neighboring cells and may stand directly next to each other, orthogonally or diagonally. Enemy king proximity alone does not make a destination unsafe. An occupied king square also prevents guard deployment on that square.',
      'A captured guard is removed permanently, not returned to reserve. Deployment transfers one guard from reserve onto the board.',
      'A legal action can leave its own king threatened. Legal does not mean safe; the opponent can exploit the threat on its next turn.',
      ...(config.placement === 'adjacent' ? ['Both sides can deploy adjacent to ANY friendly king or guard, including on the opponent half. New guards become new deployment anchors on later turns. A line of guards can therefore grow toward and chase a king.'] : []),
    ],
    position: {
      ...position, rules: undefined, selfPlayer: state.turn, opponentPlayer: other,
      selfKing: findKing(state, state.turn), opponentKing: findKing(state, other),
      selfDeployedGuards: guardCells(state.turn), opponentDeployedGuards: guardCells(other),
    },
    decisionGuide: [
      ...JEV_DEVELOPMENT_PLAN,
      'Judge the position AFTER the opponent best plausible response, including guard deployment. A free-looking forward square can become a trap or the start of a sideways/backward chase.',
      'Compare developing a guard now with postponing it. Once a king is repeatedly threatened, there may be no free turn left to deploy. A guard is useful only if it blocks, protects, supports another guard, or creates a capture threat; an unsupported sacrifice can waste a turn.',
      'Threatening our king costs the opponent an action too: they cannot deploy a guard AND advance their king on that turn. A safely answered threat is not automatically a lost race. Likewise, avoiding every hypothetical threat by deploying guards can hand the opponent a winning race. Compare both kings arrival timing and actual replies together.',
      'If SELF is behind in a simple king race, continuing the same race cannot catch up without changing the paths: block the opponent, open our route, or create a forcing threat. Guard material is a means to winning, not a score objective.',
      'Frozen-board distances ignore future moves and deployments. The future-ply race estimate assumes both kings follow those static routes with all other pieces frozen. It is not a secured path or a proof. Search examples show possible lines, not promises; consult pressure examples for counterplay omitted by the main line.',
    ],
  };
}

export function briefJevRoutes(routes: JevRoutePair, selfActsNext: boolean) {
  const route = (side: JevRoutePair['own']) => ({ status: side.status, kingMoves: side.distance,
    firstStepExamples: side.firstSteps, reason: side.reason });
  const arrival = (side: JevRoutePair['own'], actsNext: boolean) => side.status !== 'reachable' || side.distance === null
    ? null : side.distance === 0 ? 0 : 2 * side.distance - (actsNext ? 1 : 0);
  return {
    self: route(routes.own), opponent: route(routes.opponent),
    frozenRaceFuturePlies: { self: arrival(routes.own, selfActsNext), opponent: arrival(routes.opponent, !selfActsNext) },
  };
}

export function briefJevFacts(facts: JevStateFacts | null, selfActsNext: boolean) {
  return facts ? { terminal: facts.terminal, totalGuardsIncludingReserve: facts.material,
    frozenRoutes: briefJevRoutes(facts.routes, selfActsNext), complete: facts.complete } : null;
}

export function describeJevRace(routes: JevRoutePair, selfActsNext: boolean): string {
  const estimate = briefJevRoutes(routes, selfActsNext);
  const timing = (side: 'self' | 'opponent') => estimate.frozenRaceFuturePlies[side] === null
    ? `${side.toUpperCase()}: ${estimate[side].status}, arrival unknown`
    : `${side.toUpperCase()}: ${estimate[side].kingMoves} king moves, arrival in ${estimate.frozenRaceFuturePlies[side]} alternating plies`;
  return `Frozen-board race estimate (${selfActsNext ? 'SELF' : 'OPPONENT'} acts next): ${timing('self')}; ${timing('opponent')}. Future guard moves or deployments can change these routes; this is not a win proof.`;
}

/** Put the concrete tactical distinction next to the option being evaluated. */
export function describeJevPressure(entry: JevPressureAnalysis['candidates'][number] | undefined): string {
  if (!entry) return 'Opponent capture-pressure analysis: not checked.';
  if (!entry.examples.length) return entry.complete
    ? 'No immediate king-capture threat was created by the checked opponent replies; longer threats remain unknown.'
    : 'Opponent pressure analysis incomplete; absence of examples does not establish safety.';
  return entry.examples.map((example) => {
    const reply = example.opponentReply;
    const action = reply.kind === 'PLACE' ? `deploy a guard at ${cell(reply.to)}`
      : `move ${cell(reply.from)} -> ${cell(reply.to)}`;
    const forward = example.safeResponses.filter((r) => r.advancesRow).length;
    const otherKing = example.safeResponses.filter((r) => r.action === 'king' && !r.advancesRow).length;
    const guard = example.safeResponses.filter((r) => r.action === 'guard').length;
    const wins = example.safeResponses.filter((r) => r.immediateWin).length;
    return `OPPONENT can ${action}, threatening king capture if unanswered. `
      + `Of ${example.checkedResponses}/${example.totalResponses} SELF responses checked, next-reply-safe choices: `
      + `${forward} forward king, ${otherKing} sideways/backward king, ${guard} guard actions (including ${wins} immediate wins). `
      + (example.responsesComplete ? 'All responses checked for this example; later safety unknown.' : 'Unchecked responses remain unknown.');
  }).join(' ');
}
