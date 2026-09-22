import { applyMove } from '../src/core/apply';
import type { RuleConfig } from '../src/core/config';
import { getResult, type GameResult } from '../src/core/result';
import { findKing, legalMoves, opponent, ORTHO } from '../src/core/rules';
import type { Coord, GameState, Move, Player } from '../src/core/types';
import { jevMoveId } from './jevPolicy';

export const JEV_DEVELOPMENT_BRIEFING_VERSION = 'jev-development-briefing-v1' as const;

export interface JevDevelopmentSideSnapshot {
  player: Player;
  king: Coord | null;
  deployedGuards: Coord[];
  reserveGuards: number;
}

export interface JevDeploymentGeometry {
  placementRule: RuleConfig['placement'];
  reserveGuards: number;
  legalCells: Coord[];
  /** Friendly guards that seed adjacent placements independently of the king. */
  kingIndependentGuardAnchors: Coord[];
  /** Legal cells adjacent to at least one friendly guard, including cells also adjacent to the king. */
  guardSupportedCells: Coord[];
  /** Legal cells adjacent to the friendly king and to no friendly guard. */
  kingOnlyCells: Coord[];
  /** Legal cells supplied by a non-adjacent placement rule rather than by a piece anchor. */
  ruleOnlyCells: Coord[];
}

export interface JevDevelopmentCandidateBriefing {
  id: string;
  move: Move;
  terminal: GameResult | null;
  afterAction: {
    self: JevDevelopmentSideSnapshot;
    opponent: JevDevelopmentSideSnapshot;
  };
  futureSelfTurnDeployment: (JevDeploymentGeometry & {
    newCells: Coord[];
    lostCells: Coord[];
  }) | null;
}

export interface JevDevelopmentBriefing {
  version: typeof JEV_DEVELOPMENT_BRIEFING_VERSION;
  scope: 'bounded-factual-guard-infrastructure';
  selfPlayer: Player;
  semantics: {
    coordinates: string;
    categories: string;
    futureTiming: string;
    limits: string;
    candidateHandling: string;
  };
  current: {
    terminal: GameResult | null;
    self: JevDevelopmentSideSnapshot;
    opponent: JevDevelopmentSideSnapshot;
    deployment: JevDeploymentGeometry;
  };
  candidates: JevDevelopmentCandidateBriefing[];
}

const coordKey = (coord: Coord) => `${coord.r},${coord.c}`;

function sortedCoords(coords: Iterable<Coord>): Coord[] {
  return Array.from(coords, ({ r, c }) => ({ r, c }))
    .sort((a, b) => a.r - b.r || a.c - b.c);
}

function guardCells(state: GameState, player: Player): Coord[] {
  const cells: Coord[] = [];
  for (let r = 0; r < state.board.length; r++) {
    for (let c = 0; c < state.board[r]!.length; c++) {
      const piece = state.board[r]![c];
      if (piece?.player === player && piece.type === 'GUARD') cells.push({ r, c });
    }
  }
  return sortedCoords(cells);
}

function sideSnapshot(state: GameState, player: Player): JevDevelopmentSideSnapshot {
  return {
    player,
    king: findKing(state, player),
    deployedGuards: guardCells(state, player),
    reserveGuards: state.guardsInHand[player],
  };
}

/** Classifies canonical PLACE actions; it does not generate placement legality itself. */
function deploymentGeometry(
  state: GameState,
  config: RuleConfig,
  player: Player,
): JevDeploymentGeometry {
  const playerTurnState = state.turn === player ? state : { ...state, turn: player };
  const legalCells = sortedCoords(legalMoves(playerTurnState, config).flatMap((move) => (
    move.kind === 'PLACE' ? [move.to] : []
  )));
  const anchors = config.placement === 'adjacent' ? guardCells(state, player) : [];
  const guardSupportedCells: Coord[] = [];
  const kingOnlyCells: Coord[] = [];
  const ruleOnlyCells: Coord[] = [];

  for (const cell of legalCells) {
    if (config.placement !== 'adjacent') {
      ruleOnlyCells.push(cell);
      continue;
    }
    let byGuard = false;
    let byKing = false;
    for (const [dr, dc] of ORTHO) {
      const piece = state.board[cell.r + dr]?.[cell.c + dc];
      if (piece?.player !== player) continue;
      if (piece.type === 'GUARD') byGuard = true;
      else byKing = true;
    }
    if (byGuard) guardSupportedCells.push(cell);
    else if (byKing) kingOnlyCells.push(cell);
    else ruleOnlyCells.push(cell);
  }

  return {
    placementRule: config.placement,
    reserveGuards: state.guardsInHand[player],
    legalCells,
    kingIndependentGuardAnchors: anchors,
    guardSupportedCells: sortedCoords(guardSupportedCells),
    kingOnlyCells: sortedCoords(kingOnlyCells),
    ruleOnlyCells: sortedCoords(ruleOnlyCells),
  };
}

function difference(left: Coord[], right: Coord[]): Coord[] {
  const rightKeys = new Set(right.map(coordKey));
  return left.filter((coord) => !rightKeys.has(coordKey(coord)));
}

/**
 * Produces facts for a parent prompt without scoring or selecting moves.
 * Candidate rows are emitted only for the caller-supplied legal moves, in input order.
 */
export function buildJevDevelopmentBriefing(
  state: GameState,
  config: RuleConfig,
  candidateMoves: Move[] = [],
): JevDevelopmentBriefing {
  const self = state.turn;
  const enemy = opponent(self);
  const currentDeployment = deploymentGeometry(state, config, self);
  const canonicalById = new Map(legalMoves(state, config).map((move) => [jevMoveId(move), move]));
  const candidateIds = candidateMoves.map(jevMoveId);
  if (new Set(candidateIds).size !== candidateIds.length) {
    throw new Error('Development briefing candidates must be unique');
  }
  if (getResult(state, config) && candidateMoves.length) {
    throw new Error('Development briefing cannot analyze candidates after the game has ended');
  }

  const candidates = candidateMoves.map((_, index): JevDevelopmentCandidateBriefing => {
    const id = candidateIds[index]!;
    const move = canonicalById.get(id);
    if (!move) throw new Error(`Development briefing candidate is not legal: ${id}`);
    const after = applyMove(state, move);
    const terminal = getResult(after, config);
    const afterAction = {
      self: sideSnapshot(after, self),
      opponent: sideSnapshot(after, enemy),
    };
    if (terminal) return { id, move, terminal, afterAction, futureSelfTurnDeployment: null };

    // This turn substitution asks the canonical move generator a bounded geometry
    // question. It is not applied as another game action.
    const future = deploymentGeometry(after, config, self);
    return {
      id,
      move,
      terminal: null,
      afterAction,
      futureSelfTurnDeployment: {
        ...future,
        newCells: difference(future.legalCells, currentDeployment.legalCells),
        lostCells: difference(currentDeployment.legalCells, future.legalCells),
      },
    };
  });

  return {
    version: JEV_DEVELOPMENT_BRIEFING_VERSION,
    scope: 'bounded-factual-guard-infrastructure',
    selfPlayer: self,
    semantics: {
      coordinates: 'All {r,c} coordinates are zero-based and match JEV move IDs.',
      categories: 'guardSupportedCells are canonical legal placements adjacent to at least one SELF guard; kingOnlyCells depend only on adjacency to the SELF king. kingIndependentGuardAnchors are deployed guards, not extra actions.',
      futureTiming: 'For each nonterminal candidate, applyMove is used once. futureSelfTurnDeployment then asks canonical legalMoves for a static counterfactual next SELF turn with no OPPONENT response. It is not a legal same-player extra turn; an actual response can change every listed cell.',
      limits: 'This is placement geometry, not safety, a blocking guarantee, a forced line, or a whole-tree proof. New/lost cells are relative to the current legal placement cells only.',
      candidateHandling: 'Only caller-supplied candidates are shown, in caller order. No score, ranking, filtering, recommendation, or move override is produced.',
    },
    current: {
      terminal: getResult(state, config),
      self: sideSnapshot(state, self),
      opponent: sideSnapshot(state, enemy),
      deployment: currentDeployment,
    },
    candidates,
  };
}
