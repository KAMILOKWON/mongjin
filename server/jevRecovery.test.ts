import { expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState, legalMoves } from '../src/core/rules';
import { JevError } from './jev';
import { JEV_EXPIRES_AT, JevExperiment } from './jevExperiment';
import { ParallelTurnError, type ParallelTurnTrace } from './jevParallel';
import { classifyJevFailure, JEV_RECOVERY_POLICY } from './jevRecovery';

const state = initialState(DEFAULT_CONFIG);
const decision = {
  move: legalMoves(state, DEFAULT_CONFIG)[0]!,
  elapsedMs: 20,
  model: 'typesafe-ai/jev',
  inputTokens: 100,
  outputTokens: 1,
  cost: 0,
};
const env = { MONGJIN_JEV_ENABLED: '1', AI_GATEWAY_API_KEY: 'test-key' };
const start = Date.parse('2026-09-20T00:00:00Z');

it('classifies only transient transport and worker failures as retryable', () => {
  expect(JEV_RECOVERY_POLICY).toEqual({
    version: 'retry-v1',
    maxRetries: 2,
    retryDelaysMs: [500, 1_500],
    minimumRetryBudgetMs: 1_000,
    baseCooldownMs: 15_000,
    maxCooldownMs: 120_000,
  });

  for (const error of [
    new JevError('http_error', 'network'),
    new JevError('http_error', 'request timeout', 408),
    new JevError('http_error', 'rate limited', 429),
    new JevError('http_error', 'bad gateway', 502),
    new JevError('http_429', 'limited', 429),
    new JevError('timeout', 'timed out'),
    new JevError('worker_error', 'worker exited'),
  ]) {
    expect(classifyJevFailure(error)).toMatchObject({ code: error.code, retryable: true });
  }

  for (const error of [
    new JevError('http_error', 'bad request', 400),
    new JevError('http_error', 'forbidden', 403),
    new JevError('invalid_response', 'invalid'),
    new JevError('non_free', 'paid'),
  ]) {
    expect(classifyJevFailure(error)).toMatchObject({ code: error.code, retryable: false });
  }
  expect(classifyJevFailure(new Error('unknown'))).toEqual({
    code: 'unavailable', status: undefined, retryable: false,
  });
});

it('retries one HTTP 503 with the same state and one shared deadline, then records recovery', async () => {
  let time = start;
  const before = structuredClone(state);
  const decide = vi.fn()
    .mockRejectedValueOnce(new JevError('http_error', 'unavailable', 503))
    .mockResolvedValueOnce(decision);
  const wait = vi.fn(async (ms: number) => { time += ms; });
  const experiment = new JevExperiment(env, () => time, decide as any, wait);

  await expect(experiment.move(state, DEFAULT_CONFIG)).resolves.toEqual(decision);

  expect(decide).toHaveBeenCalledTimes(2);
  expect(decide.mock.calls[0]![0]).toEqual(before);
  expect(decide.mock.calls[1]![0]).toEqual(before);
  expect(decide.mock.calls[0]![0]).not.toBe(state);
  expect(decide.mock.calls[1]![0]).not.toBe(decide.mock.calls[0]![0]);
  expect(state).toEqual(before);
  const firstOptions = (decide.mock.calls[0] as unknown as [unknown, unknown, { timeoutMs: number }])[2];
  expect(firstOptions.timeoutMs).toBe(30_000);
  expect(decide.mock.calls[1]![2].timeoutMs).toBe(29_500);
  expect(wait).toHaveBeenCalledOnce();
  expect(wait).toHaveBeenCalledWith(500, undefined);
  expect(experiment.status).toMatchObject({
    turns: 1,
    successfulMoves: 1,
    failures: 0,
    attempts: 2,
    attemptFailures: 1,
    retries: 1,
    recoveredTurns: 1,
    consecutiveFailures: 0,
    recoveryPolicy: 'retry-v1',
    reason: null,
    cooldownUntil: null,
    retryAfterMs: 0,
  });
});

it('does not retry fatal HTTP 403 or permanently recover it', async () => {
  const decide = vi.fn().mockRejectedValue(new JevError('http_error', 'forbidden', 403));
  const wait = vi.fn(async () => undefined);
  const experiment = new JevExperiment(env, () => start, decide, wait);

  await expect(experiment.move(state, DEFAULT_CONFIG)).rejects.toMatchObject({
    code: 'http_error', status: 403,
  });
  expect(decide).toHaveBeenCalledOnce();
  expect(wait).not.toHaveBeenCalled();
  expect(experiment.canMatch).toBe(false);
  expect(experiment.status).toMatchObject({
    turns: 1,
    failures: 1,
    attempts: 1,
    attemptFailures: 1,
    retries: 0,
    reason: 'http_403',
    lastError: { code: 'http_error', status: 403, retryable: false, at: start },
  });
});

it('does not retry or resume after an unverified billing result', async () => {
  const decide = vi.fn().mockResolvedValue({ ...decision, cost: null });
  const wait = vi.fn(async () => undefined);
  const experiment = new JevExperiment(env, () => start, decide, wait);

  await expect(experiment.move(state, DEFAULT_CONFIG)).rejects.toThrow('billing_unverified');
  expect(decide).toHaveBeenCalledOnce();
  expect(wait).not.toHaveBeenCalled();
  expect(experiment.canMatch).toBe(false);
  expect(experiment.status).toMatchObject({
    turns: 1,
    successfulMoves: 0,
    failures: 1,
    attempts: 1,
    retries: 0,
    reason: 'billing_unverified',
  });
});

it('backs off exhausted transient turns without a permanent stop and resets after success', async () => {
  let time = start;
  let shouldSucceed = false;
  const decide = vi.fn(async () => {
    if (shouldSucceed) return decision;
    throw new JevError('timeout', 'temporary timeout');
  });
  const wait = vi.fn(async (ms: number) => { time += ms; });
  const experiment = new JevExperiment(env, () => time, decide as any, wait);
  const cooldowns = [15_000, 30_000, 60_000, 120_000, 120_000];

  for (const [index, cooldown] of cooldowns.entries()) {
    await expect(experiment.move(state, DEFAULT_CONFIG)).rejects.toMatchObject({ code: 'timeout' });
    expect(experiment.status).toMatchObject({
      turns: index + 1,
      failures: index + 1,
      consecutiveFailures: index + 1,
      reason: 'transient_cooldown',
      retryAfterMs: cooldown,
    });
    expect(experiment.canMatch).toBe(false);
    time += cooldown;
    expect(experiment.status.reason).toBeNull();
    expect(experiment.status.retryAfterMs).toBe(0);
    expect(experiment.canMatch).toBe(true);
  }

  shouldSucceed = true;
  await expect(experiment.move(state, DEFAULT_CONFIG)).resolves.toEqual(decision);
  expect(experiment.status).toMatchObject({
    turns: 6,
    successfulMoves: 1,
    failures: 5,
    attempts: 16,
    attemptFailures: 15,
    retries: 10,
    recoveredTurns: 0,
    consecutiveFailures: 0,
    reason: null,
    cooldownUntil: null,
    retryAfterMs: 0,
  });
});

it('does not start a retry without the minimum shared turn or experiment budget', async () => {
  let time = start;
  const decide = vi.fn(async () => {
    time += 29_001;
    throw new JevError('http_error', 'late 503', 503);
  });
  const wait = vi.fn(async (ms: number) => { time += ms; });
  const experiment = new JevExperiment(env, () => time, decide, wait);

  await expect(experiment.move(state, DEFAULT_CONFIG)).rejects.toMatchObject({ code: 'http_error' });
  expect(decide).toHaveBeenCalledOnce();
  const turnOptions = (decide.mock.calls[0] as unknown as [unknown, unknown, { timeoutMs: number }])[2];
  expect(turnOptions.timeoutMs).toBe(30_000);
  expect(wait).not.toHaveBeenCalled();
  expect(experiment.status).toMatchObject({ attempts: 1, retries: 0, failures: 1 });

  const cutoff = Date.parse(JEV_EXPIRES_AT);
  time = cutoff - 1_200;
  const expiringDecide = vi.fn(async () => {
    time += 300;
    throw new JevError('http_error', 'late 503', 503);
  });
  const expiringWait = vi.fn(async (ms: number) => { time += ms; });
  const expiring = new JevExperiment(env, () => time, expiringDecide as any, expiringWait);

  await expect(expiring.move(state, DEFAULT_CONFIG)).rejects.toMatchObject({ code: 'http_error' });
  expect(expiringDecide).toHaveBeenCalledOnce();
  const expiringOptions = (expiringDecide.mock.calls[0] as unknown as [unknown, unknown, { timeoutMs: number }])[2];
  expect(expiringOptions.timeoutMs).toBe(1_200);
  expect(expiringWait).not.toHaveBeenCalled();
  time = cutoff;
  await expect(expiring.move(state, DEFAULT_CONFIG)).rejects.toThrow('jev_expired');
  expect(expiringDecide).toHaveBeenCalledOnce();
});

it('cancels during retry wait without counting a failed turn or retry', async () => {
  const controller = new AbortController();
  const decide = vi.fn().mockRejectedValue(new JevError('http_error', 'unavailable', 503));
  const wait = vi.fn((_ms: number, signal?: AbortSignal) => new Promise<void>((_resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const experiment = new JevExperiment(env, () => start, decide, wait);

  const pending = experiment.move(state, DEFAULT_CONFIG, controller.signal);
  await vi.waitFor(() => expect(wait).toHaveBeenCalledOnce());
  controller.abort(new Error('caller cancelled'));
  await expect(pending).rejects.toThrow('caller cancelled');

  expect(decide).toHaveBeenCalledOnce();
  expect(experiment.status).toMatchObject({
    turns: 1,
    successfulMoves: 0,
    failures: 0,
    attempts: 1,
    attemptFailures: 1,
    retries: 0,
    consecutiveFailures: 0,
    reason: null,
    cooldownUntil: null,
    retryAfterMs: 0,
  });
});

it('awaits the failed trace sink before waiting and starting the retry', async () => {
  let time = start;
  const order: string[] = [];
  const trace = { turnId: 'failed-attempt' } as unknown as ParallelTurnTrace;
  const decide = vi.fn(async () => {
    if (decide.mock.calls.length === 1) {
      order.push('attempt-1');
      throw new ParallelTurnError('http_error', trace);
    }
    order.push('attempt-2');
    return decision;
  });
  const wait = vi.fn(async (ms: number) => { order.push('wait'); time += ms; });
  const onRetryTrace = vi.fn(async (failed: ParallelTurnTrace) => {
    order.push('trace-start');
    expect(failed).toBe(trace);
    await Promise.resolve();
    order.push('trace-end');
  });
  const experiment = new JevExperiment(env, () => time, decide as any, wait);

  await expect(experiment.move(
    state, DEFAULT_CONFIG, undefined, 'trace-game', undefined, onRetryTrace,
  )).resolves.toEqual(decision);

  expect(onRetryTrace).toHaveBeenCalledOnce();
  expect(order).toEqual(['attempt-1', 'trace-start', 'trace-end', 'wait', 'attempt-2']);
});
