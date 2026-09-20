import { chooseMove, type AiOptions, type AiSearchStats } from '../src/ai/ai';
import { applyMove } from '../src/core/apply';
import type { RuleConfig } from '../src/core/config';
import { getResult, type GameResult } from '../src/core/result';
import { legalMoves } from '../src/core/rules';
import type { GameState, Move, Player } from '../src/core/types';
import { jevMoveId } from './jevPolicy';
import {
  chooseJevGuardPressureMove,
  JEV_GUARD_PRESSURE_POLICY_VERSION,
  type JevGuardPressureDecision,
  type JevGuardPressureSource,
  type JevGuardPressureStopReason,
} from './jevPressurePolicy';

export const JEV_ROLLOUT_VERSION = 'jev-rollouts-v3' as const;
export const JEV_ROLLOUT_SCOPE = 'conditional-policy-continuations-not-proofs' as const;

export type JevRolloutVersion = 'jev-rollouts-v1' | typeof JEV_ROLLOUT_VERSION;
export type JevRolloutStopReason = 'complete' | 'deadline' | 'aborted' | 'policy-cutoff';
export type JevRolloutStatus = 'terminal' | 'ply-cap' | 'deadline' | 'aborted' | 'policy-cutoff';
export type JevRolloutPolicyId = 'self-tactical' | 'opponent-runner' | 'opponent-guard-pressure';

export interface JevRolloutPolicyDefinition {
  id: JevRolloutPolicyId;
  role: 'self' | 'opponent';
  options: {
    method: 'choose-move' | 'guard-pressure';
    maxDepth: 3;
    maxNodes: number;
    maxMsPerDecision: 30;
    choiceWindow: 0;
    planStrength: 0 | 1;
    strategyLevel: 1 | 3;
    elite: boolean;
    rng: 'disabled';
    botSide: 'current-turn';
    pressureTransitionBudget: null | {
      version: typeof JEV_GUARD_PRESSURE_POLICY_VERSION;
      maxNodes: 2_048;
      fallbackMaxNodes: number;
      fallbackMaxDepth: 3;
      fallbackMaxMs: 30;
    };
  };
}

export interface JevRolloutPressureMetadata {
  version: typeof JEV_GUARD_PRESSURE_POLICY_VERSION;
  source: JevGuardPressureSource;
  stats: {
    complete: boolean;
    stopReason: JevGuardPressureStopReason;
    nodes: number;
    deadlineMs: number;
    maxNodes: number;
    legalMoves: number;
    evaluatedAfterstates: number;
    pressureCandidates: number;
    eligiblePressureCandidates: number;
    selectedId: string | null;
    fallback: {
      called: boolean;
      requestedMaxMs: number | null;
      requestedMaxNodes: number | null;
      delegatedMaxMs: number | null;
      delegatedMaxNodes: number | null;
      search: AiSearchStats | null;
    };
  };
}

export interface JevRolloutDecision {
  /** Zero-based index in the returned line; the forced root is index zero. */
  linePly: number;
  player: Player;
  policyId: JevRolloutPolicyId;
  move: Move;
  applied: boolean;
  budget: {
    deadlineMs: number;
    maxMs: number;
    maxDepth: 3;
    maxNodes: number;
  };
  search: AiSearchStats | null;
  cutoff: 'node-budget' | 'time-budget' | null;
  pressure: JevRolloutPressureMetadata | null;
}

export interface JevRolloutPolicyCutoff {
  linePly: number;
  player: Player;
  policyId: 'opponent-guard-pressure';
  pressure: JevRolloutPressureMetadata;
}

export interface JevRolloutSearchSummary {
  decisions: number;
  totalNodes: number;
  minCompletedDepth: number | null;
  maxCompletedDepth: number | null;
  abortedSearches: number;
  nodeBudgetCutoffs: number;
  timeBudgetCutoffs: number;
}

export interface JevRolloutScenario {
  id: string;
  opponentPolicyId: Extract<JevRolloutPolicyId, `opponent-${string}`>;
  /** Canonical legal line. The first move is always the candidate root move. */
  line: Move[];
  plies: number;
  status: JevRolloutStatus;
  terminal: GameResult | null;
  decisions: JevRolloutDecision[];
  searchSummary: JevRolloutSearchSummary;
  policyCutoff: JevRolloutPolicyCutoff | null;
}

export interface JevRolloutCandidate {
  id: string;
  move: Move;
  commonCompletedPlies: number;
  scenarios: JevRolloutScenario[];
}

export interface JevRolloutAnalysis {
  /** v1 remains in the union so replay can type-check archived v10 artifacts. */
  version: JevRolloutVersion;
  scope: typeof JEV_ROLLOUT_SCOPE;
  rootPlayer: Player;
  complete: boolean;
  incomplete: boolean;
  stopReason: JevRolloutStopReason;
  commonCompletedPlies: number;
  limits: {
    deadlineMs: number;
    maxPlies: number;
    maxNodesPerDecision: number;
    maxDepth: 3;
    maxMsPerDecision: 30;
    scenarioCount: number;
  };
  policyDefinitions: JevRolloutPolicyDefinition[];
  candidates: JevRolloutCandidate[];
}

export type JevRolloutChooseMove = (
  state: GameState,
  config: RuleConfig,
  options: AiOptions,
) => Move | null;

export interface JevRolloutOptions {
  /** Absolute Date.now() deadline shared by every candidate and scenario. */
  deadlineMs: number;
  /** Total moves in each returned line, including the forced root move. */
  maxPlies?: number;
  maxNodesPerDecision?: number;
  signal?: AbortSignal;
  /** Deterministic test seam; production callers should use canonical chooseMove. */
  choose?: JevRolloutChooseMove;
}

export const JEV_ROLLOUT_LIMITS = {
  defaultMaxPlies: 40,
  maxPlies: 40,
  defaultMaxNodesPerDecision: 128,
  maxNodesPerDecision: 4_096,
  maxDepth: 3,
  maxMsPerDecision: 30,
  guardPressureMaxNodes: 2_048,
  guardPressureFallbackMaxNodes: 128,
} as const;

interface MutableScenario {
  candidateIndex: number;
  output: JevRolloutScenario;
  state: GameState;
  status: JevRolloutStatus | null;
}

const SELF_POLICY = {
  id: 'self-tactical', role: 'self', choiceWindow: 0,
  planStrength: 1, strategyLevel: 3, elite: true,
} as const;

const OPPONENT_POLICIES = [
  {
    id: 'opponent-runner', role: 'opponent', choiceWindow: 0,
    planStrength: 0, strategyLevel: 1, elite: false,
  },
  {
    id: 'opponent-guard-pressure', role: 'opponent', choiceWindow: 0,
    planStrength: 1, strategyLevel: 3, elite: true,
  },
] as const;

function policyDefinition(
  policy: typeof SELF_POLICY | (typeof OPPONENT_POLICIES)[number],
  maxNodes: number,
): JevRolloutPolicyDefinition {
  const pressure = policy.id === 'opponent-guard-pressure';
  const fallbackMaxNodes = Math.min(
    maxNodes,
    JEV_ROLLOUT_LIMITS.guardPressureFallbackMaxNodes,
  );
  return {
    id: policy.id,
    role: policy.role,
    options: {
      method: pressure ? 'guard-pressure' : 'choose-move',
      maxDepth: JEV_ROLLOUT_LIMITS.maxDepth,
      maxNodes: pressure ? fallbackMaxNodes : maxNodes,
      maxMsPerDecision: JEV_ROLLOUT_LIMITS.maxMsPerDecision,
      choiceWindow: policy.choiceWindow,
      planStrength: policy.planStrength,
      strategyLevel: policy.strategyLevel,
      elite: policy.elite,
      rng: 'disabled',
      botSide: 'current-turn',
      pressureTransitionBudget: pressure ? {
        version: JEV_GUARD_PRESSURE_POLICY_VERSION,
        maxNodes: JEV_ROLLOUT_LIMITS.guardPressureMaxNodes,
        fallbackMaxNodes,
        fallbackMaxDepth: JEV_ROLLOUT_LIMITS.maxDepth,
        fallbackMaxMs: JEV_ROLLOUT_LIMITS.maxMsPerDecision,
      } : null,
    },
  };
}

function pressureMetadata(
  decision: JevGuardPressureDecision,
  delegatedFallback: { maxMs: number | null; maxNodes: number | null },
): JevRolloutPressureMetadata {
  const { stats } = decision;
  return {
    version: stats.version,
    source: decision.source,
    stats: {
      complete: stats.complete,
      stopReason: stats.stopReason,
      nodes: stats.nodes,
      deadlineMs: stats.limits.deadlineMs,
      maxNodes: stats.limits.maxNodes,
      legalMoves: stats.legalMoves,
      evaluatedAfterstates: stats.evaluatedAfterstates,
      pressureCandidates: stats.pressureCandidates.length,
      eligiblePressureCandidates: stats.pressureCandidates.filter((candidate) => candidate.eligible).length,
      selectedId: stats.selected?.id ?? null,
      fallback: {
        called: stats.fallback.called,
        requestedMaxMs: stats.fallback.maxMs,
        requestedMaxNodes: stats.fallback.maxNodes,
        delegatedMaxMs: delegatedFallback.maxMs,
        delegatedMaxNodes: delegatedFallback.maxNodes,
        search: stats.fallback.search,
      },
    },
  };
}

function summarizeSearch(decisions: JevRolloutDecision[]): JevRolloutSearchSummary {
  const searches = decisions.flatMap((decision) => decision.search ? [decision.search] : []);
  return {
    decisions: decisions.length,
    totalNodes: searches.reduce((total, search) => total + search.nodes, 0),
    minCompletedDepth: searches.length
      ? Math.min(...searches.map((search) => search.completedDepth))
      : null,
    maxCompletedDepth: searches.length
      ? Math.max(...searches.map((search) => search.completedDepth))
      : null,
    abortedSearches: searches.filter((search) => search.aborted).length,
    nodeBudgetCutoffs: decisions.filter((decision) => decision.cutoff === 'node-budget').length,
    timeBudgetCutoffs: decisions.filter((decision) => decision.cutoff === 'time-budget').length,
  };
}

function validateLimit(name: string, value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`JEV rollouts ${name} must be an integer from 1 to ${maximum}`);
  }
}

/**
 * Runs deterministic, bounded policy continuations as supplementary evidence.
 * Results are conditional on the logged policies and budgets: they are not
 * proofs, scores, candidate filters, win probabilities, or a root selection.
 */
export function analyzeJevRollouts(
  state: GameState,
  config: RuleConfig,
  moves: Move[],
  options: JevRolloutOptions,
): JevRolloutAnalysis {
  if (!Number.isFinite(options.deadlineMs)) {
    throw new Error('JEV rollouts require a finite deadlineMs');
  }
  const maxPlies = options.maxPlies ?? JEV_ROLLOUT_LIMITS.defaultMaxPlies;
  const maxNodes = options.maxNodesPerDecision
    ?? JEV_ROLLOUT_LIMITS.defaultMaxNodesPerDecision;
  validateLimit('maxPlies', maxPlies, JEV_ROLLOUT_LIMITS.maxPlies);
  validateLimit(
    'maxNodesPerDecision',
    maxNodes,
    JEV_ROLLOUT_LIMITS.maxNodesPerDecision,
  );
  if (getResult(state, config)) throw new Error('JEV rollouts cannot analyze a terminal state');
  if (moves.length === 0) throw new Error('JEV rollouts require at least one root move');

  const canonicalById = new Map(legalMoves(state, config).map((move) => [jevMoveId(move), move]));
  const ids = moves.map(jevMoveId);
  if (new Set(ids).size !== ids.length) {
    throw new Error('JEV rollouts require unique root moves');
  }
  for (const id of ids) {
    if (!canonicalById.has(id)) throw new Error(`JEV rollouts received an illegal root move: ${id}`);
  }

  const policies = [
    policyDefinition(SELF_POLICY, maxNodes),
    ...OPPONENT_POLICIES.map((policy) => policyDefinition(policy, maxNodes)),
  ];
  const candidates: JevRolloutCandidate[] = ids.map((id) => ({
    id,
    move: canonicalById.get(id)!,
    commonCompletedPlies: 1,
    scenarios: [],
  }));
  const scheduled: MutableScenario[] = [];

  // Interleave opponent policies and candidates; every live scenario receives
  // at most one decision per round before any scenario advances again.
  for (const opponentPolicy of OPPONENT_POLICIES) {
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const candidate = candidates[candidateIndex]!;
      const rootState = structuredClone(state);
      const rootLegal = legalMoves(rootState, config);
      const rootMove = rootLegal.find((move) => jevMoveId(move) === candidate.id);
      if (!rootMove) throw new Error(`JEV rollouts root ceased to be legal: ${candidate.id}`);
      const afterRoot = applyMove(rootState, rootMove);
      const rootTerminal = getResult(afterRoot, config);
      const status = rootTerminal ? 'terminal' : maxPlies === 1 ? 'ply-cap' : null;
      const output: JevRolloutScenario = {
        id: `${candidate.id}:${opponentPolicy.id}`,
        opponentPolicyId: opponentPolicy.id,
        line: [rootMove],
        plies: 1,
        status: status ?? 'ply-cap',
        terminal: rootTerminal,
        decisions: [],
        searchSummary: summarizeSearch([]),
        policyCutoff: null,
      };
      candidate.scenarios.push(output);
      scheduled.push({ candidateIndex, output, state: afterRoot, status });
    }
  }

  let stopReason: JevRolloutStopReason = 'complete';
  const interrupted = (): 'deadline' | 'aborted' | null => {
    if (options.signal?.aborted) return 'aborted';
    if (Date.now() >= options.deadlineMs) return 'deadline';
    return null;
  };
  const chooser = options.choose ?? chooseMove;
  let round = 0;

  while (scheduled.some((scenario) => scenario.status === null)) {
    const halt = interrupted();
    if (halt) {
      stopReason = halt;
      break;
    }
    const start = round % scheduled.length;
    for (let offset = 0; offset < scheduled.length; offset += 1) {
      const scenario = scheduled[(start + offset) % scheduled.length]!;
      if (scenario.status !== null) continue;
      const before = interrupted();
      if (before) {
        stopReason = before;
        break;
      }

      const legal = legalMoves(scenario.state, config);
      const terminalBefore = getResult(scenario.state, config);
      if (terminalBefore) {
        scenario.output.terminal = terminalBefore;
        scenario.status = 'terminal';
        continue;
      }
      if (legal.length === 0) {
        throw new Error('Canonical getResult returned non-terminal for a position with no legal moves');
      }

      const opponentPolicy = OPPONENT_POLICIES.find(
        (policy) => policy.id === scenario.output.opponentPolicyId,
      )!;
      const policy = scenario.state.turn === state.turn ? SELF_POLICY : opponentPolicy;
      const now = Date.now();
      const decisionDeadlineMs = Math.min(
        options.deadlineMs,
        now + JEV_ROLLOUT_LIMITS.maxMsPerDecision,
      );
      const maxMs = decisionDeadlineMs - now;
      if (maxMs <= 0) {
        stopReason = 'deadline';
        break;
      }
      let search: AiSearchStats | null = null;
      let pressure: JevRolloutPressureMetadata | null = null;
      let selected: Move | null;
      const fallbackMaxNodes = Math.min(
        maxNodes,
        JEV_ROLLOUT_LIMITS.guardPressureFallbackMaxNodes,
      );
      if (policy.id === 'opponent-guard-pressure') {
        const delegatedFallback = { maxMs: null as number | null, maxNodes: null as number | null };
        const pressureDecision = chooseJevGuardPressureMove(
          structuredClone(scenario.state),
          config,
          {
            deadlineMs: decisionDeadlineMs,
            maxNodes: JEV_ROLLOUT_LIMITS.guardPressureMaxNodes,
            signal: options.signal,
            fallback: (position, fallbackConfig, fallbackOptions) => {
              delegatedFallback.maxMs = Math.max(1, Math.min(
                maxMs,
                fallbackOptions.maxMs ?? maxMs,
                JEV_ROLLOUT_LIMITS.maxMsPerDecision,
              ));
              delegatedFallback.maxNodes = Math.max(1, Math.min(
                fallbackMaxNodes,
                fallbackOptions.maxNodes ?? fallbackMaxNodes,
              ));
              return chooser(structuredClone(position), fallbackConfig, {
                ...fallbackOptions,
                maxMs: delegatedFallback.maxMs,
                maxDepth: JEV_ROLLOUT_LIMITS.maxDepth,
                maxNodes: delegatedFallback.maxNodes,
                choiceWindow: 0,
                planStrength: 1,
                strategyLevel: 3,
                elite: true,
                rng: undefined,
                botSide: position.turn,
              });
            },
          },
        );
        pressure = pressureMetadata(pressureDecision, delegatedFallback);
        search = pressureDecision.stats.fallback.search;
        selected = pressureDecision.move;
        if (!selected) {
          const afterPressure = interrupted();
          if (afterPressure) {
            stopReason = afterPressure;
            break;
          }
          scenario.output.policyCutoff = {
            linePly: scenario.output.line.length,
            player: scenario.state.turn,
            policyId: policy.id,
            pressure,
          };
          scenario.status = 'policy-cutoff';
          continue;
        }
      } else {
        selected = chooser(structuredClone(scenario.state), config, {
          maxMs,
          maxDepth: JEV_ROLLOUT_LIMITS.maxDepth,
          maxNodes,
          choiceWindow: policy.choiceWindow,
          planStrength: policy.planStrength,
          strategyLevel: policy.strategyLevel,
          elite: policy.elite,
          botSide: scenario.state.turn,
          onSearchComplete: (value) => { search = value; },
        });
        if (!selected) throw new Error('JEV rollout policy returned no move in a non-terminal position');
      }
      const selectedId = jevMoveId(selected);
      const canonical = legal.find((move) => jevMoveId(move) === selectedId);
      if (!canonical) throw new Error(`JEV rollout policy returned an illegal move: ${selectedId}`);
      const resolvedSearch = search as AiSearchStats | null;
      const searchMaxNodes = policy.id === 'opponent-guard-pressure'
        ? pressure?.stats.fallback.delegatedMaxNodes ?? fallbackMaxNodes
        : maxNodes;
      const cutoff = !resolvedSearch?.aborted
        ? null
        : resolvedSearch.nodes >= searchMaxNodes ? 'node-budget' : 'time-budget';

      const afterChoice = interrupted();
      if (afterChoice) {
        stopReason = afterChoice;
        break;
      }
      const stillCanonical = legalMoves(scenario.state, config)
        .find((move) => jevMoveId(move) === selectedId);
      if (!stillCanonical) throw new Error(`JEV rollout selected move ceased to be legal: ${selectedId}`);
      const decisionPlayer = scenario.state.turn;
      scenario.state = applyMove(scenario.state, stillCanonical);
      scenario.output.line.push(stillCanonical);
      scenario.output.decisions.push({
        linePly: scenario.output.line.length - 1,
        player: decisionPlayer,
        policyId: policy.id,
        move: stillCanonical,
        applied: true,
        budget: {
          deadlineMs: decisionDeadlineMs,
          maxMs,
          maxDepth: JEV_ROLLOUT_LIMITS.maxDepth,
          maxNodes: searchMaxNodes,
        },
        search: resolvedSearch,
        cutoff,
        pressure,
      });
      scenario.output.plies = scenario.output.line.length;
      scenario.output.terminal = getResult(scenario.state, config);
      if (scenario.output.terminal) scenario.status = 'terminal';
      else if (scenario.output.line.length >= maxPlies) scenario.status = 'ply-cap';
    }
    if (stopReason !== 'complete') break;
    round += 1;
  }

  if (stopReason === 'complete'
      && scheduled.some((scenario) => scenario.status === 'policy-cutoff')) {
    stopReason = 'policy-cutoff';
  }
  if (stopReason !== 'complete') {
    for (const scenario of scheduled) {
      if (scenario.status === null) scenario.status = stopReason;
    }
  }
  for (const scenario of scheduled) {
    scenario.output.status = scenario.status ?? 'ply-cap';
    scenario.output.plies = scenario.output.line.length;
    scenario.output.searchSummary = summarizeSearch(scenario.output.decisions);
  }
  for (const candidate of candidates) {
    candidate.commonCompletedPlies = Math.min(
      ...candidate.scenarios.map((scenario) => scenario.plies),
    );
  }

  return {
    version: JEV_ROLLOUT_VERSION,
    scope: JEV_ROLLOUT_SCOPE,
    rootPlayer: state.turn,
    complete: stopReason === 'complete',
    incomplete: stopReason !== 'complete',
    stopReason,
    commonCompletedPlies: Math.min(
      ...scheduled.map((scenario) => scenario.output.plies),
    ),
    limits: {
      deadlineMs: options.deadlineMs,
      maxPlies,
      maxNodesPerDecision: maxNodes,
      maxDepth: JEV_ROLLOUT_LIMITS.maxDepth,
      maxMsPerDecision: JEV_ROLLOUT_LIMITS.maxMsPerDecision,
      scenarioCount: scheduled.length,
    },
    policyDefinitions: policies,
    candidates,
  };
}
