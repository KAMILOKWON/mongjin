import { JevError } from './jev';
import { classifyJevFailure, waitForJevRetry } from './jevRecovery';

export const JEV_MATCH_RECOVERY_POLICY = {
  version: 'preserve-v1', baseDelayMs: 15_000, maxDelayMs: 120_000,
} as const;

/** Keep the same live board while the provider recovers. Never invent a move. */
export async function preserveJevTurn<T>(operation: () => Promise<T>, options: {
  signal: AbortSignal;
  expiresAt: number;
  isCurrent: () => boolean;
  unavailableReason: () => string | null;
  retryAfterMs: () => number;
  onRetry: (error: unknown, delayMs: number, failureCount: number) => void;
  now?: () => number;
  wait?: typeof waitForJevRetry;
}): Promise<T> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? waitForJevRetry;
  const check = () => {
    if (options.signal.aborted || !options.isCurrent()) throw new JevError('aborted', 'JEV match ended or changed');
    if (now() >= options.expiresAt) throw new JevError('timeout', 'JEV experiment expired');
  };
  for (let failures = 0; ; ) {
    check();
    try {
      const result = await operation();
      check();
      return result;
    } catch (error) {
      check();
      if (!classifyJevFailure(error).retryable || options.unavailableReason()) throw error;
      failures++;
      const backoff = Math.min(JEV_MATCH_RECOVERY_POLICY.maxDelayMs,
        JEV_MATCH_RECOVERY_POLICY.baseDelayMs * 2 ** Math.min(failures - 1, 10));
      const delayMs = Math.min(Math.max(backoff, options.retryAfterMs()), options.expiresAt - now());
      options.onRetry(error, delayMs, failures);
      await wait(delayMs, options.signal);
    }
  }
}
