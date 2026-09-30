import { randomUUID } from 'node:crypto';
import type { CommunityService, CommunityEvent } from './community';
import type { CommunityChange } from './communityStore';
import type { RecordedMatchEvent } from './profileRepository';

interface SessionRecord {
  id: string; playerId: string; platform: string;
  connectedAt: number; lastSeenAt: number; disconnectedAt: number | null;
}
interface ConcurrencyRecord { id: string; occurredAt: number; users: number; connections: number }
interface ClientEvent { id: string; tournamentId: string; playerId: string; kind: 'view' | 'invite' | 'practice_start'; occurredAt: number }
const platforms = new Set(['toss', 'web', 'mobile', 'steam', 'unknown']);
const validId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const kst = (time: number) => new Date(time + 9 * 3600000).toISOString();
const day = (time: number) => kst(time).slice(0, 10);
const hour = (time: number) => kst(time).slice(0, 13) + ':00';
const inWindow = (time: number, start: number, end: number) => Number.isFinite(time) && time >= start && time <= end;
const average = (values: number[]) => values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : null;
const eventMatchId = (e: CommunityEvent) => typeof e.data.matchId === 'string' ? e.data.matchId : null;

export interface ActivitySlot {
  date: string;
  weekday: number; // KST Sunday=0
  hour: number;
  activeUsers: number;
  playingUsers: number;
  gamesStarted: number;
  peakConcurrentUsers: number;
  returningUsers: number;
}
export interface ActivityWindow { days: 14 | 28; observedDates: number; slots: ActivitySlot[] }

/** Only authenticated, connected sockets supplied by main. No app-view inference. */
export class TournamentTelemetry {
  private sockets = new Map<object, SessionRecord>();
  private pending = new Map<string, CommunityChange>();
  private writes: Promise<void> = Promise.resolve();
  private writeFailed = false;
  private closed = false;
  private clientTail: Promise<unknown> = Promise.resolve();
  constructor(private readonly community: CommunityService) {}
  connect(socket: object, playerId: string, platform: string): void {
    if (this.closed || !playerId || playerId.length > 128) return;
    const prior = this.sockets.get(socket);
    if (prior?.playerId === playerId) return;
    if (prior) this.disconnect(socket);
    const now = Date.now();
    const record: SessionRecord = { id: randomUUID(), playerId, platform: platforms.has(platform) ? platform : 'unknown', connectedAt: now, lastSeenAt: now, disconnectedAt: null };
    this.sockets.set(socket, record);
    this.save('telemetrySessions', record.id, record);
    this.sample();
  }
  disconnect(socket: object): void {
    const session = this.sockets.get(socket);
    if (!session) return;
    const now = Date.now();
    this.sockets.delete(socket);
    this.save('telemetrySessions', session.id, { ...session, lastSeenAt: now, disconnectedAt: now });
    this.sample();
  }
  sample(): void {
    if (this.closed) return;
    const now = Date.now();
    for (const session of this.sockets.values()) {
      session.lastSeenAt = now;
      this.save('telemetrySessions', session.id, session);
    }
    // One record per UTC minute, retaining the observed peak instead of storing every heartbeat.
    const id = String(Math.floor(now / 60000));
    const record: ConcurrencyRecord = { id, occurredAt: now, connections: this.sockets.size, users: new Set([...this.sockets.values()].map(s => s.playerId)).size };
    const prior = this.pending.get(`telemetryConcurrency:${id}`)?.value as ConcurrencyRecord | undefined;
    if (prior) { record.users = Math.max(record.users, prior.users); record.connections = Math.max(record.connections, prior.connections); }
    this.save('telemetryConcurrency', id, record);
    this.flush();
  }
  private save(namespace: string, key: string, value: unknown) {
    this.pending.set(`${namespace}:${key}`, { namespace, key, value: structuredClone(value) });
  }
  private flush() {
    this.writes = this.writes.then(async () => {
      const changes = [...this.pending.values()];
      if (!changes.length) return;
      try {
        for (const change of changes) {
          if (change.namespace !== 'telemetryConcurrency') continue;
          const previous = await this.community.store.get<ConcurrencyRecord>(change.namespace, change.key);
          const value = change.value as ConcurrencyRecord;
          if (previous) { value.users = Math.max(value.users, previous.users); value.connections = Math.max(value.connections, previous.connections); }
        }
        await this.community.store.commit(changes);
        for (const change of changes) if (this.pending.get(`${change.namespace}:${change.key}`) === change) this.pending.delete(`${change.namespace}:${change.key}`);
        this.writeFailed = false;
      } catch { this.writeFailed = true; } // Retain latest records for the next sample/close retry.
    });
  }
  async close(): Promise<void> {
    if (this.closed) { await this.writes; if (this.writeFailed) throw new Error('TELEMETRY_WRITE_FAILED'); return; }
    for (const socket of [...this.sockets.keys()]) this.disconnect(socket);
    this.closed = true;
    this.flush(); await this.writes; await this.clientTail;
    if (this.writeFailed) throw new Error('TELEMETRY_WRITE_FAILED');
  }
  recordClientEvent(playerId: string, input: Record<string, unknown>): Promise<{ saved: boolean; duplicate: boolean }> {
    const run = this.clientTail.then(async () => {
      if (this.closed) throw new Error('TELEMETRY_UNAVAILABLE');
      if (!validId(input.tournamentId) || input.tournamentId.length > 64 || !validId(input.eventId) || !['view', 'invite', 'practice_start'].includes(String(input.kind)) ||
        Object.keys(input).some(k => !['playerId', 'token', 'tournamentId', 'eventId', 'kind'].includes(k))) throw new Error('INVALID_REQUEST');
      const key = JSON.stringify([playerId, input.tournamentId, input.eventId]);
      const existing = await this.community.store.get<ClientEvent>('tournamentClientEvents', key);
      if (existing) {
        if (existing.kind !== input.kind) throw new Error('EVENT_ID_CONFLICT');
        return { saved: true, duplicate: true };
      }
      const now = Date.now();
      const rate = await this.community.store.get<{ times: number[] }>('tournamentClientRate', playerId);
      const times = (rate?.times ?? []).filter(t => t > now - 60000);
      if (times.length >= 30) throw new Error('RATE_LIMITED');
      const event: ClientEvent = { id: input.eventId, tournamentId: input.tournamentId, playerId, kind: input.kind as ClientEvent['kind'], occurredAt: now };
      await this.community.store.commit([
        { namespace: 'tournamentClientEvents', key, value: event },
        { namespace: 'tournamentClientRate', key: playerId, value: { times: [...times, now] } },
      ]);
      return { saved: true, duplicate: false };
    });
    this.clientTail = run.catch(() => undefined); return run;
  }
  /** Authenticated connections and canonical normal-match starts only. Empty hours are not invented. */
  async activityWindow(days: 14 | 28, normalEvents: RecordedMatchEvent[]): Promise<ActivityWindow> {
    if (days !== 14 && days !== 28) throw new Error('INVALID_DAYS');
    this.flush(); await this.writes;
    if (this.writeFailed) throw new Error('TELEMETRY_WRITE_FAILED');
    const end = Date.now(), start = end - days * 86400000;
    const [sessions, samples] = await Promise.all([
      this.community.store.list<SessionRecord>('telemetrySessions'),
      this.community.store.list<ConcurrencyRecord>('telemetryConcurrency'),
    ]);
    const users = new Map<string, Set<string>>(), visits = new Map<string, Set<string>>();
    for (const session of sessions) {
      const first = Math.max(start, session.connectedAt), last = Math.min(end, session.disconnectedAt ?? session.lastSeenAt);
      if (first > last || !validId(session.playerId)) continue;
      for (let t = first; t <= last; t = (Math.floor(t / 3600000) + 1) * 3600000) {
        const key = hour(t), date = day(t);
        if (!users.has(key)) users.set(key, new Set()); users.get(key)!.add(session.playerId);
        if (!visits.has(session.playerId)) visits.set(session.playerId, new Set()); visits.get(session.playerId)!.add(date);
      }
    }
    const players = new Map<string, Set<string>>(), games = new Map<string, Set<string>>(), peaks = new Map<string, number>();
    for (const event of normalEvents) {
      const at = Date.parse(event.occurredAt);
      if (event.event !== 'started' || !inWindow(at, start, end) || !validId(event.playerId) || !validId(event.matchId)) continue;
      const key = hour(at);
      if (!players.has(key)) players.set(key, new Set()); players.get(key)!.add(event.playerId);
      if (!games.has(key)) games.set(key, new Set()); games.get(key)!.add(event.matchId);
    }
    for (const sample of samples) if (inWindow(sample.occurredAt, start, end) && sample.users > 0) {
      const key = hour(sample.occurredAt);
      peaks.set(key, Math.max(peaks.get(key) ?? 0, sample.users));
    }
    const keys = new Set([...users.keys(), ...players.keys(), ...peaks.keys()]);
    const slots = [...keys].sort().map(key => {
      const date = key.slice(0, 10);
      return {
        date, weekday: new Date(`${date}T00:00:00Z`).getUTCDay(), hour: Number(key.slice(11, 13)),
        activeUsers: users.get(key)?.size ?? 0, playingUsers: players.get(key)?.size ?? 0,
        gamesStarted: games.get(key)?.size ?? 0, peakConcurrentUsers: peaks.get(key) ?? 0,
        returningUsers: [...(users.get(key) ?? [])].filter(id => (visits.get(id)?.size ?? 0) >= 2).length,
      };
    });
    return { days, observedDates: new Set(slots.map(s => s.date)).size, slots };
  }
  async stats(days: 14 | 28, normalEvents?: RecordedMatchEvent[]): Promise<unknown> {
    if (days !== 14 && days !== 28) throw new Error('INVALID_DAYS');
    this.flush(); await this.writes; await this.clientTail;
    if (this.writeFailed) throw new Error('TELEMETRY_WRITE_FAILED');
    const end = Date.now(), start = end - days * 86400000;
    const [sessions, samples, allEvents, clientEvents, schedules] = await Promise.all([
      this.community.store.list<SessionRecord>('telemetrySessions'),
      this.community.store.list<ConcurrencyRecord>('telemetryConcurrency'),
      this.community.store.list<CommunityEvent>('events'),
      this.community.store.list<ClientEvent>('tournamentClientEvents'),
      this.community.store.list<{ id: string; minimumParticipants: number; registrationStartsAt: number }>('schedules'),
    ]);
    const observed = sessions.filter(s => s.connectedAt <= end && (s.disconnectedAt ?? s.lastSeenAt) >= start);
    const daily = new Map<string, Set<string>>(), hourly = new Map<string, Set<string>>(), daysByUser = new Map<string, Set<string>>();
    for (const session of observed) {
      const first = Math.max(start, session.connectedAt), last = Math.min(end, session.disconnectedAt ?? session.lastSeenAt);
      for (let t = first; t <= last;) {
        const d = day(t), h = hour(t);
        if (!daily.has(d)) daily.set(d, new Set()); daily.get(d)!.add(session.playerId);
        if (!hourly.has(h)) hourly.set(h, new Set()); hourly.get(h)!.add(session.playerId);
        if (!daysByUser.has(session.playerId)) daysByUser.set(session.playerId, new Set()); daysByUser.get(session.playerId)!.add(d);
        t = (Math.floor(t / 3600000) + 1) * 3600000;
      }
    }
    const relevantSamples = samples.filter(s => inWindow(s.occurredAt, start, end));
    const events = allEvents.filter(e => inWindow(e.occurredAt, start, end));
    const uniqueEvents = [...new Map(events.map(e => [JSON.stringify([e.tournamentId, e.id]), e])).values()];
    const tournamentIds = new Set([...schedules.map(s => s.id), ...uniqueEvents.map(e => e.tournamentId)]);
    const tournaments = [...tournamentIds].sort().map(id => {
      const windowEvents = uniqueEvents.filter(e => e.tournamentId === id);
      const matches = (kind: string) => [...new Map(windowEvents.filter(e => e.kind === kind && eventMatchId(e)).map(e => [eventMatchId(e), e])).values()];
      const started = matches('match_started'), completed = matches('match_complete').filter(e => e.data.status === 'completed');
      const startedIds = new Set(allEvents.filter(e => e.tournamentId === id && e.kind === 'match_started').map(eventMatchId));
      const waits = matches('match_found').filter(e => startedIds.has(eventMatchId(e))).flatMap(e => {
        const data = e.data.waitedMs;
        if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
        return [...new Set(e.playerIds)].flatMap(player => {
          const n = (data as Record<string, unknown>)[player];
          return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? [n] : [];
        });
      });
      const sortedWaits = waits.sort((a, b) => a - b);
      const schedule = schedules.find(s => s.id === id);
      const registrations = new Set<string>();
      let minimumAt: number | null = null, halfMinimumAt: number | null = null, fiftyAt: number | null = null;
      const history = [...new Map(allEvents.filter(e => e.tournamentId === id && e.occurredAt <= end && ['register', 'unregister'].includes(e.kind)).map(e => [e.id, e])).values()].sort((a, b) => a.occurredAt - b.occurredAt || a.id.localeCompare(b.id));
      // Millisecond timestamps do not encode the order of opposite actions by one user.
      const actions = new Map<string, string>();
      let ambiguousOrder = false;
      for (const event of history) for (const player of event.playerIds) {
        const key = JSON.stringify([event.occurredAt, player]);
        if (actions.has(key) && actions.get(key) !== event.kind) ambiguousOrder = true;
        actions.set(key, event.kind);
      }
      for (const event of history) {
        for (const player of event.playerIds) { if (event.kind === 'register') registrations.add(player); else registrations.delete(player); }
        if (schedule && minimumAt === null && registrations.size >= schedule.minimumParticipants) minimumAt = event.occurredAt;
        if (schedule && halfMinimumAt === null && registrations.size >= Math.ceil(schedule.minimumParticipants / 2)) halfMinimumAt = event.occurredAt;
        if (fiftyAt === null && registrations.size >= 50) fiftyAt = event.occurredAt;
      }
      if (ambiguousOrder) { minimumAt = null; halfMinimumAt = null; fiftyAt = null; }
      const elapsed = (at: number | null) => schedule && at !== null && at >= schedule.registrationStartsAt ? at - schedule.registrationStartsAt : null;
      const metrics = Object.fromEntries(['register', 'unregister', 'enter', 'reenter', 'leave', 'match_found', 'match_started', 'match_complete'].map(kind => [kind, windowEvents.filter(e => e.kind === kind).length]));
      const reported = clientEvents.filter(e => e.tournamentId === id && inWindow(e.occurredAt, start, end));
      return {
        tournamentId: id, serverEvents: metrics, matchCount: started.length, completedMatchCount: completed.length,
        abandonedMatchCount: matches('match_complete').filter(e => e.data.status === 'abandoned').length,
        matchUsers: new Set(started.flatMap(e => e.playerIds)).size,
        queueCancellations: windowEvents.some(e => e.kind === 'leave' && typeof e.data.wasQueued === 'boolean') ? windowEvents.filter(e => e.kind === 'leave' && e.data.wasQueued === true).length : null,
        leaveReasons: Object.fromEntries(['pause', 'disconnect', 'not_ready', 'ended'].map(reason => [reason, windowEvents.filter(e => e.kind === 'leave' && e.data.reason === reason).length])),
        queueCancellationData: windowEvents.some(e => e.kind === 'leave' && typeof e.data.wasQueued === 'boolean') ? 'available' : 'insufficient',
        successfulWait: { sampleCount: waits.length, meanMs: average(waits), p95Ms: waits.length ? sortedWaits[Math.ceil(waits.length * .95) - 1] : null, scope: 'match_found joined to canonical match_started' },
        registrationTimeline: { minimumParticipants: schedule?.minimumParticipants ?? null, halfMinimumParticipants: schedule ? Math.ceil(schedule.minimumParticipants / 2) : null, minimumReachedAt: minimumAt === null ? null : new Date(minimumAt).toISOString(), timeToMinimumMs: elapsed(minimumAt), halfMinimumReachedAt: halfMinimumAt === null ? null : new Date(halfMinimumAt).toISOString(), timeToHalfMinimumMs: elapsed(halfMinimumAt), fiftyReachedAt: fiftyAt === null ? null : new Date(fiftyAt).toISOString(), timeTo50Ms: elapsed(fiftyAt), observedCurrentRegistrations: history.length && !ambiguousOrder ? registrations.size : null, sampleStatus: ambiguousOrder ? 'ambiguous_order' : history.length ? 'available' : 'insufficient' },
        clientReported: Object.fromEntries(['view', 'invite', 'practice_start'].map(kind => [kind, reported.filter(e => e.kind === kind).length])),
      };
    });
    const normal = normalEvents === undefined ? null : ['human', 'bot'].map(opponentKind => {
      const list = normalEvents.filter(e => e.opponentKind === opponentKind && inWindow(Date.parse(e.occurredAt), start, end));
      const started = list.filter(e => e.event === 'started');
      return { opponentKind, matchCount: new Set(started.map(e => e.matchId)).size, matchUsers: new Set(started.map(e => e.playerId)).size, completedMatchCount: new Set(list.filter(e => e.event === 'completed').map(e => e.matchId)).size, abandonedMatchCount: new Set(list.filter(e => e.event === 'abandoned').map(e => e.matchId)).size };
    });
    return {
      days, from: new Date(start).toISOString(), through: new Date(end).toISOString(), groupingTimeZone: 'Asia/Seoul',
      source: 'authenticated server connections; canonical tournament events; client events are self-reported',
      appViews: null, sampleStatus: observed.length ? 'available' : 'insufficient',
      sessions: observed.length ? observed.length : null, uniqueActiveUsers: observed.length ? daysByUser.size : null,
      revisitUsers: observed.length ? [...daysByUser.values()].filter(d => d.size >= 2).length : null,
      revisitDefinition: 'authenticated connection activity on at least two distinct KST dates in the window',
      concurrentPeakUsers: relevantSamples.length ? Math.max(...relevantSamples.map(s => s.users)) : null,
      concurrentPeakConnections: relevantSamples.length ? Math.max(...relevantSamples.map(s => s.connections)) : null,
      daily: [...daily].sort(([a], [b]) => a.localeCompare(b)).map(([date, users]) => ({ date, uniqueActiveUsers: users.size })),
      hourly: [...hourly].sort(([a], [b]) => a.localeCompare(b)).map(([dateHour, users]) => ({ dateHour, uniqueActiveUsers: users.size })),
      normalMatches: normal, normalMatchData: normal === null ? 'unavailable' : 'available', tournaments,
    };
  }
}
