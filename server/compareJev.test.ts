import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/core/config';
import { applyMove } from '../src/core/apply';
import { getResult } from '../src/core/result';
import { findKing, goalRow, initialState, legalMoves } from '../src/core/rules';
import type { GameState, Move, Player } from '../src/core/types';
import type { BenchReport, GameSummary, MatchPairConfig } from './benchJev';
import { RECORD_RULES_VERSION, type GameRecord } from './gameRecords';
import { compareJevRuns, parseCompareArgs } from './compareJev';

const SEEDS = [10101, 20202, 30303];
const MATRIX: MatchPairConfig[] = [
  { botId: 'bot-alpha', botName: 'Alpha', botRating: 1000, jevSide: 'BLACK' },
  { botId: 'bot-alpha', botName: 'Alpha', botRating: 1000, jevSide: 'WHITE' },
  { botId: 'bot-beta', botName: 'Beta', botRating: 1400, jevSide: 'BLACK' },
  { botId: 'bot-beta', botName: 'Beta', botRating: 1400, jevSide: 'WHITE' },
];

type OutcomePlan = (seedIndex: number, matrixIndex: number) => boolean;

interface RunOptions {
  enginePath: string;
  winPlan: OutcomePlan;
  abortCondition?: { seedIndex: number; matrixIndex: number };
  errorCondition?: { seedIndex: number; matrixIndex: number; code: string; retries: number };
}

function sameCoord(left: { r: number; c: number }, right: { r: number; c: number }): boolean {
  return left.r === right.r && left.c === right.c;
}

function chooseWinnerMove(state: GameState, winner: Player): Move {
  const moves = legalMoves(state, DEFAULT_CONFIG);
  const immediate = moves.find((move) => getResult(applyMove(state, move), DEFAULT_CONFIG)?.winner === winner);
  if (immediate) return immediate;
  const king = findKing(state, winner)!;
  const kingMoves = moves.filter((move): move is Extract<Move, { kind: 'MOVE' }> =>
    move.kind === 'MOVE' && sameCoord(move.from, king));
  const targetRow = goalRow(winner, DEFAULT_CONFIG.boardSize);
  const middle = Math.floor(DEFAULT_CONFIG.boardSize / 2);
  kingMoves.sort((left, right) => {
    const leftScore = Math.abs(left.to.r - targetRow) * 10 + Math.abs(left.to.c - middle);
    const rightScore = Math.abs(right.to.r - targetRow) * 10 + Math.abs(right.to.c - middle);
    return leftScore - rightScore;
  });
  if (!kingMoves[0]) throw new Error(`No winner king move for ${winner}`);
  return kingMoves[0];
}

function chooseLosingMove(state: GameState): Move {
  const loser = state.turn;
  const king = findKing(state, loser)!;
  const home = loser === 'BLACK' ? DEFAULT_CONFIG.boardSize - 1 : 0;
  const middle = Math.floor(DEFAULT_CONFIG.boardSize / 2);
  const kingMoves = legalMoves(state, DEFAULT_CONFIG).filter(
    (move): move is Extract<Move, { kind: 'MOVE' }> => move.kind === 'MOVE' && sameCoord(move.from, king),
  );
  kingMoves.sort((left, right) => {
    const leftScore = (left.to.r === home ? 100 : 0) + Math.abs(left.to.c - middle) * 10;
    const rightScore = (right.to.r === home ? 100 : 0) + Math.abs(right.to.c - middle) * 10;
    return rightScore - leftScore;
  });
  if (!kingMoves[0]) throw new Error(`No losing king move for ${loser}`);
  return kingMoves[0];
}

function generateTerminalMoves(winner: Player): Move[] {
  let state = initialState(DEFAULT_CONFIG);
  for (let ply = 0; ply < 40; ply++) {
    const result = getResult(state, DEFAULT_CONFIG);
    if (result) {
      if (result.winner !== winner) throw new Error(`Generated wrong winner ${result.winner}`);
      return state.history;
    }
    const move = state.turn === winner ? chooseWinnerMove(state, winner) : chooseLosingMove(state);
    state = applyMove(state, move);
  }
  throw new Error(`Failed to generate terminal ${winner} record`);
}

const TERMINAL_MOVES: Record<Player, Move[]> = {
  BLACK: generateTerminalMoves('BLACK'),
  WHITE: generateTerminalMoves('WHITE'),
};

function resultForMoves(moves: Move[]) {
  let state = initialState(DEFAULT_CONFIG);
  for (const move of moves) state = applyMove(state, move);
  const result = getResult(state, DEFAULT_CONFIG);
  if (!result) throw new Error('Expected terminal generated moves');
  return result;
}

function countJevTurns(plies: number, side: Player): number {
  return side === 'BLACK' ? Math.ceil(plies / 2) : Math.floor(plies / 2);
}

function makeCompletedGame(params: {
  gameId: string;
  index: number;
  match: MatchPairConfig;
  gameSeed: number;
  jevWins: boolean;
  failureCode?: string;
  retries?: number;
}): { summary: GameSummary; record: GameRecord } {
  const winner: Player = params.jevWins
    ? params.match.jevSide
    : params.match.jevSide === 'BLACK' ? 'WHITE' : 'BLACK';
  const moves = structuredClone(TERMINAL_MOVES[winner]);
  const result = resultForMoves(moves);
  const failures = params.failureCode ? [params.failureCode] : [];
  const retries = params.retries ?? 0;
  const jevTurns = countJevTurns(moves.length, params.match.jevSide);
  const record: GameRecord = {
    schemaVersion: 1,
    rulesVersion: RECORD_RULES_VERSION,
    matchId: params.gameId,
    kind: 'bot',
    startedAt: '2026-09-20T00:00:00.000Z',
    endedAt: '2026-09-20T00:01:00.000Z',
    status: 'completed',
    players: {
      [params.match.jevSide]: { kind: 'bot', rating: 1200 },
      [params.match.jevSide === 'BLACK' ? 'WHITE' : 'BLACK']: {
        kind: 'bot', rating: params.match.botRating,
      },
    } as GameRecord['players'],
    config: structuredClone(DEFAULT_CONFIG),
    moves,
    winner: result.winner,
    reason: result.reason,
    revision: moves.length,
  };
  return {
    record,
    summary: {
      gameId: params.gameId,
      index: params.index,
      ...params.match,
      seed: params.gameSeed,
      winner: result.winner,
      winnerReason: result.reason,
      outcome: params.jevWins ? 'jev_win' : 'jev_loss',
      totalPlies: moves.length,
      jevAttemptsCount: jevTurns + failures.length,
      jevTurnsCount: jevTurns,
      retryCount: retries,
      failureCodes: failures,
      completedAfterRecovery: retries > 0,
      jevPlacementsCount: 0,
      jevMovesCount: jevTurns,
      searchSummary: {
        minCompletedDepth: 4,
        maxCompletedDepth: 4,
        avgCompletedDepth: 4,
        totalSearchMs: 100,
        avgSearchMs: 10,
        totalNodes: 1000,
        avgNodes: 100,
      },
      apiSummary: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 },
    },
  };
}

function makeAbortedGame(params: {
  gameId: string;
  index: number;
  match: MatchPairConfig;
  gameSeed: number;
}): { summary: GameSummary; record: GameRecord } {
  const moves = structuredClone(TERMINAL_MOVES.BLACK.slice(0, 3));
  const jevTurns = countJevTurns(moves.length, params.match.jevSide);
  return {
    record: {
      schemaVersion: 1,
      rulesVersion: RECORD_RULES_VERSION,
      matchId: params.gameId,
      kind: 'bot',
      startedAt: '2026-09-20T00:00:00.000Z',
      endedAt: '2026-09-20T00:00:10.000Z',
      status: 'abandoned',
      players: {
        BLACK: { kind: 'bot', rating: 1200 },
        WHITE: { kind: 'bot', rating: params.match.botRating },
      },
      config: structuredClone(DEFAULT_CONFIG),
      moves,
      reason: 'simulated_api_error',
      revision: moves.length,
    },
    summary: {
      gameId: params.gameId,
      index: params.index,
      ...params.match,
      seed: params.gameSeed,
      winner: null,
      winnerReason: null,
      outcome: 'aborted_error',
      totalPlies: moves.length,
      jevAttemptsCount: jevTurns + 1,
      jevTurnsCount: jevTurns,
      retryCount: 0,
      failureCodes: ['timeout'],
      completedAfterRecovery: false,
      jevPlacementsCount: 0,
      jevMovesCount: jevTurns,
      searchSummary: {
        minCompletedDepth: 4,
        maxCompletedDepth: 4,
        avgCompletedDepth: 4,
        totalSearchMs: 100,
        avgSearchMs: 10,
        totalNodes: 1000,
        avgNodes: 100,
      },
      apiSummary: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 },
      error: 'simulated API timeout',
    },
  };
}

function reportFor(seed: number, enginePath: string, games: GameSummary[]): BenchReport {
  const completed = games.filter((game) => game.outcome === 'jev_win' || game.outcome === 'jev_loss');
  const wins = games.filter((game) => game.outcome === 'jev_win').length;
  const failureCodes = games.flatMap((game) => game.failureCodes);
  const recovered = games.filter((game) => game.completedAfterRecovery).length;
  return {
    format: 'mongjin-jev-benchmark-report-1',
    createdAt: '2026-09-20T00:02:00.000Z',
    mode: 'live',
    reproducibility: {
      seed,
      maxPlies: 100,
      turnTimeoutMs: 30_000,
      turnPauseMs: 5_000,
      transientRetries: 2,
      retryCooldownMs: 30_000,
      enginePath,
      model: 'typesafe-ai/jev',
      policyVersion: enginePath.includes('baseline') ? 'parallel-v9' : 'candidate-v1',
      rulesVersion: RECORD_RULES_VERSION,
      note: 'synthetic local canonical records',
    },
    matrix: structuredClone(MATRIX),
    summary: {
      totalGames: games.length,
      completedGames: completed.length,
      unfinishedPlycapGames: games.filter((game) => game.outcome === 'unfinished_plycap').length,
      abortedGames: games.filter((game) => game.outcome === 'aborted_error').length,
      jevWins: wins,
      jevLosses: games.filter((game) => game.outcome === 'jev_loss').length,
      jevWinRateExcludingUnfinished: completed.length === 0 ? 0 : wins / completed.length,
      totalTokens: 0,
      totalCost: 0,
      jevAttemptsCount: games.reduce((total, game) => total + game.jevAttemptsCount, 0),
      jevTurnsCount: games.reduce((total, game) => total + game.jevTurnsCount, 0),
      retryCount: games.reduce((total, game) => total + game.retryCount, 0),
      failureCodes,
      completedAfterRecovery: recovered > 0,
      completedAfterRecoveryGames: recovered,
    },
    games,
  };
}

async function writeRun(root: string, name: string, options: RunOptions): Promise<string> {
  const runRoot = join(root, name);
  for (let seedIndex = 0; seedIndex < SEEDS.length; seedIndex++) {
    const directory = join(runRoot, `run-${seedIndex + 1}`);
    await mkdir(directory, { recursive: true });
    const games: GameSummary[] = [];
    for (let matrixIndex = 0; matrixIndex < MATRIX.length; matrixIndex++) {
      const match = MATRIX[matrixIndex]!;
      const gameId = `${name}-${seedIndex}-${matrixIndex}`;
      const gameSeed = SEEDS[seedIndex]! + (matrixIndex + 1) * 7919;
      const abort = options.abortCondition?.seedIndex === seedIndex
        && options.abortCondition.matrixIndex === matrixIndex;
      const error = options.errorCondition?.seedIndex === seedIndex
        && options.errorCondition.matrixIndex === matrixIndex
        ? options.errorCondition
        : undefined;
      const generated = abort
        ? makeAbortedGame({ gameId, index: matrixIndex + 1, match, gameSeed })
        : makeCompletedGame({
          gameId,
          index: matrixIndex + 1,
          match,
          gameSeed,
          jevWins: options.winPlan(seedIndex, matrixIndex),
          failureCode: error?.code,
          retries: error?.retries,
        });
      games.push(generated.summary);
      await writeFile(
        join(directory, `${gameId}.record.json`),
        `${JSON.stringify(generated.record, null, 2)}\n`,
      );
    }
    await writeFile(
      join(directory, 'report.json'),
      `${JSON.stringify(reportFor(SEEDS[seedIndex]!, options.enginePath, games), null, 2)}\n`,
    );
  }
  return runRoot;
}

async function writeSpec(path: string, baselineEngine: string): Promise<void> {
  await writeFile(path, `${JSON.stringify({
    version: 'jev-strength-gate-1',
    baselineCommit: '1f4eb3cd5d499a596dcc54575d0c7710840edb17',
    baselineEngine,
    developmentRecords: ['development-only'],
    evaluationSeeds: SEEDS,
    matrix: { opponents: ['bot-alpha', 'bot-beta'], sides: ['BLACK', 'WHITE'] },
    gate: {
      completedPairs: 12,
      candidateMinimumWins: 8,
      minimumWinGainVsBaseline: 3,
      minimumWinsPerOpponentSide: 1,
      errorAttemptRateMustNotIncrease: true,
    },
    timing: { turnPauseMs: 5000, transientRetries: 2, maxPlies: 100 },
    note: 'Synthetic predeclared evaluation spec.',
  }, null, 2)}\n`);
}

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'compare-jev-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const oneWinPerStratum: OutcomePlan = (seedIndex) => seedIndex === 0;
const twoWinsPerStratum: OutcomePlan = (seedIndex) => seedIndex < 2;

describe('compareJev offline release gate', () => {
  it('accepts 12 canonical pairs that meet the predeclared spec and writes JSON', async () => {
    await withTempDir(async (directory) => {
      const baselineEngine = join(directory, 'baseline-engine.ts');
      const candidateEngine = join(directory, 'candidate-engine.ts');
      const baseline = await writeRun(directory, 'baseline', {
        enginePath: baselineEngine,
        winPlan: oneWinPerStratum,
      });
      const candidate = await writeRun(directory, 'candidate', {
        enginePath: candidateEngine,
        winPlan: twoWinsPerStratum,
      });
      const specPath = join(directory, 'evaluation-spec.json');
      const outPath = join(directory, 'comparison.json');
      await writeSpec(specPath, baselineEngine);

      const result = await compareJevRuns({
        baseline: { name: 'parallel-v9', path: baseline },
        candidate: { name: 'candidate-v1', path: candidate },
        specPath,
        outPath,
      });

      expect(result.recommendation).toBe('accept_candidate');
      expect(result.pairing).toMatchObject({ intendedPairs: 12, observedPairs: 12, completedPairs: 12 });
      expect(result.runs.baseline.wins).toBe(4);
      expect(result.runs.candidate.wins).toBe(8);
      expect(result.runs.candidate.apiRetries).toBe(0);
      expect(result.checks.every((check) => check.passed)).toBe(true);
      expect(JSON.parse(await readFile(outPath, 'utf8'))).toMatchObject({
        format: 'mongjin-jev-comparison-report-1',
        recommendation: 'accept_candidate',
      });
    });
  });

  it('rejects a best-known/no-improvement result without a finite-sample waiver', async () => {
    await withTempDir(async (directory) => {
      const baseline = await writeRun(directory, 'baseline', {
        enginePath: join(directory, 'baseline-engine.ts'),
        winPlan: oneWinPerStratum,
      });
      const candidate = await writeRun(directory, 'candidate', {
        enginePath: join(directory, 'candidate-engine.ts'),
        winPlan: oneWinPerStratum,
      });
      const result = await compareJevRuns({
        baseline: { name: 'best-known', path: baseline },
        candidate: { name: 'same-strength', path: candidate },
      });

      expect(result.recommendation).toBe('reject_candidate');
      expect(result.runs.candidate.wins).toBe(4);
      expect(result.checks.find((check) => check.id === 'candidate-minimum-wins')?.passed).toBe(false);
      expect(result.checks.find((check) => check.id === 'win-gain-vs-baseline')?.actual).toBe(0);
      expect(result.claim).toContain('failed criteria are not waived');
    });
  });

  it('keeps API retries separate and rejects an increased error-attempt rate', async () => {
    await withTempDir(async (directory) => {
      const baseline = await writeRun(directory, 'baseline', {
        enginePath: join(directory, 'baseline-engine.ts'),
        winPlan: oneWinPerStratum,
      });
      const candidate = await writeRun(directory, 'candidate', {
        enginePath: join(directory, 'candidate-engine.ts'),
        winPlan: twoWinsPerStratum,
        errorCondition: { seedIndex: 0, matrixIndex: 0, code: 'http_429', retries: 1 },
      });
      const result = await compareJevRuns({
        baseline: { name: 'baseline', path: baseline },
        candidate: { name: 'candidate', path: candidate },
      });

      expect(result.runs.candidate.apiRetries).toBe(1);
      expect(result.runs.candidate.errorAttempts).toBe(1);
      expect(result.runs.candidate.errorAttemptsByCode).toEqual({ http_429: 1 });
      expect(result.checks.find((check) => check.id === 'aborted-or-error-attempt-rate')?.passed).toBe(false);
      expect(result.recommendation).toBe('reject_candidate');
    });
  });

  it('retains an aborted legal record as an incomplete pair and never counts it as a win', async () => {
    await withTempDir(async (directory) => {
      const baseline = await writeRun(directory, 'baseline', {
        enginePath: join(directory, 'baseline-engine.ts'),
        winPlan: oneWinPerStratum,
      });
      const candidate = await writeRun(directory, 'candidate', {
        enginePath: join(directory, 'candidate-engine.ts'),
        winPlan: twoWinsPerStratum,
        abortCondition: { seedIndex: 0, matrixIndex: 0 },
      });
      const result = await compareJevRuns({
        baseline: { name: 'baseline', path: baseline },
        candidate: { name: 'candidate', path: candidate },
      });

      expect(result.pairing.completedPairs).toBe(11);
      expect(result.pairing.incompletePairs).toHaveLength(1);
      expect(result.runs.candidate.abortedGames).toBe(1);
      expect(result.runs.candidate.wins).toBe(7);
      expect(result.checks.find((check) => check.id === 'all-pairs-completed')?.passed).toBe(false);
      expect(result.recommendation).toBe('reject_candidate');
    });
  });

  it('rejects unreported records, mismatched seeds/config, and invalid moves before scoring', async () => {
    await withTempDir(async (directory) => {
      const baseline = await writeRun(directory, 'baseline', {
        enginePath: join(directory, 'baseline-engine.ts'),
        winPlan: oneWinPerStratum,
      });
      const candidate = await writeRun(directory, 'candidate', {
        enginePath: join(directory, 'candidate-engine.ts'),
        winPlan: twoWinsPerStratum,
      });
      const reportPath = join(candidate, 'run-1', 'report.json');
      const report = JSON.parse(await readFile(reportPath, 'utf8')) as BenchReport;
      const recordPath = join(candidate, 'run-1', `${report.games[0]!.gameId}.record.json`);
      const originalRecordSource = await readFile(recordPath, 'utf8');
      const unreportedPath = join(candidate, 'run-1', 'unreported-attempt.record.json');
      await writeFile(unreportedPath, originalRecordSource);

      await expect(compareJevRuns({
        baseline: { name: 'baseline', path: baseline },
        candidate: { name: 'candidate', path: candidate },
      })).rejects.toThrow('unreported or missing records are forbidden');
      await rm(unreportedPath);

      report.games[0]!.seed += 1;
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

      await expect(compareJevRuns({
        baseline: { name: 'baseline', path: baseline },
        candidate: { name: 'candidate', path: candidate },
      })).rejects.toThrow('Per-game seed mismatch');

      report.games[0]!.seed -= 1;
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      const record = JSON.parse(await readFile(recordPath, 'utf8')) as GameRecord;
      record.config.guardCount += 1;
      await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);

      await expect(compareJevRuns({
        baseline: { name: 'baseline', path: baseline },
        candidate: { name: 'candidate', path: candidate },
      })).rejects.toThrow('Rule config mismatch');

      record.config.guardCount -= 1;
      record.moves[0] = { kind: 'PLACE', to: { r: 99, c: 99 } };
      await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);

      await expect(compareJevRuns({
        baseline: { name: 'baseline', path: baseline },
        candidate: { name: 'candidate', path: candidate },
      })).rejects.toThrow('canonical replay failed');
    });
  });

  it('parses named run CLI inputs and requires a JSON output path', () => {
    expect(parseCompareArgs([
      '--baseline', 'v9=/tmp/base',
      '--candidate', 'v10=/tmp/candidate',
      '--spec', '/tmp/spec.json',
      '--out', '/tmp/comparison.json',
    ])).toEqual({
      baseline: { name: 'v9', path: '/tmp/base' },
      candidate: { name: 'v10', path: '/tmp/candidate' },
      specPath: '/tmp/spec.json',
      outPath: '/tmp/comparison.json',
    });
    expect(() => parseCompareArgs([
      '--baseline', 'v9=/tmp/base', '--candidate', 'v10=/tmp/candidate',
    ])).toThrow('--out is required');
    expect(() => parseCompareArgs([
      '--baseline', '/tmp/base', '--candidate', 'v10=/tmp/candidate', '--out', '/tmp/out.json',
    ])).toThrow('--baseline must use name=path');
  });
});
