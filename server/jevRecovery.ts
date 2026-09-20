import { setTimeout as delay } from 'node:timers/promises';
import { JevError } from './jev';

export const JEV_RECOVERY_POLICY = {
  version: 'retry-v1',
  maxRetries: 2,
  retryDelaysMs: [500, 1_500],
  minimumRetryBudgetMs: 1_000,
  baseCooldownMs: 15_000,
  maxCooldownMs: 120_000,
} as const;

export function classifyJevFailure(error: unknown) {
  const code = error instanceof JevError ? error.code : 'unavailable';
  const status = error instanceof JevError ? error.status : undefined;
  const retryable = code === 'timeout' || code === 'http_429' || code === 'worker_error'
    || (code === 'http_error' && (status === undefined || status === 408 || status === 429
      || (status >= 500 && status <= 599)));
  return { code, status, retryable };
}

export async function waitForJevRetry(ms: number, signal?: AbortSignal): Promise<void> {
  try { await delay(ms, undefined, { signal }); }
  catch (error) {
    if (signal?.aborted) throw new JevError('aborted', 'JEV retry cancelled');
    throw error;
  }
}
