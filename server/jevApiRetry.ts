import { setTimeout as delay } from 'node:timers/promises';
import { JevError } from './jev';

export const JEV_API_RETRY_POLICY = {
  delaysMs: [1_000, 2_000, 4_000],
  minimumAttemptBudgetMs: 250,
} as const;

export type JevApiRetryDependencies = {
  now?: () => number;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export function isTransientJevApiError(error: unknown): boolean {
  if (!(error instanceof JevError)) return false;
  if (error.code === 'http_429' || error.code === 'provider_unavailable') return true;
  return error.code === 'http_error'
    && (error.status === undefined || error.status === 408 || error.status === 429
      || (error.status >= 500 && error.status <= 599));
}

async function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch (error) {
    if (signal?.aborted) throw new JevError('aborted', 'JEV API retry cancelled');
    throw error;
  }
}

export async function runJevApiWithRetry<T>(options: {
  deadlineMs: number;
  signal?: AbortSignal;
  attempt: (attempt: number) => Promise<T>;
  dependencies?: JevApiRetryDependencies;
}): Promise<T> {
  const now = options.dependencies?.now ?? Date.now;
  const wait = options.dependencies?.wait ?? waitForRetry;
  for (let attempt = 1; ; attempt++) {
    if (options.signal?.aborted) throw new JevError('aborted', 'JEV API retry cancelled');
    if (now() >= options.deadlineMs) throw new JevError('timeout', 'JEV API stage deadline reached');
    try {
      return await options.attempt(attempt);
    } catch (error) {
      if (!isTransientJevApiError(error)) throw error;
      const retryDelayMs = JEV_API_RETRY_POLICY.delaysMs[attempt - 1];
      if (retryDelayMs === undefined
        || options.deadlineMs - now() < retryDelayMs + JEV_API_RETRY_POLICY.minimumAttemptBudgetMs) throw error;
      await wait(retryDelayMs, options.signal);
    }
  }
}
