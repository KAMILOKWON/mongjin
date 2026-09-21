import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseBenchArgs,
  resolveMatches,
  createPrng,
  runBenchmark,
  preflightOutdir,
  playSingleGame,
  type BenchReport,
  type JevMoveChooser,
} from './benchJev';
import { chooseParallelJevMove as chooseActualJevMove, type ParallelTurnTrace } from './jevParallel';
import { analyzeJevReplyRollouts } from './jevReplyRollouts';
import { JEV_MODEL } from './jevGateway';
import { JEV_PARALLEL_POLICY, jevMoveId, jevStateHash } from './jevPolicy';
import { DEFAULT_CONFIG } from '../src/core/config';
import { legalMoves } from '../src/core/rules';
import { JevError } from './jev';
import { mockEvaluateJev } from './verifyJev';

// Harness tests exercise persistence/retries; search-proposal behavior has its
// own canonical and integration tests without repeating a 4.3s search per turn.
const chooseParallelJevMove: typeof chooseActualJevMove = options => chooseActualJevMove({
  ...options, searchProposal: () => null,
});

const MAY_MATCH = {
  botId: 'ranked-bot-may',
  botName: '연세대MAY',
  botRating: 1000,
  jevSide: 'BLACK' as const,
};

describe('benchJev CLI harness unit tests', () => {
  it('parses valid args and sets defaults', () => {
    const parsed = parseBenchArgs(['--mock', '--outdir', '/tmp/out']);
    expect(parsed.mode).toBe('mock');
    expect(parsed.outdir).toBe('/tmp/out');
    expect(parsed.maxPlies).toBe(80);
    expect(parsed.seed).toBe(20260920);
    expect(parsed.side).toBe('both');
    expect(parsed.transientRetries).toBe(0);
  });

  it('accepts only explicit bounded transient retry counts', () => {
    expect(parseBenchArgs([
      '--mock', '--outdir', '/tmp/out', '--transient-retries', '2',
    ]).transientRetries).toBe(2);
    expect(() => parseBenchArgs([
      '--mock', '--outdir', '/tmp/out', '--transient-retries=-1',
    ])).toThrow('--transient-retries must be an integer between 0 and 2');
    expect(() => parseBenchArgs([
      '--mock', '--outdir', '/tmp/out', '--transient-retries', '3',
    ])).toThrow('--transient-retries must be an integer between 0 and 2');
    expect(() => parseBenchArgs([
      '--mock', '--outdir', '/tmp/out', '--transient-retries', '1.5',
    ])).toThrow('--transient-retries must be a valid integer');
  });

  it('(1) strictly rejects malformed junk/floats in integer options', () => {
    expect(() =>
      parseBenchArgs(['--mock', '--outdir', '/tmp/out', '--max-plies', '80abc']),
    ).toThrow('must be a valid integer');
    expect(() =>
      parseBenchArgs(['--mock', '--outdir', '/tmp/out', '--max-plies', '80.5']),
    ).toThrow('must be a valid integer');
    expect(() =>
      parseBenchArgs(['--mock', '--outdir', '/tmp/out', '--seed', '123junk']),
    ).toThrow('must be a valid integer');
    expect(() =>
      parseBenchArgs(['--mock', '--outdir', '/tmp/out', '--rating', '1500.2']),
    ).toThrow('must be a valid integer');
  });

  it('rejects other invalid args', () => {
    expect(() => parseBenchArgs(['--outdir', '/tmp/out'])).toThrow(
      'Choose exactly one of --mock or --live',
    );
    expect(() => parseBenchArgs(['--live', '--outdir', '/tmp/out'])).toThrow(
      '--live requires --key-file',
    );
    expect(() =>
      parseBenchArgs(['--mock', '--outdir', '/tmp/out', '--max-plies', '150']),
    ).toThrow('--max-plies must be a positive integer <= 120');
    expect(() =>
      parseBenchArgs(['--mock', '--outdir', '/tmp/out', '--side', 'INVALID']),
    ).toThrow('--side must be BLACK, WHITE, or both');
  });

  it('resolves matches according to bot/rating/matrix/default', () => {
    const defaultMatches = resolveMatches({
      mode: 'mock',
      outdir: '/tmp',
      side: 'both',
      maxPlies: 80,
      seed: 1,
      matrix: false,
    });
    expect(defaultMatches).toHaveLength(2);
    expect(defaultMatches[0]?.botId).toBe('ranked-bot-furnace');
    expect(defaultMatches[0]?.jevSide).toBe('BLACK');
    expect(defaultMatches[1]?.jevSide).toBe('WHITE');

    const singleBotMatches = resolveMatches({
      mode: 'mock',
      outdir: '/tmp',
      bot: 'ranked-bot-may',
      side: 'BLACK',
      maxPlies: 80,
      seed: 1,
      matrix: false,
    });
    expect(singleBotMatches).toHaveLength(1);
    expect(singleBotMatches[0]?.botId).toBe('ranked-bot-may');
    expect(singleBotMatches[0]?.jevSide).toBe('BLACK');

    const matrixMatches = resolveMatches({
      mode: 'mock',
      outdir: '/tmp',
      side: 'both',
      maxPlies: 80,
      seed: 1,
      matrix: true,
    });
    expect(matrixMatches).toHaveLength(4);
  });

  it('(2) deterministic prng produces repeatable sequence', () => {
    const rng1 = createPrng(42);
    const rng2 = createPrng(42);
    const seq1 = [rng1(), rng1(), rng1(), rng1(), rng1()];
    const seq2 = [rng2(), rng2(), rng2(), rng2(), rng2()];
    expect(seq1).toEqual(seq2);
  });

  it('(3) requires output directory to be empty before any execution', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'bench-nonempty-'));
    try {
      const dummyFile = join(testDir, 'pre-existing.txt');
      await writeFile(dummyFile, 'content', 'utf8');

      await expect(preflightOutdir(testDir)).rejects.toThrow(
        'Output directory must be empty',
      );
    } finally {
      await rm(testDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('rejects a returned move that differs from the trace-selected move', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'bench-trace-move-mismatch-'));
    try {
      const mismatchedEngine: JevMoveChooser = async (opts) => {
        const result = await chooseParallelJevMove({ ...opts, evaluate: mockEvaluateJev });
        const selectedId = jevMoveId(result.move);
        const differentLegalMove = legalMoves(opts.state, opts.config)
          .find((move) => jevMoveId(move) !== selectedId);
        if (!differentLegalMove) throw new Error('test requires a second legal move');
        return { ...result, move: differentLegalMove };
      };
      const options = parseBenchArgs(['--mock', '--outdir', testDir, '--max-plies', '1']);
      const result = await playSingleGame({
        gameIndex: 1,
        match: MAY_MATCH,
        options,
        apiKey: 'test-key',
        chooseJevMove: mismatchedEngine,
        config: DEFAULT_CONFIG,
        outdir: testDir,
      });

      expect(result.summary.outcome).toBe('aborted_error');
      expect(result.summary.failureCodes).toEqual(['invalid_response']);
      expect(result.summary.error).toContain('but returned');
      expect(result.gameRecord.status).toBe('abandoned');
      expect(result.gameRecord.moves).toHaveLength(0);
    } finally {
      await rm(testDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('(4, 5, 8) playSingleGame captures structural trace from non-instanceof error, stops game as abandoned, and retains disk evidence', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'bench-abort-'));
    try {
      const failingEngine: JevMoveChooser = async (opts) => {
        const dummyTrace: ParallelTurnTrace = {
          turnId: 'error-turn-uuid',
          gameId: opts.gameId,
          ply: 0,
          stateHash: 'dummyhash',
          policy: { ...JEV_PARALLEL_POLICY, version: 'parallel-v4' as unknown as typeof JEV_PARALLEL_POLICY.version },
          model: JEV_MODEL,
          config: opts.config,
          snapshot: opts.state,
          deadlineMs: opts.deadlineMs,
          startedAt: new Date().toISOString(),
          status: 'error',
          stages: [],
          searches: [],
          proposals: [],
          gates: [],
          globalResult: 'unknown',
          timings: { searchMs: [] },
        };
        const customErr = new Error('simulated custom gateway 503');
        (customErr as unknown as { trace: unknown }).trace = dummyTrace;
        throw customErr;
      };

      const options = parseBenchArgs(['--mock', '--outdir', testDir]);
      const result = await playSingleGame({
        gameIndex: 1,
        match: MAY_MATCH,
        options,
        apiKey: 'test-key',
        chooseJevMove: failingEngine,
        config: DEFAULT_CONFIG,
        outdir: testDir,
      });

      expect(result.summary.outcome).toBe('aborted_error');
      expect(result.summary.error).toContain('simulated custom gateway 503');
      expect(result.summary.retryCount).toBe(0);
      expect(result.summary.failureCodes).toEqual(['unknown']);
      expect(result.inferredPolicyVersion).toBe('parallel-v4');

      // Check files were streamed to disk
      const files = await readdir(testDir);
      const traceFile = files.find((f) => f.endsWith('.traces.jsonl'));
      const recordFile = files.find((f) => f.endsWith('.record.json'));
      expect(traceFile).toBeDefined();
      expect(recordFile).toBeDefined();

      const traceContent = await readFile(join(testDir, traceFile!), 'utf8');
      expect(traceContent).toContain('error-turn-uuid');
      const recordContent = await readFile(join(testDir, recordFile!), 'utf8');
      const parsedRec = JSON.parse(recordContent);
      expect(parsedRec.status).toBe('abandoned');
    } finally {
      await rm(testDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('retries an explicit 503 once, preserving both valid traces and the exact turn state', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'bench-recover-'));
    try {
      const states: { hash: string; ply: number; snapshot: string; deadlineMs: number }[] = [];
      const explicit503Evaluate: typeof mockEvaluateJev = async (evaluateOptions) => {
        evaluateOptions.onResponse?.({ status: 503, error: 'provider_unavailable' });
        throw new JevError('http_error', 'JEV request failed with HTTP 503.', 503);
      };
      const recoveringEngine: JevMoveChooser = async (opts) => {
        states.push({
          hash: jevStateHash(opts.state),
          ply: opts.state.history.length,
          snapshot: JSON.stringify(opts.state),
          deadlineMs: opts.deadlineMs,
        });
        return chooseParallelJevMove({
          ...opts,
          evaluate: states.length === 1 ? explicit503Evaluate : mockEvaluateJev,
        });
      };

      const options = parseBenchArgs([
        '--mock', '--outdir', testDir, '--max-plies', '1', '--transient-retries', '1',
      ]);
      const result = await playSingleGame({
        gameIndex: 1,
        match: MAY_MATCH,
        options,
        apiKey: 'test-key',
        chooseJevMove: recoveringEngine,
        config: DEFAULT_CONFIG,
        outdir: testDir,
      });

      expect(states).toHaveLength(2);
      expect(states[1]).toMatchObject({
        hash: states[0]!.hash,
        ply: states[0]!.ply,
        snapshot: states[0]!.snapshot,
      });
      expect(states[1]!.deadlineMs).toBeGreaterThanOrEqual(states[0]!.deadlineMs);
      expect(result.summary.outcome).toBe('unfinished_plycap');
      expect(result.summary.jevAttemptsCount).toBe(2);
      expect(result.summary.jevTurnsCount).toBe(1);
      expect(result.summary.retryCount).toBe(1);
      expect(result.summary.failureCodes).toEqual(['http_503']);
      expect(result.summary.completedAfterRecovery).toBe(false);
      expect(result.traces).toHaveLength(2);
      expect(result.traces.map((trace) => trace.stateHash)).toEqual([
        states[0]!.hash,
        states[0]!.hash,
      ]);

      const traceFile = (await readdir(testDir)).find((file) => file.endsWith('.traces.jsonl'))!;
      const persisted = (await readFile(join(testDir, traceFile), 'utf8')).trim().split('\n');
      expect(persisted).toHaveLength(2);
      expect(persisted.map((line) => JSON.parse(line).status)).toEqual(['error', 'selected']);
    } finally {
      await rm(testDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('exhausts the per-turn retry bound after two retries', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'bench-retry-bound-'));
    try {
      let calls = 0;
      const timeoutEvaluate: typeof mockEvaluateJev = async () => {
        throw new JevError('timeout', 'simulated timeout');
      };
      const failingEngine: JevMoveChooser = async (opts) => {
        calls += 1;
        return chooseParallelJevMove({ ...opts, evaluate: timeoutEvaluate });
      };
      const options = parseBenchArgs([
        '--mock', '--outdir', testDir, '--max-plies', '1', '--transient-retries', '2',
      ]);
      const result = await playSingleGame({
        gameIndex: 1,
        match: MAY_MATCH,
        options,
        apiKey: 'test-key',
        chooseJevMove: failingEngine,
        config: DEFAULT_CONFIG,
        outdir: testDir,
      });

      expect(calls).toBe(3);
      expect(result.summary.outcome).toBe('aborted_error');
      expect(result.summary.jevAttemptsCount).toBe(3);
      expect(result.summary.jevTurnsCount).toBe(0);
      expect(result.summary.retryCount).toBe(2);
      expect(result.summary.failureCodes).toEqual(['timeout', 'timeout', 'timeout']);
      expect(result.traces).toHaveLength(3);
    } finally {
      await rm(testDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('caps transient retries at four total across one game', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'bench-game-retry-bound-'));
    try {
      const failedStates = new Set<string>();
      let calls = 0;
      const timeoutEvaluate: typeof mockEvaluateJev = async () => {
        throw new JevError('timeout', 'simulated first-attempt timeout');
      };
      const firstAttemptFails: JevMoveChooser = async (opts) => {
        calls += 1;
        const hash = jevStateHash(opts.state);
        const firstAttemptForState = !failedStates.has(hash);
        if (firstAttemptForState) failedStates.add(hash);
        return chooseParallelJevMove({
          ...opts,
          evaluate: firstAttemptForState ? timeoutEvaluate : mockEvaluateJev,
          // This test covers benchmark retry accounting, not rollout quality.
          // Keep canonical rollout structure while avoiding unrelated search work.
          rollouts: (state, config, moves, rolloutOptions) => analyzeJevReplyRollouts(
            state,
            config,
            moves,
            {
              ...rolloutOptions,
              choose: (rolloutState, rolloutConfig, searchOptions) => {
                searchOptions.onSearchComplete?.({ nodes: 0, completedDepth: 0, elapsedMs: 0, aborted: false });
                return legalMoves(rolloutState, rolloutConfig)[0] ?? null;
              },
            },
          ),
        });
      };
      const options = parseBenchArgs([
        '--mock', '--outdir', testDir, '--max-plies', '20', '--transient-retries', '2',
      ]);
      const result = await playSingleGame({
        gameIndex: 1,
        match: MAY_MATCH,
        options,
        apiKey: 'test-key',
        chooseJevMove: firstAttemptFails,
        config: DEFAULT_CONFIG,
        outdir: testDir,
      });

      expect(result.summary.outcome).toBe('aborted_error');
      expect(result.summary.retryCount).toBe(4);
      expect(result.summary.jevTurnsCount).toBe(4);
      expect(result.summary.jevAttemptsCount).toBe(9);
      expect(result.summary.failureCodes).toEqual([
        'timeout', 'timeout', 'timeout', 'timeout', 'timeout',
      ]);
      expect(calls).toBe(9);
      expect(result.traces).toHaveLength(9);
    } finally {
      await rm(testDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15_000);

  it('never retries non-free or unrecognized HTTP errors', async () => {
    const scenarios = [
      {
        name: 'non-free',
        expectedCode: 'non_free',
        evaluate: async () => { throw new JevError('non_free', 'simulated non-free response'); },
      },
      {
        name: 'http-500',
        expectedCode: 'http_error',
        evaluate: async (evaluateOptions: Parameters<typeof mockEvaluateJev>[0]) => {
          evaluateOptions.onResponse?.({ status: 500, error: 'server_error' });
          throw new JevError('http_error', 'JEV request failed with HTTP 500.', 500);
        },
      },
    ] as const;

    for (const scenario of scenarios) {
      const testDir = await mkdtemp(join(tmpdir(), `bench-${scenario.name}-`));
      try {
        let calls = 0;
        const failingEngine: JevMoveChooser = async (opts) => {
          calls += 1;
          return chooseParallelJevMove({
            ...opts,
            evaluate: scenario.evaluate as typeof mockEvaluateJev,
          });
        };
        const options = parseBenchArgs([
          '--mock', '--outdir', testDir, '--max-plies', '1', '--transient-retries', '2',
        ]);
        const result = await playSingleGame({
          gameIndex: 1,
          match: MAY_MATCH,
          options,
          apiKey: 'test-key',
          chooseJevMove: failingEngine,
          config: DEFAULT_CONFIG,
          outdir: testDir,
        });

        expect(calls, scenario.name).toBe(1);
        expect(result.summary.retryCount, scenario.name).toBe(0);
        expect(result.summary.jevAttemptsCount, scenario.name).toBe(1);
        expect(result.summary.failureCodes, scenario.name).toEqual([scenario.expectedCode]);
      } finally {
        await rm(testDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  });

  it('runs a normal mock benchmark game and verifies 0o600 files and report', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'bench-normal-'));
    try {
      const report: BenchReport = await runBenchmark({
        mode: 'mock',
        outdir: testDir,
        bot: 'ranked-bot-may',
        side: 'BLACK',
        maxPlies: 4,
        seed: 12345,
        matrix: false,
      });

      expect(report.format).toBe('mongjin-jev-benchmark-report-1');
      expect(report.summary.totalGames).toBe(1);
      expect(report.summary.retryCount).toBe(0);
      expect(report.summary.failureCodes).toEqual([]);
      expect(report.summary.completedAfterRecovery).toBe(false);
      expect(report.games).toHaveLength(1);
      const game = report.games[0]!;
      expect(game.jevSide).toBe('BLACK');
      expect(game.botId).toBe('ranked-bot-may');
      expect(game.totalPlies).toBeLessThanOrEqual(4);
      expect(game.jevAttemptsCount).toBe(game.jevTurnsCount);

      const reportFile = await readFile(join(testDir, 'report.json'), 'utf8');
      const parsedReport = JSON.parse(reportFile);
      expect(parsedReport.format).toBe('mongjin-jev-benchmark-report-1');
      expect(parsedReport.reproducibility.policyVersion).toBeDefined();
      expect(parsedReport.reproducibility.transientRetries).toBe(0);
      expect(parsedReport.reproducibility.retryCooldownMs).toBe(0);
      expect(parsedReport.reproducibility.note).toContain('Deterministic seed');

      const traceFile = await readFile(
        join(testDir, `${game.gameId}.traces.jsonl`),
        'utf8',
      );
      expect(traceFile.length).toBeGreaterThan(0);

      const recordFile = await readFile(
        join(testDir, `${game.gameId}.record.json`),
        'utf8',
      );
      const parsedRecord = JSON.parse(recordFile);
      expect(parsedRecord.matchId).toBe(game.gameId);
      expect(parsedRecord.players.BLACK.kind).toBe('bot');
    } finally {
      await rm(testDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 35_000); // Two real local search turns, with mocked API responses.
});
