import type { CommunityService } from './community';
import type { RecordedMatchEvent } from './profileRepository';
import type { TournamentRegistry } from './tournamentRegistry';
import type { ActivityWindow } from './tournamentTelemetry';
import { TournamentTelemetry } from './tournamentTelemetry';

const HOUR = 3600000, DAY = 24 * HOUR, KST = 9 * HOUR;
const POLICY_KEY = 'policy', STATE_KEY = 'state';
const DEFAULT_TITLE = '천하제일몽진대회';
export interface SchedulerPolicy {
  enabled: boolean;
  durationMs: number;
  minimumParticipants: number;
  registrationLeadMs: number;
  registrationClosesBeforeStartMs: number;
  minimumLeadMs: number;
  horizonDays: number;
  allowedHours: number[];
}
export const defaultSchedulerPolicy: SchedulerPolicy = {
  enabled: false, durationMs: HOUR, minimumParticipants: 20,
  registrationLeadMs: 72 * HOUR, registrationClosesBeforeStartMs: HOUR,
  minimumLeadMs: 48 * HOUR, horizonDays: 14, allowedHours: [18, 19, 20, 21, 22],
};
type Basis = { kind: 'bootstrap' } | { kind: 'activity'; days: 14 | 28; observedDates: number; sampleDates: number; score: number; weekday: number; hour: number };
interface Planned { settings: Record<string, unknown>; basis: Basis }
interface SchedulerState { bootstrapUsed: boolean; pending: Planned | null; lastPublished: { id: string; basis: Basis; at: string } | null; lastReason?: string }
const initialState = (): SchedulerState => ({ bootstrapUsed: false, pending: null, lastPublished: null });
const integer = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
export function validateSchedulerPolicy(input: Record<string, unknown>): SchedulerPolicy {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !Object.hasOwn(defaultSchedulerPolicy, k))) throw new Error('INVALID_SCHEDULER_POLICY');
  const policy = { ...defaultSchedulerPolicy, ...input } as SchedulerPolicy;
  if (typeof policy.enabled !== 'boolean' || !integer(policy.durationMs, 30 * 60000, 4 * HOUR) ||
    !integer(policy.minimumParticipants, 2, 100000) || !integer(policy.registrationLeadMs, HOUR, 28 * DAY) ||
    !integer(policy.registrationClosesBeforeStartMs, 0, 24 * HOUR) || !integer(policy.minimumLeadMs, HOUR, 28 * DAY) ||
    !integer(policy.horizonDays, 2, 28) || !Array.isArray(policy.allowedHours) || policy.allowedHours.length === 0 ||
    policy.allowedHours.some(h => !integer(h, 0, 23)) || new Set(policy.allowedHours).size !== policy.allowedHours.length ||
    policy.registrationLeadMs <= policy.registrationClosesBeforeStartMs ||
    policy.registrationClosesBeforeStartMs >= policy.minimumLeadMs || policy.minimumLeadMs > policy.horizonDays * DAY) throw new Error('INVALID_SCHEDULER_POLICY');
  return { ...policy, allowedHours: [...policy.allowedHours].sort((a, b) => a - b) };
}
const kstDate = (time: number) => new Date(time + KST).toISOString().slice(0, 10);
const slotTime = (date: string, hour: number) => Date.parse(`${date}T00:00:00Z`) + hour * HOUR - KST;
const nextDate = (date: string, offset: number) => new Date(Date.parse(`${date}T00:00:00Z`) + offset * DAY).toISOString().slice(0, 10);
const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** Only one writer per server process; store and registry persist the pending choice before publication. */
export class TournamentScheduler {
  private policy: SchedulerPolicy = defaultSchedulerPolicy;
  private state: SchedulerState = initialState();
  private stateNeedsReload = false;
  private tail: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(
    private readonly community: CommunityService,
    private readonly registry: TournamentRegistry,
    private readonly telemetry: TournamentTelemetry,
    private readonly normalEvents: () => Promise<RecordedMatchEvent[]>,
  ) {}
  async initialize(): Promise<void> {
    const [policy, state] = await Promise.all([
      this.community.store.get<SchedulerPolicy>('tournamentScheduler', POLICY_KEY),
      this.community.store.get<SchedulerState>('tournamentScheduler', STATE_KEY),
    ]);
    if (policy) this.policy = validateSchedulerPolicy(policy as unknown as Record<string, unknown>);
    if (state) this.state = state;
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work);
    this.tail = run.catch(() => undefined);
    return run;
  }
  private async persistState(next: SchedulerState): Promise<void> {
    try {
      await this.community.store.commit([{ namespace: 'tournamentScheduler', key: STATE_KEY, value: next }]);
    } catch (error) {
      // A database may commit and lose its acknowledgement. Read back before the next decision.
      this.stateNeedsReload = true;
      throw error;
    }
    this.state = next;
    this.stateNeedsReload = false;
  }
  private async reloadStateIfNeeded(): Promise<void> {
    if (!this.stateNeedsReload) return;
    this.state = await this.community.store.get<SchedulerState>('tournamentScheduler', STATE_KEY) ?? initialState();
    this.stateNeedsReload = false;
  }
  status() {
    const now = Date.now();
    const future = this.registry.list().filter(row => row.settings.endsAt > now && !['cancelled', 'finished'].includes(row.status.phase));
    return { policy: structuredClone(this.policy), bootstrapUsed: this.state.bootstrapUsed,
      pendingId: this.state.pending?.settings.id ?? null, lastPublished: this.state.lastPublished,
      futureEvents: future.map(row => ({ id: row.settings.id, phase: row.status.phase, startsAt: row.settings.startsAt })),
      state: this.stateNeedsReload ? 'state_unverified' : !this.policy.enabled ? 'disabled' : future.length ? 'event_available' : this.state.pending ? 'pending_recovery' : this.state.lastReason === 'insufficient_activity' ? 'waiting_for_data' : this.state.lastReason === 'bootstrap_out_of_horizon' ? 'waiting_for_window' : 'needs_evaluation' };
  }
  configure(patch: Record<string, unknown>): Promise<ReturnType<TournamentScheduler['status']>> {
    return this.serial(async () => {
      const next = validateSchedulerPolicy({ ...this.policy, ...patch });
      await this.community.store.commit([{ namespace: 'tournamentScheduler', key: POLICY_KEY, value: next }]);
      this.policy = next;
      return this.status();
    });
  }
  private futureBoundary(now: number): number | null {
    const events = this.registry.list().filter(row => row.settings.endsAt > now && !['cancelled', 'finished'].includes(row.status.phase));
    if (events.some(row => row.settings.startsAt > now)) return null;
    return Math.max(now + this.policy.minimumLeadMs, ...events.map(row => row.settings.endsAt));
  }
  private async dataChoice(now: number, earliest: number): Promise<{ at: number; basis: Basis } | null> {
    const events = await this.normalEvents();
    let window: ActivityWindow | null = null;
    for (const days of [14, 28] as const) {
      const candidate = await this.telemetry.activityWindow(days, events);
      if (candidate.observedDates >= 7) { window = candidate; break; }
    }
    if (!window) return null;
    const groups = new Map<string, typeof window.slots>();
    for (const slot of window.slots) {
      if (!this.policy.allowedHours.includes(slot.hour)) continue;
      const key = `${slot.weekday}:${slot.hour}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(slot);
    }
    const candidates: { at: number; basis: Basis }[] = [];
    const today = kstDate(now);
    for (let offset = 0; offset <= this.policy.horizonDays; offset++) {
      const date = nextDate(today, offset), day = weekday(date);
      for (const hour of this.policy.allowedHours) {
        const at = slotTime(date, hour);
        if (at < earliest || at > now + this.policy.horizonDays * DAY) continue;
        const samples = groups.get(`${day}:${hour}`) ?? [];
        if (new Set(samples.filter(s => s.activeUsers > 0 || s.playingUsers > 0).map(s => s.date)).size < 2) continue;
        // All terms are observed counts. Playing and repeat use receive more weight than idle connections.
        const score = samples.reduce((n, s) => n + 4 * s.playingUsers + 2 * s.activeUsers +
          s.gamesStarted + 2 * s.peakConcurrentUsers + 2 * s.returningUsers, 0) / samples.length;
        candidates.push({ at, basis: { kind: 'activity', days: window.days, observedDates: window.observedDates,
          sampleDates: samples.length, score, weekday: day, hour } });
      }
    }
    candidates.sort((a, b) => (b.basis.kind === 'activity' ? b.basis.score : 0) - (a.basis.kind === 'activity' ? a.basis.score : 0) || a.at - b.at);
    return candidates[0] ?? null;
  }
  private bootstrapChoice(now: number, earliest: number): { at: number; basis: Basis } | null {
    const today = kstDate(now);
    for (let offset = 0; offset <= this.policy.horizonDays; offset++) {
      const date = nextDate(today, offset);
      const at = slotTime(date, 21);
      if (weekday(date) === 6 && at >= earliest && at <= now + this.policy.horizonDays * DAY) return { at, basis: { kind: 'bootstrap' } };
    }
    return null;
  }
  private async announce(settings: Record<string, unknown>): Promise<void> {
    const id = `tournament-schedule-${settings.id}`;
    if (await this.community.store.get('notices', id)) return;
    const format = (at: number) => new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(at);
    await this.community.publishNotice({
      id, title: DEFAULT_TITLE,
      body: `${format(settings.startsAt as number)} ~ ${format(settings.endsAt as number)}\n신청 마감 ${format(settings.registrationEndsAt as number)}\n${settings.minimumParticipants}명 이상 신청하면 개최합니다.`,
      availableAt: settings.registrationStartsAt as number,
      expiresAt: settings.registrationEndsAt as number,
      tournamentId: settings.id as string,
    });
  }
  private async plan(now: number): Promise<{ planned: Planned | null; reason: string }> {
    const earliest = this.futureBoundary(now);
    if (earliest === null) return { planned: null, reason: 'future_event_exists' };
    let choice = await this.dataChoice(now, earliest);
    if (!choice && !this.state.bootstrapUsed && this.registry.list().length === 0) choice = this.bootstrapChoice(now, earliest);
    if (!choice) return { planned: null, reason: !this.state.bootstrapUsed && this.registry.list().length === 0 ? 'bootstrap_out_of_horizon' : 'insufficient_activity' };
    const { at, basis } = choice;
    const local = new Date(at + KST).toISOString().slice(0, 13).replace(/[-T]/g, '');
    const settings = {
      id: `auto-${local}`, title: DEFAULT_TITLE,
      registrationStartsAt: Math.max(now, at - this.policy.registrationLeadMs),
      registrationEndsAt: at - this.policy.registrationClosesBeforeStartMs,
      startsAt: at, endsAt: at + this.policy.durationMs,
      minimumParticipants: this.policy.minimumParticipants,
      isInaugural: this.registry.list().length === 0,
    };
    return { planned: { settings, basis }, reason: basis.kind };
  }
  dryRun(): Promise<unknown> {
    return this.serial(async () => {
      await this.reloadStateIfNeeded();
      if (this.state.pending) return { reason: 'pending_recovery', planned: this.state.pending, published: false };
      const result = await this.plan(Date.now());
      return { ...result, published: false };
    });
  }
  tick(): Promise<unknown> {
    return this.serial(async () => {
      await this.reloadStateIfNeeded();
      if (!this.policy.enabled) return { reason: 'disabled', published: false };
      let pending = this.state.pending;
      if (pending && Number(pending.settings.registrationEndsAt) <= Date.now() && !this.registry.has(String(pending.settings.id))) {
        await this.persistState({ ...this.state, bootstrapUsed: pending.basis.kind === 'bootstrap' ? false : this.state.bootstrapUsed, pending: null });
        pending = null;
      }
      if (!pending) {
        const result = await this.plan(Date.now());
        if (!result.planned) {
          if (this.state.lastReason !== result.reason) {
            await this.persistState({ ...this.state, lastReason: result.reason });
          }
          return { reason: result.reason, published: false };
        }
        pending = result.planned;
        await this.persistState({ ...this.state, bootstrapUsed: this.state.bootstrapUsed || pending.basis.kind === 'bootstrap', pending });
      }
      // Manual publication wins if it appeared while a pending selection was being recovered.
      if (this.registry.list().some(row => row.settings.id !== pending.settings.id && row.settings.startsAt > Date.now() && row.settings.endsAt > Date.now() && !['cancelled', 'finished'].includes(row.status.phase))) {
        await this.persistState({ ...this.state, pending: null });
        return { reason: 'future_event_exists', published: false };
      }
      await this.registry.publish(pending.settings);
      await this.announce(pending.settings);
      await this.persistState({ ...this.state, pending: null, lastReason: pending.basis.kind, lastPublished: { id: pending.settings.id as string, basis: pending.basis, at: new Date().toISOString() } });
      return { reason: pending.basis.kind, published: true, id: pending.settings.id };
    });
  }
  start(): void {
    if (this.timer) return;
    const check = () => void this.tick().catch(error => console.error('[tournament-scheduler] 일정 생성 실패:', error));
    check();
    this.timer = setInterval(check, 60_000);
    this.timer.unref?.();
  }
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.tail;
  }
}
