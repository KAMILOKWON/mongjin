import { expect, it, vi } from 'vitest';
import { JevError } from './jev';
import { preserveJevTurn } from './jevMatchRecovery';

function harness() {
  let time = 0;
  const controller = new AbortController();
  const options = {
    signal: controller.signal, expiresAt: 1_000_000,
    isCurrent: () => true, unavailableReason: (): string | null => null,
    retryAfterMs: () => 0, onRetry: vi.fn(), now: () => time,
    wait: vi.fn(async (ms: number) => { time += ms; }),
  };
  return { options, controller };
}

it('preserves a turn through sustained 503 failures and returns only the eventual decision', async () => {
  const { options } = harness();
  const decision = { id: 'p_7_4' };
  let calls = 0;
  const operation = vi.fn(async () => {
    if (++calls <= 5) throw new JevError('http_error', '503', 503);
    return decision;
  });
  expect(await preserveJevTurn(operation, options)).toBe(decision);
  expect(operation).toHaveBeenCalledTimes(6);
  expect(options.wait.mock.calls.map(([ms]) => ms)).toEqual([15000, 30000, 60000, 120000, 120000]);
});

it.each(['non_free', 'invalid_response', 'input_budget'] as const)('does not loop on %s', async code => {
  const { options } = harness();
  const operation = vi.fn(async () => { throw new JevError(code, code); });
  await expect(preserveJevTurn(operation, options)).rejects.toMatchObject({ code });
  expect(operation).toHaveBeenCalledOnce();
  expect(options.wait).not.toHaveBeenCalled();
});

it('stops at the promotion cutoff without another remote attempt', async () => {
  const { options } = harness();
  options.expiresAt = 10000;
  const operation = vi.fn(async () => { throw new JevError('http_error', '503', 503); });
  await expect(preserveJevTurn(operation, options)).rejects.toThrow('experiment expired');
  expect(operation).toHaveBeenCalledOnce();
  expect(options.wait).toHaveBeenCalledWith(10000, options.signal);
});

it.each(['leave', 'state-change'] as const)('never starts another decision after %s during recovery', async why => {
  const { options, controller } = harness();
  options.wait = vi.fn(async () => {
    if (why === 'leave') controller.abort();
    else options.isCurrent = () => false;
  });
  const operation = vi.fn(async () => { throw new JevError('http_error', '503', 503); });
  await expect(preserveJevTurn(operation, options)).rejects.toMatchObject({ code: 'aborted' });
  expect(operation).toHaveBeenCalledOnce();
});

it('discards a result if the room changed while awaiting it', async () => {
  const { options } = harness();
  await expect(preserveJevTurn(async () => {
    options.isCurrent = () => false;
    return 'stale decision';
  }, options)).rejects.toMatchObject({ code: 'aborted' });
});

it('honors a global hard stop and a longer current cooldown', async () => {
  const { options } = harness();
  options.retryAfterMs = () => 30000;
  const failure = new JevError('http_error', '503', 503);
  const operation = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce('ok');
  await preserveJevTurn(operation, options);
  expect(options.wait).toHaveBeenCalledWith(30000, options.signal);
  options.unavailableReason = () => 'billing_unverified';
  options.wait.mockClear();
  await expect(preserveJevTurn(async () => { throw failure; }, options)).rejects.toBe(failure);
  expect(options.wait).not.toHaveBeenCalled();
});
