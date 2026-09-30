import { randomBytes } from 'node:crypto';

/** 서버가 확정한 대회 사건. 우편함·푸시·통계 수신자는 id로 중복을 제거한다. */
export type TournamentLifecycleEventKind = 'confirmed' | 'cancelled' | 'reminder' | 'started' | 'finished' | 'champion';
export type TournamentMetricEventKind =
  | 'register'
  | 'unregister'
  | 'enter'
  | 'leave'
  | 'reenter'
  | 'match_found'
  | 'match_started'
  | 'match_complete';
export type TournamentEventKind = TournamentLifecycleEventKind | TournamentMetricEventKind;

export interface TournamentServiceEvent {
  /** 저장 후 바뀌지 않는 고유 ID */
  id: string;
  tournamentId: string;
  title: string;
  kind: TournamentEventKind;
  /** epoch ms */
  occurredAt: number;
  playerIds: string[];
  data: Record<string, unknown>;
}

export interface StoredTournamentEvent extends TournamentServiceEvent {
  /** 수신 콜백이 성공한 시각(epoch ms). 미전달이면 null */
  deliveredAt: number | null;
}

export type TournamentEventSink = (event: TournamentServiceEvent) => Promise<void> | void;

/** 생명주기 사건은 대회당 한 번이므로 결정적 ID, 지표 사건은 무작위 ID를 쓴다. */
export function tournamentEventId(tournamentId: string, kind: TournamentEventKind, suffix?: string): string {
  return [tournamentId, kind, suffix ?? randomBytes(8).toString('hex')].join(':');
}

export interface TournamentEventDispatcherOptions {
  sink?: TournamentEventSink;
  markDelivered: (ids: string[], deliveredAt: number) => Promise<void>;
  retryMs: number;
  logger: Pick<Console, 'error' | 'warn'>;
}

/**
 * 저장된 사건을 순서대로 한 번에 하나씩 전달한다. 실패하면 retryMs 뒤 같은 사건부터 다시 보낸다.
 * 전달 표시 저장에 실패하면 재시작 후 다시 보낼 수 있으므로 수신자는 id로 중복을 무시해야 한다.
 */
export class TournamentEventDispatcher {
  private readonly pending: TournamentServiceEvent[] = [];
  private readonly queued = new Set<string>();
  private running: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly options: TournamentEventDispatcherOptions) {}

  enqueue(events: readonly TournamentServiceEvent[]): void {
    if (!this.options.sink || this.closed) return;
    for (const event of events) {
      if (this.queued.has(event.id)) continue;
      this.queued.add(event.id);
      this.pending.push(event);
    }
    void this.drain();
  }

  /** 테스트/종료 시 남은 전달을 기다린다 */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private drain(): Promise<void> {
    if (this.running || this.retryTimer || this.closed) return this.running ?? Promise.resolve();
    this.running = this.deliverPending().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async deliverPending(): Promise<void> {
    while (this.pending.length && !this.closed) {
      const event = this.pending[0]!;
      try {
        await this.options.sink!(structuredClone(event));
      } catch (error) {
        this.options.logger.warn('[tournament] 사건 전달 실패, 다시 시도합니다:', error);
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          void this.drain();
        }, this.options.retryMs);
        this.retryTimer.unref?.();
        return;
      }
      this.pending.shift();
      this.queued.delete(event.id);
      try {
        await this.options.markDelivered([event.id], Date.now());
      } catch (error) {
        this.options.logger.error('[tournament] 사건 전달 표시 저장 실패:', error);
      }
    }
  }
}
