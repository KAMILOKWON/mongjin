import type { RuleConfig } from '../src/core/config';
import type { GameState } from '../src/core/types';
import { JevError } from './jev';
import { chooseRankedJevMove } from './jevWorkerClient';
import { JEV_PARALLEL_POLICY } from './jevPolicy';
import { ParallelTurnError, type ParallelTurnTrace } from './jevParallel';
import { classifyJevFailure, JEV_RECOVERY_POLICY, waitForJevRetry } from './jevRecovery';

function decideRanked(state: GameState, config: RuleConfig, options: {
  apiKey: string; signal?: AbortSignal; timeoutMs: number; gameId: string;
  onTrace?: (trace: ParallelTurnTrace) => void;
}) {
  return chooseRankedJevMove({ state, config, apiKey: options.apiKey, signal: options.signal,
    gameId: options.gameId, deadlineMs: Date.now() + options.timeoutMs, onTrace: options.onTrace });
}

export const JEV_BOT = { id: 'ranked-bot-jev', name: '침착맨이할때까지', rating: 1200, personality: 'tactician' } as const;
// The promotion's timezone is unspecified. Stop at the start of September 25 in Korea.
export const JEV_EXPIRES_AT = '2026-09-25T00:00:00+09:00';
const LAST_CALL_AT = Date.parse(JEV_EXPIRES_AT);
const ADMISSION_MARGIN_MS = 5 * 60_000;

export class JevExperiment {
  private stopped: string | null = null;
  private cooldownUntil = 0;
  private failures = 0;
  private requests = 0;
  private successfulMoves = 0;
  private attempts = 0;
  private attemptFailures = 0;
  private retries = 0;
  private recoveredTurns = 0;
  private consecutiveFailures = 0;
  private lastError: (ReturnType<typeof classifyJevFailure> & { at: number }) | null = null;

  constructor(
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly now: () => number = Date.now,
    private readonly decide: typeof decideRanked = decideRanked,
    private readonly wait: typeof waitForJevRetry = waitForJevRetry,
  ) {}

  get unavailableReason(): string | null {
    if (this.env.MONGJIN_JEV_ENABLED !== '1') return 'disabled';
    if (!this.env.AI_GATEWAY_API_KEY?.trim()) return 'missing_key';
    if (this.now() >= LAST_CALL_AT) return 'expired';
    return this.stopped;
  }

  get canMatch(): boolean {
    return !this.unavailableReason && this.now() < LAST_CALL_AT - ADMISSION_MARGIN_MS && this.now() >= this.cooldownUntil;
  }

  get status() {
    const retryAfterMs = Math.max(0, this.cooldownUntil - this.now());
    return {
      model: 'typesafe-ai/jev', strategy: JEV_PARALLEL_POLICY.version, expiresAt: JEV_EXPIRES_AT, acceptingMatches: this.canMatch,
      reason: this.unavailableReason ?? (retryAfterMs > 0 ? 'transient_cooldown' : null),
      turns: this.requests, successfulMoves: this.successfulMoves,
      failures: this.failures, cooldownUntil: retryAfterMs > 0 ? this.cooldownUntil : null,
      recoveryPolicy: JEV_RECOVERY_POLICY.version, retryAfterMs, attempts: this.attempts,
      attemptFailures: this.attemptFailures, retries: this.retries, recoveredTurns: this.recoveredTurns,
      consecutiveFailures: this.consecutiveFailures, lastError: this.lastError,
    };
  }

  private failTurn(error: unknown): never {
    const failure = classifyJevFailure(error);
    this.failures++;
    this.consecutiveFailures++;
    if (failure.retryable) {
      const cooldown = Math.min(JEV_RECOVERY_POLICY.maxCooldownMs,
        JEV_RECOVERY_POLICY.baseCooldownMs * 2 ** Math.min(10, this.consecutiveFailures - 1));
      this.cooldownUntil = this.now() + cooldown;
    } else {
      this.stopped ??= failure.status === undefined ? failure.code : `http_${failure.status}`;
    }
    throw error;
  }

  async move(state: GameState, config: RuleConfig, signal?: AbortSignal, gameId = 'local-verification',
    onTrace?: (trace: ParallelTurnTrace) => void,
    onRetryTrace?: (trace: ParallelTurnTrace) => Promise<void>) {
    const unavailable = this.unavailableReason;
    if (unavailable) throw new Error(`jev_${unavailable}`);
    if (signal?.aborted) throw new JevError('aborted', 'jev_aborted');
    this.requests++;
    const startedAt = this.now();
    const deadlineMs = Math.min(startedAt + JEV_PARALLEL_POLICY.turnLimitMs, LAST_CALL_AT);
    const snapshot = structuredClone(state);
    const rules = { ...config };
    for (let attempt = 0; ; attempt++) {
      try {
        if (signal?.aborted) throw new JevError('aborted', 'JEV turn cancelled');
        if (this.now() >= LAST_CALL_AT) throw new JevError('timeout', 'jev_expired');
        if (this.now() >= deadlineMs) throw new JevError('timeout', 'JEV turn deadline reached');
        if (this.unavailableReason) throw new Error(`jev_${this.unavailableReason}`);
        this.attempts++;
        if (attempt > 0) this.retries++;
        const decision = await this.decide(structuredClone(snapshot), { ...rules }, {
          apiKey: this.env.AI_GATEWAY_API_KEY!, signal, gameId, onTrace,
          timeoutMs: deadlineMs - this.now(),
        });
        if (signal?.aborted) throw new JevError('aborted', 'JEV turn cancelled');
        if (this.now() >= LAST_CALL_AT) throw new JevError('timeout', 'jev_expired');
        if (this.now() >= deadlineMs) throw new JevError('timeout', 'JEV turn deadline reached');
        // Billing/authentication/validation failures remain hard stops.
        if (decision.move && decision.cost !== 0) {
          this.stopped = 'billing_unverified';
          throw new JevError('non_free', 'jev_billing_unverified');
        }
        if (decision.trace) decision.trace.recovery = {
          policy: JEV_RECOVERY_POLICY.version, attempt: attempt + 1,
          deadlineMs, elapsedMs: this.now() - startedAt,
        };
        if (decision.move) this.successfulMoves++;
        if (attempt > 0) this.recoveredTurns++;
        this.consecutiveFailures = 0;
        this.cooldownUntil = 0;
        return decision;
      } catch (error) {
        if (signal?.aborted || (error instanceof JevError && error.code === 'aborted')) throw error;
        const failure = classifyJevFailure(error);
        this.attemptFailures++;
        this.lastError = { ...failure, at: this.now() };
        if (error instanceof ParallelTurnError) {
          error.trace.recovery = { policy: JEV_RECOVERY_POLICY.version,
            attempt: attempt + 1, deadlineMs, elapsedMs: this.now() - startedAt };
        }
        const delayMs = JEV_RECOVERY_POLICY.retryDelaysMs[attempt];
        const hasRetryBudget = () => delayMs !== undefined
          && deadlineMs - this.now() >= delayMs + JEV_RECOVERY_POLICY.minimumRetryBudgetMs;
        if (!failure.retryable || attempt >= JEV_RECOVERY_POLICY.maxRetries
          || this.unavailableReason || !hasRetryBudget()) return this.failTurn(error);

        // Persist each failed attempt before starting another model decision.
        if (error instanceof ParallelTurnError && onRetryTrace) {
          try { await onRetryTrace(error.trace); }
          catch {
            if (signal?.aborted) throw new JevError('aborted', 'JEV retry cancelled');
            console.error('[jev] 재시도 판단 기록 저장 실패');
            return this.failTurn(error);
          }
        }
        if (signal?.aborted) throw new JevError('aborted', 'JEV retry cancelled');
        if (!hasRetryBudget() || this.unavailableReason) return this.failTurn(error);
        console.warn('[jev]', JSON.stringify({ event: 'retry', matchId: gameId,
          attempt: attempt + 1, code: failure.code, status: failure.status, delayMs }));
        try { await this.wait(delayMs!, signal); }
        catch (waitError) {
          if (signal?.aborted || (waitError instanceof JevError && waitError.code === 'aborted')) throw waitError;
          return this.failTurn(error);
        }
      }
    }
  }
}
