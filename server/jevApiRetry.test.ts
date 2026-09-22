import { expect, it, vi } from 'vitest';
import { JevError } from './jev';
import { JEV_API_RETRY_POLICY, isTransientJevApiError, runJevApiWithRetry } from './jevApiRetry';

it('retries only transient API failures with 1/2/4 second backoff inside one deadline', async () => {
  let now = 1_000;
  const wait = vi.fn(async (ms: number) => { now += ms; });
  const errors = [
    new JevError('http_error', 'unavailable', 503),
    new JevError('http_429', 'limited', 429),
    new JevError('provider_unavailable', 'alias unavailable', 400),
  ];
  const attempt = vi.fn(async () => {
    const error = errors.shift();
    if (error) throw error;
    return 'ok';
  });

  await expect(runJevApiWithRetry({ deadlineMs: 20_000, attempt,
    dependencies: { now: () => now, wait } })).resolves.toBe('ok');
  expect(attempt).toHaveBeenCalledTimes(4);
  expect(wait.mock.calls.map(([ms]) => ms)).toEqual([...JEV_API_RETRY_POLICY.delaysMs]);
});

it.each([
  new JevError('invalid_response', 'malformed'),
  new JevError('non_free', 'nonzero cost'),
  new JevError('timeout', 'deadline'),
  new JevError('aborted', 'cancelled'),
  new JevError('http_error', 'fatal', 403),
])('does not retry hard failure %#', async (error) => {
  const attempt = vi.fn(async () => { throw error; });
  const wait = vi.fn();
  await expect(runJevApiWithRetry({ deadlineMs: Date.now() + 10_000, attempt,
    dependencies: { wait } })).rejects.toBe(error);
  expect(attempt).toHaveBeenCalledTimes(1);
  expect(wait).not.toHaveBeenCalled();
});

it('does not wait when the next retry cannot leave a useful attempt window', async () => {
  let now = 9_000;
  const error = new JevError('http_error', 'unavailable', 503);
  const attempt = vi.fn(async () => { throw error; });
  const wait = vi.fn(async (ms: number) => { now += ms; });
  await expect(runJevApiWithRetry({ deadlineMs: 10_100, attempt,
    dependencies: { now: () => now, wait } })).rejects.toBe(error);
  expect(attempt).toHaveBeenCalledTimes(1);
  expect(wait).not.toHaveBeenCalled();
});

it('classifies network-like HTTP failures but not validation, billing, abort or deadline failures', () => {
  expect(isTransientJevApiError(new JevError('http_error', 'network'))).toBe(true);
  expect(isTransientJevApiError(new JevError('http_error', 'timeout response', 408))).toBe(true);
  expect(isTransientJevApiError(new JevError('http_error', 'bad gateway', 502))).toBe(true);
  expect(isTransientJevApiError(new JevError('invalid_response', 'bad answer'))).toBe(false);
  expect(isTransientJevApiError(new JevError('non_free', 'cost'))).toBe(false);
  expect(isTransientJevApiError(new JevError('timeout', 'deadline'))).toBe(false);
  expect(isTransientJevApiError(new JevError('aborted', 'cancelled'))).toBe(false);
});
