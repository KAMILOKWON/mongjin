import type { RuleConfig } from '../src/core/config';
import type { GameState } from '../src/core/types';
import { JevError } from './jev';
import { chooseRankedJevMove } from './jevWorkerClient';
import { JEV_PARALLEL_POLICY } from './jevPolicy';
import type { ParallelTurnTrace } from './jevParallel';

function decideRanked(state: GameState, config: RuleConfig, options: {
  apiKey: string; signal?: AbortSignal; timeoutMs: number; gameId: string;
  onTrace?: (trace: ParallelTurnTrace) => void;
}) {
  return chooseRankedJevMove({ state, config, apiKey: options.apiKey, signal: options.signal,
    gameId: options.gameId, deadlineMs: Date.now() + options.timeoutMs, onTrace: options.onTrace });
}

export const JEV_BOT = { id: 'ranked-bot-jev', name: 'JEV', rating: 1200, personality: 'tactician' } as const;
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

  constructor(
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly now: () => number = Date.now,
    private readonly decide: typeof decideRanked = decideRanked,
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
    return {
      model: 'typesafe-ai/jev', strategy: JEV_PARALLEL_POLICY.version, expiresAt: JEV_EXPIRES_AT, acceptingMatches: this.canMatch,
      reason: this.unavailableReason, turns: this.requests, successfulMoves: this.successfulMoves,
      failures: this.failures, cooldownUntil: this.cooldownUntil || null,
    };
  }

  async move(state: GameState, config: RuleConfig, signal?: AbortSignal, gameId = 'local-verification', onTrace?: (trace: ParallelTurnTrace) => void) {
    const unavailable = this.unavailableReason;
    if (unavailable) throw new Error(`jev_${unavailable}`);
    this.requests++;
    try {
      const decision = await this.decide(state, config, {
        apiKey: this.env.AI_GATEWAY_API_KEY!, signal, gameId, onTrace,
        timeoutMs: Math.max(1, Math.min(JEV_PARALLEL_POLICY.turnLimitMs, LAST_CALL_AT - this.now())),
      });
      if (signal?.aborted) throw new Error('jev_aborted');
      if (this.now() >= LAST_CALL_AT) throw new Error('jev_expired');
      // Unknown billing must not silently turn a temporary free experiment into paid use.
      if (decision.move && decision.cost !== 0) {
        this.stopped = 'billing_unverified';
        throw new Error('jev_billing_unverified');
      }
      if (decision.move) this.successfulMoves++;
      return decision;
    } catch (error) {
      if (signal?.aborted) throw error;
      this.failures++;
      this.cooldownUntil = this.now() + 60_000;
      if (error instanceof JevError && !['http_429', 'timeout', 'aborted'].includes(error.code)) {
        this.stopped = error.code;
      }
      if (this.failures >= 3) this.stopped ??= 'repeated_errors';
      throw error;
    }
  }
}
