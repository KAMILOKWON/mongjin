/**
 * Offline, predeclared JEV release gate.
 *
 * Usage:
 *   npx tsx server/compareJev.ts \
 *     --baseline baseline-name=/path/to/baseline-reports \
 *     --candidate candidate-name=/path/to/candidate-reports \
 *     --spec /path/to/evaluation-spec.json \
 *     --out /path/to/comparison.json
 *
 * Each run directory may be one benchmark directory or a parent containing
 * benchmark directories. The tool only reads report.json and *.record.json;
 * it makes no network/API calls.
 * Inputs must be fresh benchJev filesystem outputs, not PostgreSQL/JSONB
 * exports: replayRecord compares canonical move objects with JSON.stringify,
 * while JSONB may reorder object keys.
 *
 * This is an engineering release gate, not a claim of statistically
 * significant superiority. The fixed gate is 12 completed paired games
 * (2 opponents x 2 JEV sides x 3 predeclared seeds), at least 8 candidate
 * wins, at least 3 more wins than baseline, at least 1 candidate win in every
 * opponent/side stratum, and no increase in aborted/error-attempt rate.
 * A finite-sample failure is a rejection; this tool has no waiver flag.
 * API retries are reported separately from error attempts.
 */

import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { RuleConfig } from '../src/core/config';
import { getResult } from '../src/core/result';
import type { Player } from '../src/core/types';
import type { BenchReport, GameSummary, MatchPairConfig } from './benchJev';
import { replayRecord, type GameRecord } from './gameRecords';

const FIXED_GATE = {
  completedPairs: 12,
  candidateMinimumWins: 8,
  minimumWinGainVsBaseline: 3,
  minimumWinsPerOpponentSide: 1,
  errorAttemptRateMustNotIncrease: true,
} as const;

type Outcome = GameSummary['outcome'];

export interface NamedRunInput {
  name: string;
  path: string;
}

export interface CompareOptions {
  baseline: NamedRunInput;
  candidate: NamedRunInput;
  specPath?: string;
  outPath?: string;
}

interface EvaluationSpec {
  version: 'jev-strength-gate-1';
  baselineCommit: string;
  baselineEngine: string;
  developmentRecords: string[];
  evaluationSeeds: number[];
  matrix: { opponents: string[]; sides: Player[] };
  gate: typeof FIXED_GATE;
  timing: { turnPauseMs: number; transientRetries: number; maxPlies: number };
  note: string;
}

interface LoadedGame {
  conditionKey: string;
  reportSeed: number;
  reportPath: string;
  summary: GameSummary;
  record: GameRecord;
  configKey: string;
  completed: boolean;
  jevWin: boolean;
}

interface LoadedReport {
  path: string;
  report: BenchReport;
  matrixKey: string;
  gamesByCondition: Map<string, LoadedGame>;
  missingMatrixEntries: string[];
}

interface LoadedRun {
  input: NamedRunInput;
  reports: LoadedReport[];
  reportsBySeed: Map<number, LoadedReport>;
  matrix: MatchPairConfig[];
  gamesByCondition: Map<string, LoadedGame>;
  missingMatrixEntries: string[];
}

export interface GateCheck {
  id: string;
  passed: boolean;
  requirement: string;
  actual: unknown;
}

export interface RunDiagnostics {
  name: string;
  path: string;
  enginePath: string;
  policyVersion: string;
  rulesVersion: string;
  reportCount: number;
  reportSeeds: number[];
  intendedGames: number;
  observedGames: number;
  completedGames: number;
  unfinishedGames: number;
  abortedGames: number;
  wins: number;
  losses: number;
  apiAttempts: number;
  apiRetries: number;
  errorAttempts: number;
  errorAttemptsByCode: Record<string, number>;
  abortedWithoutErrorAttempt: number;
  abortedOrErrorAttempts: number;
  abortedOrErrorAttemptRate: number;
  missingMatrixEntries: string[];
  winsByOpponentSide: Record<string, number>;
}

export interface JevComparisonReport {
  format: 'mongjin-jev-comparison-report-1';
  createdAt: string;
  claim: string;
  spec: {
    path: string | null;
    version: string | null;
    baselineCommit: string | null;
    evaluationSeeds: number[];
    timing: { turnPauseMs: number; transientRetries: number; maxPlies: number };
  };
  gate: typeof FIXED_GATE;
  runs: { baseline: RunDiagnostics; candidate: RunDiagnostics };
  pairing: {
    intendedPairs: number;
    observedPairs: number;
    completedPairs: number;
    missingBaseline: string[];
    missingCandidate: string[];
    incompletePairs: string[];
    improvedPairs: number;
    regressedPairs: number;
    unchangedPairs: number;
    pairs: Array<{
      condition: string;
      gameSeed: number | null;
      baseline: 'win' | 'loss' | 'incomplete' | 'missing';
      candidate: 'win' | 'loss' | 'incomplete' | 'missing';
    }>;
  };
  checks: GateCheck[];
  recommendation: 'accept_candidate' | 'reject_candidate';
}

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (!isObject(value)) fail(path, 'expected an object');
  return value;
}

function arrayAt(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'expected an array');
  return value;
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(path, 'expected a non-empty string');
  return value;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'expected a boolean');
  return value;
}

function integerAt(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail(path, `expected a safe integer >= ${minimum}`);
  }
  return value as number;
}

function numberAt(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    fail(path, `expected a finite number >= ${minimum}`);
  }
  return value;
}

function nullableStringAt(value: unknown, path: string): string | null {
  if (value === null) return null;
  return stringAt(value, path);
}

function playerAt(value: unknown, path: string): Player {
  if (value !== 'BLACK' && value !== 'WHITE') fail(path, 'expected BLACK or WHITE');
  return value;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sameArray<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateRuleConfig(value: unknown, path: string): RuleConfig {
  const config = objectAt(value, path);
  integerAt(config.boardSize, `${path}.boardSize`, 3);
  integerAt(config.guardCount, `${path}.guardCount`);
  if (!['full-row', 'center-3', 'center-1'].includes(config.goalCells as string)) {
    fail(`${path}.goalCells`, 'unsupported goalCells');
  }
  if (!['adjacent', 'own-half'].includes(config.placement as string)) {
    fail(`${path}.placement`, 'unsupported placement');
  }
  if (!['step', 'slide'].includes(config.guardMove as string)) {
    fail(`${path}.guardMove`, 'unsupported guardMove');
  }
  booleanAt(config.kingSurroundLoss, `${path}.kingSurroundLoss`);
  booleanAt(config.noGuardOnGoal, `${path}.noGuardOnGoal`);
  booleanAt(config.kingCapture, `${path}.kingCapture`);
  return config as unknown as RuleConfig;
}

function matrixEntryKey(entry: Pick<MatchPairConfig, 'botId' | 'jevSide'>): string {
  return `${entry.botId}/${entry.jevSide}`;
}

function conditionKey(reportSeed: number, botId: string, jevSide: Player): string {
  return `${reportSeed}/${botId}/${jevSide}`;
}

function validateMatrix(value: unknown, path: string): MatchPairConfig[] {
  const seen = new Set<string>();
  return arrayAt(value, path).map((raw, index) => {
    const itemPath = `${path}[${index}]`;
    const item = objectAt(raw, itemPath);
    const entry: MatchPairConfig = {
      botId: stringAt(item.botId, `${itemPath}.botId`),
      botName: stringAt(item.botName, `${itemPath}.botName`),
      botRating: integerAt(item.botRating, `${itemPath}.botRating`),
      jevSide: playerAt(item.jevSide, `${itemPath}.jevSide`),
    };
    const key = matrixEntryKey(entry);
    if (seen.has(key)) fail(itemPath, `duplicate matrix entry ${key}`);
    seen.add(key);
    return entry;
  });
}

function validateGameSummary(value: unknown, path: string): GameSummary {
  const game = objectAt(value, path);
  const outcome = game.outcome;
  if (!['jev_win', 'jev_loss', 'unfinished_plycap', 'aborted_error'].includes(outcome as string)) {
    fail(`${path}.outcome`, 'unsupported outcome');
  }
  const winner = game.winner === null ? null : playerAt(game.winner, `${path}.winner`);
  const failureCodes = arrayAt(game.failureCodes, `${path}.failureCodes`).map((code, index) =>
    stringAt(code, `${path}.failureCodes[${index}]`));
  const attempts = integerAt(game.jevAttemptsCount, `${path}.jevAttemptsCount`);
  const turns = integerAt(game.jevTurnsCount, `${path}.jevTurnsCount`);
  const retries = integerAt(game.retryCount, `${path}.retryCount`);
  if (turns > attempts) fail(path, 'jevTurnsCount exceeds jevAttemptsCount');
  if (retries > failureCodes.length) fail(path, 'retryCount exceeds recorded failure attempts');

  const search = objectAt(game.searchSummary, `${path}.searchSummary`);
  const api = objectAt(game.apiSummary, `${path}.apiSummary`);
  for (const key of ['totalSearchMs', 'avgSearchMs', 'totalNodes', 'avgNodes']) {
    numberAt(search[key], `${path}.searchSummary.${key}`);
  }
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cost']) {
    numberAt(api[key], `${path}.apiSummary.${key}`);
  }
  if (api.totalTokens !== (api.inputTokens as number) + (api.outputTokens as number)) {
    fail(`${path}.apiSummary.totalTokens`, 'does not equal inputTokens + outputTokens');
  }

  const summary = game as unknown as GameSummary;
  stringAt(summary.gameId, `${path}.gameId`);
  integerAt(summary.index, `${path}.index`, 1);
  stringAt(summary.botId, `${path}.botId`);
  stringAt(summary.botName, `${path}.botName`);
  integerAt(summary.botRating, `${path}.botRating`);
  playerAt(summary.jevSide, `${path}.jevSide`);
  integerAt(summary.seed, `${path}.seed`);
  nullableStringAt(summary.winnerReason, `${path}.winnerReason`);
  integerAt(summary.totalPlies, `${path}.totalPlies`);
  integerAt(summary.jevPlacementsCount, `${path}.jevPlacementsCount`);
  integerAt(summary.jevMovesCount, `${path}.jevMovesCount`);
  booleanAt(summary.completedAfterRecovery, `${path}.completedAfterRecovery`);
  if (summary.error !== undefined) stringAt(summary.error, `${path}.error`);
  if (winner !== summary.winner) fail(`${path}.winner`, 'invalid winner');
  return summary;
}

function validateReport(value: unknown, path: string): BenchReport {
  const report = objectAt(value, path);
  if (report.format !== 'mongjin-jev-benchmark-report-1') fail(`${path}.format`, 'unsupported report format');
  stringAt(report.createdAt, `${path}.createdAt`);
  if (report.mode !== 'mock' && report.mode !== 'live') fail(`${path}.mode`, 'expected mock or live');

  const reproducibility = objectAt(report.reproducibility, `${path}.reproducibility`);
  integerAt(reproducibility.seed, `${path}.reproducibility.seed`);
  integerAt(reproducibility.maxPlies, `${path}.reproducibility.maxPlies`, 1);
  integerAt(reproducibility.turnTimeoutMs, `${path}.reproducibility.turnTimeoutMs`, 1);
  integerAt(reproducibility.turnPauseMs, `${path}.reproducibility.turnPauseMs`);
  integerAt(reproducibility.transientRetries, `${path}.reproducibility.transientRetries`);
  integerAt(reproducibility.retryCooldownMs, `${path}.reproducibility.retryCooldownMs`);
  for (const key of ['enginePath', 'model', 'policyVersion', 'rulesVersion', 'note']) {
    stringAt(reproducibility[key], `${path}.reproducibility.${key}`);
  }

  const matrix = validateMatrix(report.matrix, `${path}.matrix`);
  if (matrix.length === 0) fail(`${path}.matrix`, 'matrix is empty');
  const games = arrayAt(report.games, `${path}.games`).map((game, index) =>
    validateGameSummary(game, `${path}.games[${index}]`));
  const gameIds = new Set<string>();
  const indices = new Set<number>();
  for (const game of games) {
    if (gameIds.has(game.gameId)) fail(`${path}.games`, `duplicate gameId ${game.gameId}`);
    if (indices.has(game.index)) fail(`${path}.games`, `duplicate game index ${game.index}`);
    gameIds.add(game.gameId);
    indices.add(game.index);
  }

  const summary = objectAt(report.summary, `${path}.summary`);
  const completed = games.filter((game) => game.outcome === 'jev_win' || game.outcome === 'jev_loss');
  const wins = games.filter((game) => game.outcome === 'jev_win').length;
  const losses = games.filter((game) => game.outcome === 'jev_loss').length;
  const unfinished = games.filter((game) => game.outcome === 'unfinished_plycap').length;
  const aborted = games.filter((game) => game.outcome === 'aborted_error').length;
  const attempts = games.reduce((total, game) => total + game.jevAttemptsCount, 0);
  const turns = games.reduce((total, game) => total + game.jevTurnsCount, 0);
  const retries = games.reduce((total, game) => total + game.retryCount, 0);
  const failureCodes = games.flatMap((game) => game.failureCodes);
  const recovered = games.filter((game) => game.completedAfterRecovery).length;
  const expectedIntegers: Record<string, number> = {
    totalGames: games.length,
    completedGames: completed.length,
    unfinishedPlycapGames: unfinished,
    abortedGames: aborted,
    jevWins: wins,
    jevLosses: losses,
    jevAttemptsCount: attempts,
    jevTurnsCount: turns,
    retryCount: retries,
    completedAfterRecoveryGames: recovered,
  };
  for (const [key, expected] of Object.entries(expectedIntegers)) {
    const actual = integerAt(summary[key], `${path}.summary.${key}`);
    if (actual !== expected) fail(`${path}.summary.${key}`, `expected recomputed value ${expected}, received ${actual}`);
  }
  const savedFailureCodes = arrayAt(summary.failureCodes, `${path}.summary.failureCodes`).map((code, index) =>
    stringAt(code, `${path}.summary.failureCodes[${index}]`));
  if (!sameArray(savedFailureCodes, failureCodes)) fail(`${path}.summary.failureCodes`, 'does not match game failure codes');
  const recoveredFlag = booleanAt(summary.completedAfterRecovery, `${path}.summary.completedAfterRecovery`);
  if (recoveredFlag !== (recovered > 0)) fail(`${path}.summary.completedAfterRecovery`, 'does not match games');
  const rate = numberAt(summary.jevWinRateExcludingUnfinished, `${path}.summary.jevWinRateExcludingUnfinished`);
  const expectedRate = completed.length === 0 ? 0 : wins / completed.length;
  if (Math.abs(rate - expectedRate) > Number.EPSILON) fail(`${path}.summary.jevWinRateExcludingUnfinished`, 'does not match games');
  numberAt(summary.totalTokens, `${path}.summary.totalTokens`);
  numberAt(summary.totalCost, `${path}.summary.totalCost`);
  const expectedTokens = games.reduce((total, game) => total + game.apiSummary.totalTokens, 0);
  const expectedCost = games.reduce((total, game) => total + game.apiSummary.cost, 0);
  if (summary.totalTokens !== expectedTokens) fail(`${path}.summary.totalTokens`, `expected recomputed value ${expectedTokens}`);
  if (summary.totalCost !== expectedCost) fail(`${path}.summary.totalCost`, `expected recomputed value ${expectedCost}`);

  return report as unknown as BenchReport;
}

function validateRecord(value: unknown, path: string): GameRecord {
  const record = objectAt(value, path);
  if (record.schemaVersion !== 1) fail(`${path}.schemaVersion`, 'expected schemaVersion 1');
  stringAt(record.rulesVersion, `${path}.rulesVersion`);
  stringAt(record.matchId, `${path}.matchId`);
  if (record.kind !== 'bot') fail(`${path}.kind`, 'benchmark record must have kind bot');
  stringAt(record.startedAt, `${path}.startedAt`);
  if (record.endedAt !== undefined) stringAt(record.endedAt, `${path}.endedAt`);
  if (!['playing', 'completed', 'abandoned'].includes(record.status as string)) fail(`${path}.status`, 'invalid status');
  objectAt(record.players, `${path}.players`);
  validateRuleConfig(record.config, `${path}.config`);
  arrayAt(record.moves, `${path}.moves`);
  if (record.winner !== undefined) playerAt(record.winner, `${path}.winner`);
  if (record.reason !== undefined) stringAt(record.reason, `${path}.reason`);
  integerAt(record.revision, `${path}.revision`);
  return record as unknown as GameRecord;
}

async function readJson(path: string): Promise<unknown> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function findReportPaths(inputPath: string): Promise<string[]> {
  const root = resolve(inputPath);
  const rootStat = await stat(root).catch((error: unknown) => {
    throw new Error(`Cannot inspect run path ${root}: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (rootStat.isFile()) return [root];
  if (!rootStat.isDirectory()) throw new Error(`Run path is not a file or directory: ${root}`);

  const reports: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name === 'report.json') reports.push(path);
    }
  };
  await visit(root);
  reports.sort();
  if (reports.length === 0) throw new Error(`No report.json files found under ${root}`);
  return reports;
}

function terminalOutcome(game: GameSummary, record: GameRecord, recordPath: string): { completed: boolean; jevWin: boolean } {
  if (record.revision !== record.moves.length) fail(recordPath, 'record revision does not equal move count');
  if (game.totalPlies !== record.moves.length) fail(recordPath, 'record ply count does not match report');

  let finalState: ReturnType<typeof replayRecord>;
  try {
    finalState = replayRecord(record);
  } catch (error) {
    fail(recordPath, `canonical replay failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const terminal = getResult(finalState, record.config);
  const completed = game.outcome === 'jev_win' || game.outcome === 'jev_loss';

  if (completed) {
    if (record.status !== 'completed' || !record.endedAt) fail(recordPath, 'completed report game requires a completed record');
    if (!terminal) fail(recordPath, 'completed record is not terminal under canonical rules');
    if (record.reason === 'resign' || record.reason === 'disconnect') fail(recordPath, 'benchmark strength result must be a canonical terminal, not a forfeit');
    if (record.winner !== terminal.winner || record.reason !== terminal.reason) fail(recordPath, 'record result does not match canonical terminal');
    if (game.winner !== terminal.winner || game.winnerReason !== terminal.reason) fail(recordPath, 'report result does not match canonical terminal');
    const expectedOutcome: Outcome = terminal.winner === game.jevSide ? 'jev_win' : 'jev_loss';
    if (game.outcome !== expectedOutcome) fail(recordPath, `report outcome must be ${expectedOutcome}`);
    return { completed: true, jevWin: expectedOutcome === 'jev_win' };
  }

  if (terminal) fail(recordPath, 'non-completed game record is terminal and cannot be excluded');
  if (game.winner !== null) fail(recordPath, 'non-completed game cannot report a winner');
  if (game.outcome === 'aborted_error' && record.status !== 'abandoned') fail(recordPath, 'aborted game requires an abandoned record');
  if (game.outcome === 'unfinished_plycap' && record.status !== 'playing') fail(recordPath, 'ply-cap game requires a playing record');
  return { completed: false, jevWin: false };
}

async function loadReport(path: string): Promise<LoadedReport> {
  const report = validateReport(await readJson(path), path);
  const directory = dirname(path);
  const expectedRecordNames = new Set(report.games.map((game) => `${game.gameId}.record.json`));
  const actualRecordNames = new Set(
    (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.record.json'))
      .map((entry) => entry.name),
  );
  if (stableJson([...actualRecordNames].sort()) !== stableJson([...expectedRecordNames].sort())) {
    fail(directory, 'record files must exactly match report games; unreported or missing records are forbidden');
  }

  const matrixByKey = new Map(report.matrix.map((entry) => [matrixEntryKey(entry), entry]));
  const gamesByCondition = new Map<string, LoadedGame>();
  const seenMatrix = new Set<string>();
  for (const game of report.games) {
    const matrixKey = matrixEntryKey(game);
    const matrixEntry = matrixByKey.get(matrixKey);
    if (!matrixEntry) fail(path, `game ${game.gameId} is outside the declared matrix`);
    if (game.botRating !== matrixEntry.botRating || game.botName !== matrixEntry.botName) {
      fail(path, `game ${game.gameId} opponent metadata differs from matrix`);
    }
    if (seenMatrix.has(matrixKey)) fail(path, `multiple games for matrix entry ${matrixKey}`);
    seenMatrix.add(matrixKey);

    const recordPath = join(directory, `${game.gameId}.record.json`);
    const record = validateRecord(await readJson(recordPath), recordPath);
    if (record.matchId !== game.gameId) fail(recordPath, 'record matchId does not match gameId');
    if (record.rulesVersion !== report.reproducibility.rulesVersion) fail(recordPath, 'record rulesVersion does not match report');
    const result = terminalOutcome(game, record, recordPath);
    const key = conditionKey(report.reproducibility.seed, game.botId, game.jevSide);
    gamesByCondition.set(key, {
      conditionKey: key,
      reportSeed: report.reproducibility.seed,
      reportPath: path,
      summary: game,
      record,
      configKey: stableJson(record.config),
      completed: result.completed,
      jevWin: result.jevWin,
    });
  }

  const missingMatrixEntries = report.matrix
    .filter((entry) => !seenMatrix.has(matrixEntryKey(entry)))
    .map((entry) => conditionKey(report.reproducibility.seed, entry.botId, entry.jevSide));
  const matrixKey = stableJson(report.matrix.map((entry) => ({
    botId: entry.botId,
    botRating: entry.botRating,
    jevSide: entry.jevSide,
  })).sort((left, right) => matrixEntryKey(left).localeCompare(matrixEntryKey(right))));
  return { path, report, matrixKey, gamesByCondition, missingMatrixEntries };
}

function reproducibilityKey(report: BenchReport): string {
  const value = report.reproducibility;
  return stableJson({
    mode: report.mode,
    maxPlies: value.maxPlies,
    turnTimeoutMs: value.turnTimeoutMs,
    turnPauseMs: value.turnPauseMs,
    transientRetries: value.transientRetries,
    retryCooldownMs: value.retryCooldownMs,
    enginePath: value.enginePath,
    model: value.model,
    policyVersion: value.policyVersion,
    rulesVersion: value.rulesVersion,
  });
}

async function loadRun(input: NamedRunInput): Promise<LoadedRun> {
  const reportPaths = await findReportPaths(input.path);
  const reports: LoadedReport[] = [];
  for (const path of reportPaths) reports.push(await loadReport(path));

  const first = reports[0]!;
  const reportsBySeed = new Map<number, LoadedReport>();
  const gamesByCondition = new Map<string, LoadedGame>();
  for (const report of reports) {
    const seed = report.report.reproducibility.seed;
    if (reportsBySeed.has(seed)) fail(report.path, `duplicate benchmark report seed ${seed}`);
    if (report.matrixKey !== first.matrixKey) fail(report.path, 'matrix differs from other reports in the run');
    if (reproducibilityKey(report.report) !== reproducibilityKey(first.report)) {
      fail(report.path, 'mode, timing, engine, model, policy, or rules differ within the named run');
    }
    reportsBySeed.set(seed, report);
    for (const [key, game] of report.gamesByCondition) {
      if (gamesByCondition.has(key)) fail(report.path, `duplicate evaluation condition ${key}`);
      gamesByCondition.set(key, game);
    }
  }
  return {
    input: { name: input.name, path: resolve(input.path) },
    reports,
    reportsBySeed,
    matrix: first.report.matrix,
    gamesByCondition,
    missingMatrixEntries: reports.flatMap((report) => report.missingMatrixEntries),
  };
}

function validateFixedGate(value: unknown, path: string): typeof FIXED_GATE {
  const gate = objectAt(value, path);
  for (const [key, expected] of Object.entries(FIXED_GATE)) {
    if (gate[key] !== expected) fail(`${path}.${key}`, `must equal fixed release gate value ${String(expected)}`);
  }
  return FIXED_GATE;
}

export async function loadEvaluationSpec(path: string): Promise<EvaluationSpec> {
  const resolved = resolve(path);
  const raw = objectAt(await readJson(resolved), resolved);
  if (raw.version !== 'jev-strength-gate-1') fail(`${resolved}.version`, 'unsupported spec version');
  const seeds = arrayAt(raw.evaluationSeeds, `${resolved}.evaluationSeeds`).map((seed, index) =>
    integerAt(seed, `${resolved}.evaluationSeeds[${index}]`));
  if (seeds.length !== 3 || new Set(seeds).size !== 3) fail(`${resolved}.evaluationSeeds`, 'exactly 3 unique seeds are required');
  const matrix = objectAt(raw.matrix, `${resolved}.matrix`);
  const opponents = arrayAt(matrix.opponents, `${resolved}.matrix.opponents`).map((bot, index) =>
    stringAt(bot, `${resolved}.matrix.opponents[${index}]`));
  const sides = arrayAt(matrix.sides, `${resolved}.matrix.sides`).map((side, index) =>
    playerAt(side, `${resolved}.matrix.sides[${index}]`));
  if (opponents.length !== 2 || new Set(opponents).size !== 2) fail(`${resolved}.matrix.opponents`, 'exactly 2 unique opponents are required');
  if (!sameArray([...sides].sort(), ['BLACK', 'WHITE'])) fail(`${resolved}.matrix.sides`, 'both BLACK and WHITE are required');
  const timing = objectAt(raw.timing, `${resolved}.timing`);
  const spec: EvaluationSpec = {
    version: 'jev-strength-gate-1',
    baselineCommit: stringAt(raw.baselineCommit, `${resolved}.baselineCommit`),
    baselineEngine: stringAt(raw.baselineEngine, `${resolved}.baselineEngine`),
    developmentRecords: arrayAt(raw.developmentRecords, `${resolved}.developmentRecords`).map((item, index) =>
      stringAt(item, `${resolved}.developmentRecords[${index}]`)),
    evaluationSeeds: seeds,
    matrix: { opponents, sides },
    gate: validateFixedGate(raw.gate, `${resolved}.gate`),
    timing: {
      turnPauseMs: integerAt(timing.turnPauseMs, `${resolved}.timing.turnPauseMs`),
      transientRetries: integerAt(timing.transientRetries, `${resolved}.timing.transientRetries`),
      maxPlies: integerAt(timing.maxPlies, `${resolved}.timing.maxPlies`, 1),
    },
    note: stringAt(raw.note, `${resolved}.note`),
  };
  return spec;
}

function matrixShape(run: LoadedRun): { opponents: string[]; sides: Player[] } {
  return {
    opponents: [...new Set(run.matrix.map((entry) => entry.botId))].sort(),
    sides: [...new Set(run.matrix.map((entry) => entry.jevSide))].sort() as Player[],
  };
}

function validateExperiment(baseline: LoadedRun, candidate: LoadedRun, spec?: EvaluationSpec): number[] {
  const baselineShape = matrixShape(baseline);
  if (baseline.matrix.length !== 4 || baselineShape.opponents.length !== 2 || !sameArray(baselineShape.sides, ['BLACK', 'WHITE'])) {
    throw new Error('Baseline must declare exactly 2 opponents x 2 JEV sides');
  }
  if (stableJson(baseline.matrix.map((entry) => ({ botId: entry.botId, botRating: entry.botRating, jevSide: entry.jevSide })).sort((a, b) => matrixEntryKey(a).localeCompare(matrixEntryKey(b))))
      !== stableJson(candidate.matrix.map((entry) => ({ botId: entry.botId, botRating: entry.botRating, jevSide: entry.jevSide })).sort((a, b) => matrixEntryKey(a).localeCompare(matrixEntryKey(b))))) {
    throw new Error('Baseline and candidate matrices (bot IDs, ratings, and JEV sides) must match');
  }

  const baselineSeeds = [...baseline.reportsBySeed.keys()].sort((a, b) => a - b);
  const candidateSeeds = [...candidate.reportsBySeed.keys()].sort((a, b) => a - b);
  if (baselineSeeds.length !== 3 || !sameArray(baselineSeeds, candidateSeeds)) {
    throw new Error('Baseline and candidate must contain the same 3 report seeds');
  }

  for (const seed of baselineSeeds) {
    const left = baseline.reportsBySeed.get(seed)!.report;
    const right = candidate.reportsBySeed.get(seed)!.report;
    const comparableLeft = stableJson({
      mode: left.mode,
      maxPlies: left.reproducibility.maxPlies,
      turnTimeoutMs: left.reproducibility.turnTimeoutMs,
      turnPauseMs: left.reproducibility.turnPauseMs,
      transientRetries: left.reproducibility.transientRetries,
      retryCooldownMs: left.reproducibility.retryCooldownMs,
      model: left.reproducibility.model,
      rulesVersion: left.reproducibility.rulesVersion,
    });
    const comparableRight = stableJson({
      mode: right.mode,
      maxPlies: right.reproducibility.maxPlies,
      turnTimeoutMs: right.reproducibility.turnTimeoutMs,
      turnPauseMs: right.reproducibility.turnPauseMs,
      transientRetries: right.reproducibility.transientRetries,
      retryCooldownMs: right.reproducibility.retryCooldownMs,
      model: right.reproducibility.model,
      rulesVersion: right.reproducibility.rulesVersion,
    });
    if (comparableLeft !== comparableRight) throw new Error(`Baseline and candidate run settings differ for report seed ${seed}`);
  }

  if (spec) {
    const expectedSeeds = [...spec.evaluationSeeds].sort((a, b) => a - b);
    if (!sameArray(baselineSeeds, expectedSeeds)) throw new Error('Run report seeds do not match the predeclared evaluation spec');
    if (!sameArray(baselineShape.opponents, [...spec.matrix.opponents].sort())
        || !sameArray(baselineShape.sides, [...spec.matrix.sides].sort())) {
      throw new Error('Run matrix does not match the predeclared evaluation spec');
    }
    for (const report of [...baseline.reports, ...candidate.reports]) {
      const timing = report.report.reproducibility;
      if (timing.maxPlies !== spec.timing.maxPlies
          || timing.turnPauseMs !== spec.timing.turnPauseMs
          || timing.transientRetries !== spec.timing.transientRetries) {
        throw new Error(`Run timing in ${report.path} does not match the predeclared evaluation spec`);
      }
    }
    for (const report of baseline.reports) {
      if (resolve(report.report.reproducibility.enginePath) !== resolve(spec.baselineEngine)) {
        throw new Error(`Baseline engine in ${report.path} does not match the frozen spec path`);
      }
    }
  }
  return baselineSeeds;
}

function diagnostics(run: LoadedRun): RunDiagnostics {
  const games = [...run.gamesByCondition.values()];
  const failures = games.flatMap((game) => game.summary.failureCodes);
  const errorAttemptsByCode: Record<string, number> = {};
  for (const code of failures) errorAttemptsByCode[code] = (errorAttemptsByCode[code] ?? 0) + 1;
  const apiAttempts = games.reduce((total, game) => total + game.summary.jevAttemptsCount, 0);
  // failureCodes represent failed API attempts. An abort with no failure code
  // contributes one synthetic adverse attempt so non-API aborts cannot vanish
  // from the reliability rate. Retries remain a separate reported quantity.
  const abortedWithoutErrorAttempt = games.filter((game) =>
    game.summary.outcome === 'aborted_error' && game.summary.failureCodes.length === 0).length;
  const adverseAttempts = failures.length + abortedWithoutErrorAttempt;
  const rateDenominator = apiAttempts + abortedWithoutErrorAttempt;
  const winsByOpponentSide: Record<string, number> = {};
  for (const entry of run.matrix) winsByOpponentSide[matrixEntryKey(entry)] = 0;
  for (const game of games) {
    if (game.jevWin) {
      const key = matrixEntryKey(game.summary);
      winsByOpponentSide[key] = (winsByOpponentSide[key] ?? 0) + 1;
    }
  }
  return {
    name: run.input.name,
    path: run.input.path,
    enginePath: run.reports[0]!.report.reproducibility.enginePath,
    policyVersion: run.reports[0]!.report.reproducibility.policyVersion,
    rulesVersion: run.reports[0]!.report.reproducibility.rulesVersion,
    reportCount: run.reports.length,
    reportSeeds: [...run.reportsBySeed.keys()].sort((a, b) => a - b),
    intendedGames: run.reports.reduce((total, report) => total + report.report.matrix.length, 0),
    observedGames: games.length,
    completedGames: games.filter((game) => game.completed).length,
    unfinishedGames: games.filter((game) => game.summary.outcome === 'unfinished_plycap').length,
    abortedGames: games.filter((game) => game.summary.outcome === 'aborted_error').length,
    wins: games.filter((game) => game.jevWin).length,
    losses: games.filter((game) => game.completed && !game.jevWin).length,
    apiAttempts,
    apiRetries: games.reduce((total, game) => total + game.summary.retryCount, 0),
    errorAttempts: failures.length,
    errorAttemptsByCode,
    abortedWithoutErrorAttempt,
    abortedOrErrorAttempts: adverseAttempts,
    abortedOrErrorAttemptRate: rateDenominator === 0 ? 0 : adverseAttempts / rateDenominator,
    missingMatrixEntries: [...run.missingMatrixEntries].sort(),
    winsByOpponentSide,
  };
}

function rateDidNotIncrease(baseline: RunDiagnostics, candidate: RunDiagnostics): boolean {
  const baselineDenominator = baseline.apiAttempts + baseline.abortedWithoutErrorAttempt;
  const candidateDenominator = candidate.apiAttempts + candidate.abortedWithoutErrorAttempt;
  if (candidateDenominator === 0) return baselineDenominator === 0;
  if (baselineDenominator === 0) return candidate.abortedOrErrorAttempts === 0;
  return candidate.abortedOrErrorAttempts * baselineDenominator
    <= baseline.abortedOrErrorAttempts * candidateDenominator;
}

async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  const resolved = resolve(path);
  await mkdir(dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, resolved);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function compareJevRuns(options: CompareOptions): Promise<JevComparisonReport> {
  if (options.baseline.name === options.candidate.name) throw new Error('Baseline and candidate names must differ');
  const spec = options.specPath ? await loadEvaluationSpec(options.specPath) : undefined;
  const baseline = await loadRun(options.baseline);
  const candidate = await loadRun(options.candidate);
  const reportSeeds = validateExperiment(baseline, candidate, spec);

  const expectedConditions = reportSeeds.flatMap((seed) => baseline.matrix.map((entry) =>
    conditionKey(seed, entry.botId, entry.jevSide)));
  if (expectedConditions.length !== FIXED_GATE.completedPairs) {
    throw new Error(`Experiment declares ${expectedConditions.length} conditions; fixed gate requires ${FIXED_GATE.completedPairs}`);
  }

  const missingBaseline: string[] = [];
  const missingCandidate: string[] = [];
  const incompletePairs: string[] = [];
  const pairs: JevComparisonReport['pairing']['pairs'] = [];
  let observedPairs = 0;
  let completedPairs = 0;
  let improvedPairs = 0;
  let regressedPairs = 0;
  let unchangedPairs = 0;
  for (const key of expectedConditions) {
    const left = baseline.gamesByCondition.get(key);
    const right = candidate.gamesByCondition.get(key);
    if (!left) missingBaseline.push(key);
    if (!right) missingCandidate.push(key);
    const pairResult = (game: LoadedGame | undefined): 'win' | 'loss' | 'incomplete' | 'missing' => {
      if (!game) return 'missing';
      if (!game.completed) return 'incomplete';
      return game.jevWin ? 'win' : 'loss';
    };
    pairs.push({
      condition: key,
      gameSeed: left?.summary.seed ?? right?.summary.seed ?? null,
      baseline: pairResult(left),
      candidate: pairResult(right),
    });
    if (!left || !right) continue;
    observedPairs += 1;
    if (left.summary.seed !== right.summary.seed) throw new Error(`Per-game seed mismatch for ${key}`);
    if (left.configKey !== right.configKey) throw new Error(`Rule config mismatch for ${key}`);
    if (left.completed && right.completed) {
      completedPairs += 1;
      if (!left.jevWin && right.jevWin) improvedPairs += 1;
      else if (left.jevWin && !right.jevWin) regressedPairs += 1;
      else unchangedPairs += 1;
    } else incompletePairs.push(key);
  }

  const baselineDiagnostics = diagnostics(baseline);
  const candidateDiagnostics = diagnostics(candidate);
  const winGain = candidateDiagnostics.wins - baselineDiagnostics.wins;
  const stratumFailures = Object.entries(candidateDiagnostics.winsByOpponentSide)
    .filter(([, wins]) => wins < FIXED_GATE.minimumWinsPerOpponentSide)
    .map(([stratum, wins]) => ({ stratum, wins }));
  const checks: GateCheck[] = [
    {
      id: 'full-intended-pairs',
      passed: observedPairs === FIXED_GATE.completedPairs
        && missingBaseline.length === 0
        && missingCandidate.length === 0,
      requirement: `${FIXED_GATE.completedPairs} paired games are present`,
      actual: { observedPairs, missingBaseline, missingCandidate },
    },
    {
      id: 'all-pairs-completed',
      passed: completedPairs === FIXED_GATE.completedPairs && incompletePairs.length === 0,
      requirement: `${FIXED_GATE.completedPairs} pairs have canonical terminal records`,
      actual: { completedPairs, incompletePairs },
    },
    {
      id: 'candidate-minimum-wins',
      passed: candidateDiagnostics.wins >= FIXED_GATE.candidateMinimumWins,
      requirement: `candidate wins >= ${FIXED_GATE.candidateMinimumWins}`,
      actual: candidateDiagnostics.wins,
    },
    {
      id: 'win-gain-vs-baseline',
      passed: winGain >= FIXED_GATE.minimumWinGainVsBaseline,
      requirement: `candidate win gain vs baseline >= ${FIXED_GATE.minimumWinGainVsBaseline}`,
      actual: winGain,
    },
    {
      id: 'win-in-every-opponent-side-stratum',
      passed: stratumFailures.length === 0,
      requirement: `candidate wins >= ${FIXED_GATE.minimumWinsPerOpponentSide} in each opponent/JEV-side stratum`,
      actual: { winsByOpponentSide: candidateDiagnostics.winsByOpponentSide, failures: stratumFailures },
    },
    {
      id: 'aborted-or-error-attempt-rate',
      passed: rateDidNotIncrease(baselineDiagnostics, candidateDiagnostics),
      requirement: 'candidate aborted/error-attempt rate <= baseline rate',
      actual: {
        baseline: baselineDiagnostics.abortedOrErrorAttemptRate,
        candidate: candidateDiagnostics.abortedOrErrorAttemptRate,
      },
    },
  ];

  const comparison: JevComparisonReport = {
    format: 'mongjin-jev-comparison-report-1',
    createdAt: new Date().toISOString(),
    claim: 'Engineering release gate only; this finite sample does not establish statistically significant superiority, and failed criteria are not waived.',
    spec: {
      path: options.specPath ? resolve(options.specPath) : null,
      version: spec?.version ?? null,
      baselineCommit: spec?.baselineCommit ?? null,
      evaluationSeeds: reportSeeds,
      timing: {
        turnPauseMs: baseline.reports[0]!.report.reproducibility.turnPauseMs,
        transientRetries: baseline.reports[0]!.report.reproducibility.transientRetries,
        maxPlies: baseline.reports[0]!.report.reproducibility.maxPlies,
      },
    },
    gate: FIXED_GATE,
    runs: { baseline: baselineDiagnostics, candidate: candidateDiagnostics },
    pairing: {
      intendedPairs: FIXED_GATE.completedPairs,
      observedPairs,
      completedPairs,
      missingBaseline,
      missingCandidate,
      incompletePairs,
      improvedPairs,
      regressedPairs,
      unchangedPairs,
      pairs,
    },
    checks,
    recommendation: checks.every((check) => check.passed) ? 'accept_candidate' : 'reject_candidate',
  };
  if (options.outPath) await writeAtomicJson(options.outPath, comparison);
  return comparison;
}

function parseNamedRun(value: string | undefined, flag: string): NamedRunInput {
  if (!value) throw new Error(`${flag} is required and must use name=path`);
  const separator = value.indexOf('=');
  if (separator <= 0 || separator === value.length - 1) throw new Error(`${flag} must use name=path`);
  return { name: value.slice(0, separator), path: value.slice(separator + 1) };
}

export function parseCompareArgs(argv = process.argv.slice(2)): CompareOptions {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      baseline: { type: 'string' },
      candidate: { type: 'string' },
      spec: { type: 'string' },
      out: { type: 'string' },
    },
  });
  if (!values.out) throw new Error('--out is required');
  return {
    baseline: parseNamedRun(values.baseline, '--baseline'),
    candidate: parseNamedRun(values.candidate, '--candidate'),
    specPath: values.spec,
    outPath: values.out,
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseCompareArgs(argv);
  const report = await compareJevRuns(options);
  console.log(JSON.stringify({
    recommendation: report.recommendation,
    output: resolve(options.outPath!),
    failedChecks: report.checks.filter((check) => !check.passed).map((check) => check.id),
  }));
  if (report.recommendation !== 'accept_candidate') process.exitCode = 1;
}

const isDirectRun = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
