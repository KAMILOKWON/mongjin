import { mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_CONFIG, type RuleConfig } from '../src/core/config';
import { initialState, legalMoves, opponent } from '../src/core/rules';
import { applyMove } from '../src/core/apply';
import { getResult } from '../src/core/result';
import type { GameState, Move, Player } from '../src/core/types';
import { RECORD_RULES_VERSION, type GameRecord } from './gameRecords';
import { RANKED_BOTS } from './rankedBots';
import { chooseOfficialBotMove, createRankedBot, type OfficialBot } from './officialBot';
import { JEV_BOT, JEV_EXPIRES_AT } from './jevExperiment';
import {
  chooseParallelJevMove,
  type ParallelTurnOptions,
  type ParallelTurnTrace,
} from './jevParallel';
import { JEV_MODEL } from './jevGateway';
import { mockEvaluateJev } from './verifyJev';
import { JEV_PARALLEL_POLICY, jevMoveId, jevStateHash } from './jevPolicy';
import { verifyJevTrace } from './jevReplay';

const TURN_TIMEOUT_MS = 30_000;
const LIVE_RETRY_COOLDOWN_MS = 30_000;
const MAX_TRANSIENT_RETRIES_PER_TURN = 2;
const MAX_TRANSIENT_RETRIES_PER_GAME = 4;

export interface BenchOptions {
  mode: 'mock' | 'live';
  keyFile?: string;
  outdir: string;
  bot?: string;
  rating?: number;
  side: 'BLACK' | 'WHITE' | 'both';
  maxPlies: number;
  seed: number;
  matrix: boolean;
  engine?: string;
  turnPauseMs?: number;
  transientRetries?: number;
}

export interface MatchPairConfig {
  botId: string;
  botName: string;
  botRating: number;
  jevSide: Player;
}

export interface GameSummary {
  gameId: string;
  index: number;
  botId: string;
  botName: string;
  botRating: number;
  jevSide: Player;
  seed: number;
  winner: Player | null;
  winnerReason: string | null;
  outcome: 'jev_win' | 'jev_loss' | 'unfinished_plycap' | 'aborted_error';
  totalPlies: number;
  jevAttemptsCount: number;
  jevTurnsCount: number;
  retryCount: number;
  failureCodes: string[];
  completedAfterRecovery: boolean;
  jevPlacementsCount: number;
  jevMovesCount: number;
  searchSummary: {
    minCompletedDepth: number | null;
    maxCompletedDepth: number | null;
    avgCompletedDepth: number | null;
    totalSearchMs: number;
    avgSearchMs: number;
    totalNodes: number;
    avgNodes: number;
  };
  apiSummary: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost: number;
  };
  error?: string;
}

export interface BenchReport {
  format: 'mongjin-jev-benchmark-report-1';
  createdAt: string;
  mode: 'mock' | 'live';
  reproducibility: {
    seed: number;
    maxPlies: number;
    turnTimeoutMs: number;
    turnPauseMs: number;
    transientRetries: number;
    retryCooldownMs: number;
    enginePath: string;
    model: string;
    policyVersion: string;
    rulesVersion: string;
    note: string;
  };
  matrix: MatchPairConfig[];
  summary: {
    totalGames: number;
    completedGames: number;
    unfinishedPlycapGames: number;
    abortedGames: number;
    jevWins: number;
    jevLosses: number;
    jevWinRateExcludingUnfinished: number;
    totalTokens: number;
    totalCost: number;
    jevAttemptsCount: number;
    jevTurnsCount: number;
    retryCount: number;
    failureCodes: string[];
    completedAfterRecovery: boolean;
    completedAfterRecoveryGames: number;
  };
  games: GameSummary[];
}

function parseStrictInt(value: string | undefined, name: string): number {
  if (value === undefined) throw new Error(`${name} is required`);
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(`${name} must be a valid integer, received: "${value}"`);
  }
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`${name} must be a safe integer, received: "${value}"`);
  }
  return n;
}

export function parseBenchArgs(argv = process.argv.slice(2)): BenchOptions {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      mock: { type: 'boolean', default: false },
      live: { type: 'boolean', default: false },
      'key-file': { type: 'string' },
      outdir: { type: 'string' },
      bot: { type: 'string' },
      rating: { type: 'string' },
      side: { type: 'string', default: 'both' },
      'max-plies': { type: 'string', default: '80' },
      seed: { type: 'string', default: '20260920' },
      matrix: { type: 'boolean', default: false },
      engine: { type: 'string' },
      'turn-pause-ms': { type: 'string', default: '0' },
      'transient-retries': { type: 'string', default: '0' },
    },
  });

  if (values.mock === values.live) {
    throw new Error('Choose exactly one of --mock or --live');
  }

  const mode: 'mock' | 'live' = values.live ? 'live' : 'mock';

  if (mode === 'live' && !values['key-file']) {
    throw new Error('--live requires --key-file');
  }
  if (mode === 'mock' && values['key-file']) {
    throw new Error('--key-file is only valid with --live');
  }

  if (!values.outdir) {
    throw new Error('--outdir is required');
  }
  const turnPauseMs = Number(values['turn-pause-ms']);
  if (!Number.isSafeInteger(turnPauseMs) || turnPauseMs < 0 || turnPauseMs > 60_000) {
    throw new Error('--turn-pause-ms must be an integer between 0 and 60000');
  }

  const maxPlies = parseStrictInt(values['max-plies'], '--max-plies');
  if (maxPlies <= 0 || maxPlies > 120) {
    throw new Error('--max-plies must be a positive integer <= 120 (default 80)');
  }

  const seed = parseStrictInt(values.seed, '--seed');
  if (seed < 0) {
    throw new Error('--seed must be a non-negative integer');
  }

  const transientRetries = parseStrictInt(
    values['transient-retries'],
    '--transient-retries',
  );
  if (transientRetries < 0 || transientRetries > MAX_TRANSIENT_RETRIES_PER_TURN) {
    throw new Error('--transient-retries must be an integer between 0 and 2');
  }

  const sideRaw = values.side.toUpperCase();
  if (sideRaw !== 'BLACK' && sideRaw !== 'WHITE' && sideRaw !== 'BOTH') {
    throw new Error('--side must be BLACK, WHITE, or both');
  }
  const side = sideRaw === 'BOTH' ? 'both' : (sideRaw as 'BLACK' | 'WHITE');

  let rating: number | undefined;
  if (values.rating !== undefined) {
    rating = parseStrictInt(values.rating, '--rating');
    if (rating < 100 || rating > 3000) {
      throw new Error('--rating must be an integer between 100 and 3000');
    }
  }

  if (values.matrix && (values.bot || values.rating !== undefined)) {
    throw new Error('--matrix cannot be combined with specific --bot or --rating');
  }

  return {
    mode,
    keyFile: values['key-file'],
    outdir: values.outdir,
    bot: values.bot,
    rating,
    side,
    maxPlies,
    seed,
    matrix: values.matrix,
    engine: values.engine,
    turnPauseMs,
    transientRetries,
  };
}

export function resolveMatches(options: BenchOptions): MatchPairConfig[] {
  let targetBots = RANKED_BOTS.map((bot) => ({
    id: bot.id,
    name: bot.name,
    rating: bot.rating,
  }));

  if (options.bot) {
    const found = targetBots.filter((b) => b.id === options.bot || b.name === options.bot);
    if (found.length === 0) {
      throw new Error(`Unknown bot ID or name: ${options.bot}`);
    }
    targetBots = found;
  } else if (options.rating !== undefined) {
    const targetRating = options.rating;
    const sorted = [...targetBots].sort(
      (a, b) => Math.abs(a.rating - targetRating) - Math.abs(b.rating - targetRating),
    );
    targetBots = [sorted[0]!];
  } else if (options.matrix) {
    // 1000 guardian (ranked-bot-may) and 1400 runner (ranked-bot-uzumaki)
    const matrixIds = ['ranked-bot-may', 'ranked-bot-uzumaki'];
    targetBots = targetBots.filter((b) => matrixIds.includes(b.id));
  } else {
    const defaultBot = targetBots.find((b) => b.id === 'ranked-bot-furnace') ?? targetBots[0]!;
    targetBots = [defaultBot];
  }

  const sides: Player[] = options.side === 'both' ? ['BLACK', 'WHITE'] : [options.side];
  const matches: MatchPairConfig[] = [];

  for (const bot of targetBots) {
    for (const jevSide of sides) {
      matches.push({
        botId: bot.id,
        botName: bot.name,
        botRating: bot.rating,
        jevSide,
      });
    }
  }

  return matches;
}

export function createPrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

async function writeAtomicFile(path: string, content: string): Promise<void> {
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(tmpPath, 'wx', 0o600);
    await file.writeFile(content, 'utf8');
    await file.close();
    file = undefined;
    await rename(tmpPath, path);
  } finally {
    await file?.close();
    await unlink(tmpPath).catch(() => {});
  }
}

async function appendTraceFile(path: string, trace: ParallelTurnTrace): Promise<void> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, 'a', 0o600);
    await file.writeFile(`${JSON.stringify(trace)}\n`, 'utf8');
  } finally {
    await file?.close();
  }
}

export async function preflightOutdir(outdir: string): Promise<void> {
  const dirPath = resolve(outdir);
  try {
    const s = await stat(dirPath);
    if (!s.isDirectory()) {
      throw new Error(`Outdir exists but is not a directory: ${dirPath}`);
    }
    const entries = await readdir(dirPath);
    if (entries.length > 0) {
      throw new Error(`Output directory must be empty: ${dirPath} contains ${entries.length} file(s)`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await mkdir(dirPath, { recursive: true, mode: 0o700 });
      return;
    }
    throw error;
  }
}

export async function loadKey(keyFile: string): Promise<string> {
  const resolved = resolve(keyFile);
  const key = (await readFile(resolved, 'utf8')).trim();
  if (!key) {
    throw new Error('Live key file is empty');
  }
  return key;
}

export type JevMoveChooser = (options: ParallelTurnOptions) => Promise<{
  move: Move;
  trace: ParallelTurnTrace;
  elapsedMs: number;
  model: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
}>;

export async function resolveEngine(enginePath?: string): Promise<{
  chooseMove: JevMoveChooser;
  resolvedPath: string;
}> {
  if (!enginePath) {
    return {
      chooseMove: chooseParallelJevMove,
      resolvedPath: 'server/jevParallel.ts (default)',
    };
  }

  const resolved = resolve(enginePath);
  const fileUrl = pathToFileURL(resolved).href;
  const mod = (await import(fileUrl)) as { chooseParallelJevMove?: JevMoveChooser };
  if (typeof mod.chooseParallelJevMove !== 'function') {
    throw new Error(`Engine module at ${enginePath} does not export chooseParallelJevMove`);
  }
  return {
    chooseMove: mod.chooseParallelJevMove,
    resolvedPath: resolved,
  };
}

function extractTraceFromError(error: unknown): ParallelTurnTrace | undefined {
  if (typeof error === 'object' && error !== null && 'trace' in error) {
    const trace = (error as { trace: unknown }).trace;
    if (typeof trace === 'object' && trace !== null && 'turnId' in trace && 'status' in trace) {
      return trace as ParallelTurnTrace;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown, trace?: ParallelTurnTrace): string {
  if (isRecord(error) && typeof error.code === 'string') return error.code;
  if (typeof trace?.error === 'string') return trace.error;
  return 'unknown';
}

function hasExplicitHttpStatus(
  error: unknown,
  trace: ParallelTurnTrace | undefined,
  expectedStatus: number,
): boolean {
  if (isRecord(error) && error.status === expectedStatus) return true;
  return trace?.stages.some((stage) =>
    stage.error === 'http_error'
    && isRecord(stage.response)
    && stage.response.status === expectedStatus
  ) ?? false;
}

function classifyFailure(error: unknown, trace?: ParallelTurnTrace): {
  code: string;
  retryable: boolean;
} {
  const code = errorCode(error, trace);
  if (code === 'timeout' || code === 'http_429') return { code, retryable: true };
  if (code === 'http_error' && hasExplicitHttpStatus(error, trace, 503)) {
    return { code: 'http_503', retryable: true };
  }
  return { code, retryable: false };
}

function configuredTransientRetries(options: BenchOptions): number {
  const retries = options.transientRetries ?? 0;
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > MAX_TRANSIENT_RETRIES_PER_TURN) {
    throw new Error('transientRetries must be an integer between 0 and 2');
  }
  return retries;
}

export async function playSingleGame(params: {
  gameIndex: number;
  match: MatchPairConfig;
  options: BenchOptions;
  apiKey: string;
  chooseJevMove: JevMoveChooser;
  config: RuleConfig;
  outdir: string;
}): Promise<{
  summary: GameSummary;
  traces: ParallelTurnTrace[];
  gameRecord: GameRecord;
  inferredPolicyVersion?: string;
}> {
  const { gameIndex, match, options, apiKey, chooseJevMove, config, outdir } = params;
  const gameId = `bench-${options.mode}-${match.botId}-${match.jevSide.toLowerCase()}-${gameIndex}-${randomUUID().slice(0, 8)}`;
  const startedAt = new Date().toISOString();
  const gameSeed = (options.seed + gameIndex * 7919) >>> 0;
  const prng = createPrng(gameSeed);

  const tracesPath = join(outdir, `${gameId}.traces.jsonl`);
  const recordPath = join(outdir, `${gameId}.record.json`);

  const botProfile = {
    playerId: match.botId,
    name: match.botName,
    rating: match.botRating,
    token: 'local-bench',
    wins: 0,
    losses: 0,
    createdAt: startedAt,
    updatedAt: startedAt,
  };
  const officialBot: OfficialBot = createRankedBot(botProfile, prng);
  officialBot.side = opponent(match.jevSide);

  let state: GameState = initialState(config);
  const moves: Move[] = [];
  const traces: ParallelTurnTrace[] = [];

  let winner: Player | null = null;
  let winnerReason: string | null = null;
  let outcome: GameSummary['outcome'] = 'unfinished_plycap';
  let abortError: string | undefined;

  let jevPlacementsCount = 0;
  let jevMovesCount = 0;
  let jevAttemptsCount = 0;
  let jevTurnsCount = 0;
  let retryCount = 0;
  let recoveredTurn = false;
  const failureCodes: string[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCost = 0;
  let detectedPolicyVersion: string | undefined;

  const completedDepths: number[] = [];
  const searchTimes: number[] = [];
  const searchNodes: number[] = [];
  const transientRetries = configuredTransientRetries(options);

  const persistTrace = async (trace: ParallelTurnTrace) => {
    traces.push(trace);
    await appendTraceFile(tracesPath, trace);
    if (trace.policy?.version && !detectedPolicyVersion) {
      detectedPolicyVersion = trace.policy.version;
    }
  };

  const updateAndSaveRecord = async (
    currentStatus: GameRecord['status'],
    currentWinner?: Player,
    currentReason?: string,
  ) => {
    const rec: GameRecord = {
      schemaVersion: 1,
      rulesVersion: RECORD_RULES_VERSION,
      matchId: gameId,
      kind: 'bot',
      startedAt,
      endedAt: new Date().toISOString(),
      status: currentStatus,
      players: {
        [match.jevSide]: { kind: 'bot', rating: JEV_BOT.rating },
        [opponent(match.jevSide)]: { kind: 'bot', rating: match.botRating },
      } as Record<Player, { kind: 'bot'; rating: number }>,
      config,
      moves: [...moves],
      winner: currentWinner,
      reason: currentReason,
      revision: moves.length,
    };
    await writeAtomicFile(recordPath, JSON.stringify(rec, null, 2) + '\n');
    return rec;
  };

  await updateAndSaveRecord('playing');

  for (let ply = 0; ply < options.maxPlies; ply++) {
    const term = getResult(state, config);
    if (term) {
      winner = term.winner;
      winnerReason = term.reason;
      outcome = winner === match.jevSide ? 'jev_win' : 'jev_loss';
      break;
    }

    const currentTurn = state.turn;
    const isJevTurn = currentTurn === match.jevSide;

    if (isJevTurn) {
      if (options.turnPauseMs) await new Promise((resolve) => setTimeout(resolve, options.turnPauseMs));
      const turnState = structuredClone(state);
      const turnStateHash = jevStateHash(turnState);
      const turnPly = turnState.history.length;
      let turnRetryCount = 0;
      let retryPending = false;
      let turnCompleted = false;

      while (!turnCompleted) {
        if (retryPending && options.mode === 'live') {
          await new Promise((resolve) => setTimeout(resolve, LIVE_RETRY_COOLDOWN_MS));
        }

        // The promotional access window is checked immediately before every call,
        // including calls made after the live cooldown.
        if (options.mode === 'live' && Date.now() >= Date.parse(JEV_EXPIRES_AT)) {
          abortError = 'Live JEV verification period has expired during game';
          outcome = 'aborted_error';
          break;
        }

        if (retryPending) {
          turnRetryCount += 1;
          retryCount += 1;
          retryPending = false;
        }

        const attemptDeadlineMs = Date.now() + TURN_TIMEOUT_MS;
        jevAttemptsCount += 1;
        let moveResult: Awaited<ReturnType<JevMoveChooser>>;

        try {
          moveResult = await chooseJevMove({
            gameId,
            state: structuredClone(turnState),
            config,
            apiKey,
            deadlineMs: attemptDeadlineMs,
            // Let baseline modules use their own gateway/error types in live mode.
            evaluate: options.mode === 'mock' ? mockEvaluateJev : undefined,
          });
        } catch (error) {
          const errTrace = extractTraceFromError(error);
          if (errTrace) await persistTrace(errTrace);
          const failure = classifyFailure(error, errTrace);
          failureCodes.push(failure.code);

          if (
            failure.retryable
            && turnRetryCount < transientRetries
            && retryCount < MAX_TRANSIENT_RETRIES_PER_GAME
          ) {
            retryPending = true;
            continue;
          }

          abortError = error instanceof Error ? error.message : String(error);
          outcome = 'aborted_error';
          break;
        }

        const { move, trace, inputTokens, outputTokens, cost } = moveResult;
        await persistTrace(trace);

        // Critical: per-attempt free guard and deadline check.
        if (cost !== 0) {
          failureCodes.push('non_free');
          abortError = `Cost is non-zero (${cost}); free experiment violated`;
          outcome = 'aborted_error';
          break;
        }

        if (Date.now() > attemptDeadlineMs) {
          failureCodes.push('timeout');
          if (
            turnRetryCount < transientRetries
            && retryCount < MAX_TRANSIENT_RETRIES_PER_GAME
          ) {
            retryPending = true;
            continue;
          }
          abortError = `Turn completed after ${TURN_TIMEOUT_MS}ms deadline (${Date.now() - attemptDeadlineMs}ms late)`;
          outcome = 'aborted_error';
          break;
        }

        try {
          verifyJevTrace(trace);
        } catch (validationErr) {
          failureCodes.push('invalid_response');
          abortError = `verifyJevTrace failed: ${validationErr instanceof Error ? validationErr.message : String(validationErr)}`;
          outcome = 'aborted_error';
          break;
        }

        if (
          trace.stateHash !== turnStateHash
          || trace.ply !== turnPly
          || jevStateHash(trace.snapshot) !== turnStateHash
        ) {
          failureCodes.push('invalid_response');
          abortError = 'JEV attempt trace does not match the original turn state';
          outcome = 'aborted_error';
          break;
        }

        const chosenId = jevMoveId(move);
        if (trace.selection?.id !== chosenId) {
          failureCodes.push('invalid_response');
          abortError = `JEV trace selected ${trace.selection?.id ?? 'no move'} but returned ${chosenId}`;
          outcome = 'aborted_error';
          break;
        }
        const legal = legalMoves(turnState, config);
        const isLegal = legal.some((m) => jevMoveId(m) === chosenId);
        if (!isLegal) {
          failureCodes.push('invalid_response');
          abortError = `JEV selected an illegal move: ${chosenId}`;
          outcome = 'aborted_error';
          break;
        }

        totalInputTokens += inputTokens;
        totalOutputTokens += outputTokens;
        totalCost += cost;

        if (move.kind === 'PLACE') {
          jevPlacementsCount++;
        } else {
          jevMovesCount++;
        }

        for (const s of trace.searches) {
          completedDepths.push(s.completedDepth);
          searchNodes.push(s.nodes);
        }
        if (trace.timings.searchMs) {
          for (const ms of trace.timings.searchMs) {
            searchTimes.push(ms);
          }
        }

        jevTurnsCount += 1;
        if (turnRetryCount > 0) recoveredTurn = true;
        moves.push(move);
        state = applyMove(turnState, move);
        await updateAndSaveRecord('playing');
        turnCompleted = true;
      }

      if (outcome === 'aborted_error') break;
    } else {
      const move = chooseOfficialBotMove(officialBot, state, config);
      if (!move) {
        winner = match.jevSide;
        winnerReason = 'no-legal-moves';
        outcome = 'jev_win';
        break;
      }

      const chosenId = jevMoveId(move);
      const legal = legalMoves(state, config);
      const isLegal = legal.some((m) => jevMoveId(m) === chosenId);
      if (!isLegal) {
        abortError = `Opponent bot selected an illegal move: ${chosenId}`;
        outcome = 'aborted_error';
        break;
      }

      moves.push(move);
      state = applyMove(state, move);
      await updateAndSaveRecord('playing');
    }
  }

  if (!winner && outcome !== 'aborted_error') {
    const finalResult = getResult(state, config);
    if (finalResult) {
      winner = finalResult.winner;
      winnerReason = finalResult.reason;
      outcome = winner === match.jevSide ? 'jev_win' : 'jev_loss';
    } else {
      outcome = 'unfinished_plycap';
    }
  }

  const finalStatus: GameRecord['status'] =
    outcome === 'aborted_error'
      ? 'abandoned'
      : outcome === 'unfinished_plycap'
      ? 'playing'
      : 'completed';

  const finalReason =
    winnerReason ??
    (outcome === 'unfinished_plycap' ? 'plycap_reached' : abortError ?? undefined);

  const gameRecord = await updateAndSaveRecord(finalStatus, winner ?? undefined, finalReason);

  const avg = (arr: number[]) => (arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length);

  const summary: GameSummary = {
    gameId,
    index: gameIndex,
    botId: match.botId,
    botName: match.botName,
    botRating: match.botRating,
    jevSide: match.jevSide,
    seed: gameSeed,
    winner,
    winnerReason,
    outcome,
    totalPlies: moves.length,
    jevAttemptsCount,
    jevTurnsCount,
    retryCount,
    failureCodes,
    completedAfterRecovery:
      recoveredTurn && (outcome === 'jev_win' || outcome === 'jev_loss'),
    jevPlacementsCount,
    jevMovesCount,
    searchSummary: {
      minCompletedDepth: completedDepths.length ? Math.min(...completedDepths) : null,
      maxCompletedDepth: completedDepths.length ? Math.max(...completedDepths) : null,
      avgCompletedDepth: completedDepths.length ? avg(completedDepths) : null,
      totalSearchMs: searchTimes.reduce((a, b) => a + b, 0),
      avgSearchMs: avg(searchTimes),
      totalNodes: searchNodes.reduce((a, b) => a + b, 0),
      avgNodes: avg(searchNodes),
    },
    apiSummary: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      cost: totalCost,
    },
    error: abortError,
  };

  return { summary, traces, gameRecord, inferredPolicyVersion: detectedPolicyVersion };
}

export async function runBenchmark(options: BenchOptions): Promise<BenchReport> {
  const transientRetries = configuredTransientRetries(options);
  await preflightOutdir(options.outdir);

  if (options.mode === 'live') {
    if (Date.now() >= Date.parse(JEV_EXPIRES_AT)) {
      throw new Error('Live JEV verification period has expired');
    }
  }

  const apiKey = options.mode === 'live' ? await loadKey(options.keyFile!) : 'local-mock-key';
  const engine = await resolveEngine(options.engine);
  const matches = resolveMatches(options);

  const outdir = resolve(options.outdir);
  const gameSummaries: GameSummary[] = [];
  let capturedPolicyVersion: string | undefined;

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!;
    const { summary, inferredPolicyVersion } = await playSingleGame({
      gameIndex: i + 1,
      match,
      options,
      apiKey,
      chooseJevMove: engine.chooseMove,
      config: DEFAULT_CONFIG,
      outdir,
    });

    if (inferredPolicyVersion && !capturedPolicyVersion) {
      capturedPolicyVersion = inferredPolicyVersion;
    }

    gameSummaries.push(summary);

    console.log(
      `[benchJev ${i + 1}/${matches.length}] ${summary.gameId} | ${match.botName}(${match.botRating}) vs JEV(${match.jevSide}) | ${summary.outcome} | ${summary.totalPlies} plies`,
    );

    if (summary.outcome === 'aborted_error') {
      console.error(`  Game aborted: ${summary.error}. Stopping remaining matrix games.`);
      break;
    }
  }

  const finishedCompleted = gameSummaries.filter(
    (g) => g.outcome === 'jev_win' || g.outcome === 'jev_loss',
  );
  const jevWins = gameSummaries.filter((g) => g.outcome === 'jev_win').length;
  const jevLosses = gameSummaries.filter((g) => g.outcome === 'jev_loss').length;
  const unfinishedPlycaps = gameSummaries.filter((g) => g.outcome === 'unfinished_plycap').length;
  const abortedGames = gameSummaries.filter((g) => g.outcome === 'aborted_error').length;

  const winRate = finishedCompleted.length > 0 ? jevWins / finishedCompleted.length : 0;

  const totalTokens = gameSummaries.reduce((sum, g) => sum + g.apiSummary.totalTokens, 0);
  const totalCost = gameSummaries.reduce((sum, g) => sum + g.apiSummary.cost, 0);
  const jevAttemptsCount = gameSummaries.reduce((sum, g) => sum + g.jevAttemptsCount, 0);
  const jevTurnsCount = gameSummaries.reduce((sum, g) => sum + g.jevTurnsCount, 0);
  const retryCount = gameSummaries.reduce((sum, g) => sum + g.retryCount, 0);
  const failureCodes = gameSummaries.flatMap((g) => g.failureCodes);
  const completedAfterRecoveryGames = gameSummaries.filter(
    (g) => g.completedAfterRecovery,
  ).length;

  const effectivePolicyVersion = capturedPolicyVersion ?? JEV_PARALLEL_POLICY.version;

  const report: BenchReport = {
    format: 'mongjin-jev-benchmark-report-1',
    createdAt: new Date().toISOString(),
    mode: options.mode,
    reproducibility: {
      seed: options.seed,
      maxPlies: options.maxPlies,
      turnTimeoutMs: TURN_TIMEOUT_MS,
      turnPauseMs: options.turnPauseMs ?? 0,
      transientRetries,
      retryCooldownMs: options.mode === 'live' ? LIVE_RETRY_COOLDOWN_MS : 0,
      enginePath: engine.resolvedPath,
      model: JEV_MODEL,
      policyVersion: effectivePolicyVersion,
      rulesVersion: RECORD_RULES_VERSION,
      note: 'Deterministic seed fixes PRNG sequence for bot choices, but does not guarantee identical search results under wall-clock time budgets or deterministic AI provider outputs.',
    },
    matrix: matches,
    summary: {
      totalGames: gameSummaries.length,
      completedGames: finishedCompleted.length,
      unfinishedPlycapGames: unfinishedPlycaps,
      abortedGames,
      jevWins,
      jevLosses,
      jevWinRateExcludingUnfinished: winRate,
      totalTokens,
      totalCost,
      jevAttemptsCount,
      jevTurnsCount,
      retryCount,
      failureCodes,
      completedAfterRecovery: completedAfterRecoveryGames > 0,
      completedAfterRecoveryGames,
    },
    games: gameSummaries,
  };

  const reportPath = join(outdir, 'report.json');
  await writeAtomicFile(reportPath, JSON.stringify(report, null, 2) + '\n');

  console.log(`Report saved to ${reportPath}`);
  return report;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseBenchArgs(argv);
  await runBenchmark(options);
}

const isDirectRun = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'JEV benchmark failed');
    process.exitCode = 1;
  });
}
