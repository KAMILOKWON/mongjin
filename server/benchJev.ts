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
import {
  chooseOfficialBotMove,
  createOfficialBot,
  createRankedBot,
  type OfficialBot,
  type OfficialBotPersonality,
  type OfficialBotSearchProfile,
} from './officialBot';
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
  opponents?: string[];
  opponentProfiles?: BenchOpponentProfile[];
  dryRun?: boolean;
}

export interface BenchOpponentProfile {
  id: string;
  name: string;
  personality: OfficialBotPersonality;
  configuredSearchRating: number;
  profileEloLabel: number;
}

export type BenchOpponentSource = 'ranked-bot' | 'custom-profile';

export interface MatchPairConfig {
  botId: string;
  botName: string;
  botRating: number;
  jevSide: Player;
  botSource?: BenchOpponentSource;
  botPersonality?: OfficialBotPersonality;
  botConfiguredSearchRating?: number;
  botProfileEloLabel?: number;
  botStrengthBasis?: 'official-bot-config-not-empirical-elo';
}

export interface InstantiatedOpponentConfig {
  source: BenchOpponentSource;
  personality: OfficialBotPersonality;
  profileEloLabel: number;
  configuredSearchRating: number;
  strengthBasis: 'official-bot-config-not-empirical-elo';
  randomSeed: number;
  side: Player;
  variantKey: string;
  openingLane: -1 | 1;
  difficultyBand: OfficialBot['difficultyBand'];
  search: OfficialBotSearchProfile;
  firstThreeChoiceWindow: number;
}

export interface GameSummary {
  gameId: string;
  index: number;
  botId: string;
  botName: string;
  botRating: number;
  jevSide: Player;
  seed: number;
  opponentConfig?: InstantiatedOpponentConfig;
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
    options?: {
      side: BenchOptions['side'];
      matrix: boolean;
      bot?: string;
      rating?: number;
      opponents: string[];
      opponentProfiles: BenchOpponentProfile[];
    };
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

export const BENCH_JEV_HELP = `Usage:
  cd server
  node --import tsx benchJev.ts (--mock | --live) --outdir DIR [options]

Modes:
  --mock                         Use the local deterministic mock evaluator.
  --live --key-file FILE         Use the existing typesafe-ai/jev gateway key file.

Opponent selection (choose one legacy selector or the explicit selector set):
  --bot ID_OR_NAME               One ranked bot (legacy).
  --rating ELO                   Ranked bot nearest the label (legacy).
  --matrix                       MAY 1000 + Uzumaki 1400 (legacy default matrix).
  --opponent ID_OR_NAME          Repeat for explicit ranked bot IDs/names.
  --opponent-profile SPEC        Repeat custom official-bot profiles. SPEC is
                                 ID:PERSONALITY:SEARCH_RATING[:PROFILE_ELO_LABEL].
                                 PERSONALITY: runner|guardian|tactician|wanderer.
                                 SEARCH_RATING configures official bot search; it
                                 is not an empirically measured Elo.

Run controls:
  --side BLACK|WHITE|both        JEV side; default both.
  --seed N                       Benchmark seed; default 20260920.
  --max-plies N                  Ply cap <= 120; default 80.
  --engine FILE                  Baseline/candidate chooseParallelJevMove module.
  --turn-pause-ms N              Delay before JEV turns; default 0.
  --transient-retries N          Retry 429/503/timeout, 0..2; default 0.
  --dry-run                      Print the resolved deterministic matrix only.
  --help, -h                     Show this help.
`;

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

const OFFICIAL_BOT_PERSONALITIES: readonly OfficialBotPersonality[] = [
  'runner',
  'guardian',
  'tactician',
  'wanderer',
];

function parseOpponentProfile(value: string): BenchOpponentProfile {
  const parts = value.split(':');
  if (parts.length < 3 || parts.length > 4) {
    throw new Error(
      '--opponent-profile must use ID:PERSONALITY:SEARCH_RATING[:PROFILE_ELO_LABEL]',
    );
  }
  const [id, personalityRaw, searchRatingRaw, profileEloRaw] = parts;
  if (!id || !/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
    throw new Error('--opponent-profile ID must contain only letters, numbers, hyphens, or underscores');
  }
  if (id === JEV_BOT.id || RANKED_BOTS.some((bot) => bot.id === id)) {
    throw new Error(`--opponent-profile ID conflicts with an official ranked bot ID: ${id}`);
  }
  const personality = personalityRaw as OfficialBotPersonality;
  if (!OFFICIAL_BOT_PERSONALITIES.includes(personality)) {
    throw new Error(
      `--opponent-profile personality must be ${OFFICIAL_BOT_PERSONALITIES.join(', ')}`,
    );
  }
  const configuredSearchRating = parseStrictInt(
    searchRatingRaw,
    '--opponent-profile SEARCH_RATING',
  );
  if (configuredSearchRating < 100 || configuredSearchRating > 2400) {
    throw new Error('--opponent-profile SEARCH_RATING must be an integer between 100 and 2400');
  }
  if (configuredSearchRating % 20 !== 0) {
    throw new Error('--opponent-profile SEARCH_RATING must be a multiple of 20');
  }
  const profileEloLabel = profileEloRaw === undefined
    ? configuredSearchRating
    : parseStrictInt(profileEloRaw, '--opponent-profile PROFILE_ELO_LABEL');
  if (profileEloLabel < 100 || profileEloLabel > 3000) {
    throw new Error('--opponent-profile PROFILE_ELO_LABEL must be an integer between 100 and 3000');
  }
  return {
    id,
    name: id,
    personality,
    configuredSearchRating,
    profileEloLabel,
  };
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
      opponent: { type: 'string', multiple: true },
      'opponent-profile': { type: 'string', multiple: true },
      engine: { type: 'string' },
      'turn-pause-ms': { type: 'string', default: '0' },
      'transient-retries': { type: 'string', default: '0' },
      'dry-run': { type: 'boolean', default: false },
    },
  });

  if (values.mock === values.live) {
    throw new Error('Choose exactly one of --mock or --live');
  }

  const mode: 'mock' | 'live' = values.live ? 'live' : 'mock';

  if (mode === 'live' && !values['key-file'] && !values['dry-run']) {
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

  const opponents = values.opponent ?? [];
  const opponentProfiles = (values['opponent-profile'] ?? []).map(parseOpponentProfile);
  const hasExplicitOpponents = opponents.length > 0 || opponentProfiles.length > 0;
  const legacySelectorCount = Number(Boolean(values.bot))
    + Number(values.rating !== undefined)
    + Number(Boolean(values.matrix));
  if (legacySelectorCount > 1) {
    throw new Error('--bot, --rating, and --matrix cannot be combined');
  }
  if (legacySelectorCount > 0 && hasExplicitOpponents) {
    throw new Error(
      '--opponent/--opponent-profile cannot be combined with --bot, --rating, or --matrix',
    );
  }
  const selectorIds = [...opponents, ...opponentProfiles.map((profile) => profile.id)];
  const duplicateSelector = selectorIds.find(
    (id, index) => selectorIds.indexOf(id) !== index,
  );
  if (duplicateSelector) {
    throw new Error(`Duplicate opponent selector: ${duplicateSelector}`);
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
    opponents,
    opponentProfiles,
    dryRun: values['dry-run'],
  };
}

export function resolveMatches(options: BenchOptions): MatchPairConfig[] {
  let targetBots: Array<{
    id: string;
    name: string;
    rating: number;
    source: BenchOpponentSource;
    personality: OfficialBotPersonality;
    configuredSearchRating: number;
    profileEloLabel: number;
  }> = RANKED_BOTS.map((bot) => ({
    id: bot.id,
    name: bot.name,
    rating: bot.rating,
    source: 'ranked-bot' as const,
    personality: bot.personality,
    configuredSearchRating: bot.rating,
    profileEloLabel: bot.rating,
  }));

  const explicitBots = options.opponents ?? [];
  const explicitProfiles = options.opponentProfiles ?? [];

  if (explicitBots.length > 0 || explicitProfiles.length > 0) {
    const selectedRanked = explicitBots.map((selector) => {
      const found = targetBots.find((bot) => bot.id === selector || bot.name === selector);
      if (!found) throw new Error(`Unknown bot ID or name: ${selector}`);
      return found;
    });
    const selectedProfiles = explicitProfiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      rating: profile.profileEloLabel,
      source: 'custom-profile' as const,
      personality: profile.personality,
      configuredSearchRating: profile.configuredSearchRating,
      profileEloLabel: profile.profileEloLabel,
    }));
    targetBots = [...selectedRanked, ...selectedProfiles];
  } else if (options.bot) {
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
        botSource: bot.source,
        botPersonality: bot.personality,
        botConfiguredSearchRating: bot.configuredSearchRating,
        botProfileEloLabel: bot.profileEloLabel,
        botStrengthBasis: 'official-bot-config-not-empirical-elo',
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

function createCustomProfileBot(
  profile: BenchOpponentProfile,
  side: Player,
  random: () => number,
): OfficialBot {
  const personalityIndex = OFFICIAL_BOT_PERSONALITIES.indexOf(profile.personality);
  let factoryCall = 0;
  const factoryRandom = () => {
    factoryCall += 1;
    if (factoryCall === 1) return 0.5; // exact zero rating offset in balanced mode
    if (factoryCall === 2) return (personalityIndex * 2 + 0.5) / 8;
    return 0.5;
  };
  const bot = createOfficialBot(
    profile.configuredSearchRating,
    profile.name,
    factoryRandom,
    undefined,
    { completed: 3, recentWins: 1, recentLosses: 1 },
  );
  if (bot.searchRating !== profile.configuredSearchRating || bot.personality !== profile.personality) {
    throw new Error(`Failed to instantiate exact opponent profile ${profile.id}`);
  }
  bot.playerId = profile.id;
  bot.name = profile.name;
  bot.rating = profile.profileEloLabel;
  bot.side = side;
  bot.variantKey = `${profile.id}:${side}`;
  bot.random = random;
  bot.openingLane = random() < 0.5 ? -1 : 1;
  return bot;
}

function instantiateOpponent(
  match: MatchPairConfig,
  randomSeed: number,
): { bot: OfficialBot; config: InstantiatedOpponentConfig } {
  const random = createPrng(randomSeed);
  const source = match.botSource ?? 'ranked-bot';
  let bot: OfficialBot;
  if (source === 'custom-profile') {
    if (!match.botPersonality || match.botConfiguredSearchRating === undefined) {
      throw new Error(`Custom opponent ${match.botId} is missing personality/search configuration`);
    }
    bot = createCustomProfileBot({
      id: match.botId,
      name: match.botName,
      personality: match.botPersonality,
      configuredSearchRating: match.botConfiguredSearchRating,
      profileEloLabel: match.botProfileEloLabel ?? match.botRating,
    }, opponent(match.jevSide), random);
  } else {
    const startedAt = new Date(0).toISOString();
    bot = createRankedBot({
      playerId: match.botId,
      name: match.botName,
      rating: match.botRating,
      token: 'local-bench',
      wins: 0,
      losses: 0,
      createdAt: startedAt,
      updatedAt: startedAt,
    }, random);
    bot.side = opponent(match.jevSide);
    bot.variantKey = `${match.botId}:${bot.side}`;
  }
  const config: InstantiatedOpponentConfig = {
    source,
    personality: bot.personality,
    profileEloLabel: match.botProfileEloLabel ?? match.botRating,
    configuredSearchRating: bot.searchRating,
    strengthBasis: 'official-bot-config-not-empirical-elo',
    randomSeed,
    side: bot.side,
    variantKey: bot.variantKey,
    openingLane: bot.openingLane ?? 1,
    difficultyBand: bot.difficultyBand,
    search: structuredClone(bot.search),
    firstThreeChoiceWindow: Math.max(12, bot.search.choiceWindow),
  };
  return { bot, config };
}

export function buildDryRunPlan(options: BenchOptions) {
  const matches = resolveMatches(options);
  return {
    mode: options.mode,
    dryRun: true as const,
    engine: options.engine ?? 'server/jevParallel.ts (default)',
    benchmarkSeed: options.seed,
    side: options.side,
    maxPlies: options.maxPlies,
    turnPauseMs: options.turnPauseMs ?? 0,
    transientRetries: options.transientRetries ?? 0,
    gameCount: matches.length,
    games: matches.map((match, index) => {
      const gameSeed = (options.seed + (index + 1) * 7919) >>> 0;
      return {
        index: index + 1,
        match,
        opponentConfig: instantiateOpponent(match, gameSeed).config,
      };
    }),
    note: 'Profile Elo labels and configured search ratings are metadata/configuration, not empirically measured playing strength.',
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

  const tracesPath = join(outdir, `${gameId}.traces.jsonl`);
  const recordPath = join(outdir, `${gameId}.record.json`);

  const { bot: officialBot, config: opponentConfig } = instantiateOpponent(match, gameSeed);

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
    opponentConfig,
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
  if (options.dryRun) {
    throw new Error('runBenchmark cannot execute when dryRun is enabled; use buildDryRunPlan');
  }
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
      options: {
        side: options.side,
        matrix: options.matrix,
        bot: options.bot,
        rating: options.rating,
        opponents: [...(options.opponents ?? [])],
        opponentProfiles: structuredClone(options.opponentProfiles ?? []),
      },
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
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(BENCH_JEV_HELP);
    return;
  }
  const options = parseBenchArgs(argv);
  if (options.dryRun) {
    console.log(JSON.stringify(buildDryRunPlan(options), null, 2));
    return;
  }
  await runBenchmark(options);
}

const isDirectRun = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'JEV benchmark failed');
    process.exitCode = 1;
  });
}
