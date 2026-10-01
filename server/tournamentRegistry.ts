import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createTournamentService, parseTournamentRankedBotIds, tournamentSettingsFromEnv, type TournamentSettings, type TournamentService, type TournamentClient, type TournamentIdentity } from './tournament';
import { createTournamentStore, TOURNAMENT_SCORING_VERSION, type TournamentMatchRecord, type TournamentStore } from './tournamentStore';
import type { TournamentPublicStatus, TournamentNextEvent } from '../src/net/tournamentProtocol';
import { TOURNAMENT_PROTOCOL_VERSION } from '../src/net/tournamentProtocol';
import type { CommunityService } from './community';
import type { BackgroundChangeSink, CanBackgroundWait, TournamentBackgroundStatus } from './tournamentBackground';
import type { StoredProfile } from './profileRepository';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const fields: Record<string, string> = {
  id: 'ID', title: 'TITLE', registrationStartsAt: 'REGISTRATION_STARTS_AT', registrationEndsAt: 'REGISTRATION_ENDS_AT',
  startsAt: 'STARTS_AT', endsAt: 'ENDS_AT', minimumParticipants: 'MIN_PARTICIPANTS', minimumRankedMatches: 'MIN_RANKED_MATCHES',
  startingScore: 'STARTING_SCORE', eloK: 'ELO_K', eloScale: 'ELO_SCALE', readyTimeoutMs: 'READY_TIMEOUT_MS',
  matchCountdownMs: 'MATCH_COUNTDOWN_MS', moveTimeMs: 'MOVE_MS', reconnectGraceMs: 'RECONNECT_GRACE_MS',
  reminderLeadMs: 'REMINDER_LEAD_MS', isInaugural: 'INAUGURAL', championTitle: 'CHAMPION_TITLE', rewardDescription: 'REWARD_DESCRIPTION',
  rankedBotIds: 'RANKED_BOT_IDS',
  resultCountdownMs: 'RESULT_COUNTDOWN_MS', waitMs: 'WAIT_MS', eventRetryMs: 'EVENT_RETRY_MS',
  backgroundLeaseMs: 'BACKGROUND_LEASE_MS', backgroundReadyTimeoutMs: 'BACKGROUND_READY_TIMEOUT_MS',
};
const times = new Set(['registrationStartsAt', 'registrationEndsAt', 'startsAt', 'endsAt']);
const messageTypes = new Set(['TOURNAMENT_STATUS', 'TOURNAMENT_REGISTER', 'TOURNAMENT_UNREGISTER', 'TOURNAMENT_JOIN', 'TOURNAMENT_NEXT', 'TOURNAMENT_PAUSE', 'TOURNAMENT_READY', 'TOURNAMENT_PRESENCE', 'TOURNAMENT_MOVE', 'TOURNAMENT_RESIGN']);
const textFields = new Set(['id', 'title', 'championTitle', 'rewardDescription']);
function invalid(): never { throw new Error('INVALID_SETTINGS'); }
function time(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15) return value;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return invalid();
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return invalid();
  if (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) return invalid();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : invalid();
}
/** Strict JSON validation: the forgiving environment parser must never silently clamp operator input. */
export function validateTournamentSettings(input: Record<string, unknown>): TournamentSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  if (typeof input.id !== 'string' || !ID.test(input.id) || input.startsAt === undefined || input.endsAt === undefined) return invalid();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'nextTournament') continue;
    if (key === 'standingsLimit') { if (value !== 100) return invalid(); continue; }
    if (!Object.hasOwn(fields, key)) return invalid();
    if (times.has(key)) env[`MONGJIN_TOURNAMENT_${fields[key]}`] = String(time(value));
    else if (key === 'rankedBotIds') {
      if (typeof value !== 'string') return invalid();
      const ids = parseTournamentRankedBotIds(value);
      if (!ids) return invalid();
      if (ids.length) env.MONGJIN_TOURNAMENT_RANKED_BOT_IDS = ids.join(',');
    }
    else if (textFields.has(key)) {
      if (typeof value !== 'string' || (key !== 'rewardDescription' && !value.trim())) return invalid();
      env[`MONGJIN_TOURNAMENT_${fields[key]}`] = value;
    } else if (key === 'isInaugural') {
      if (typeof value !== 'boolean') return invalid();
      env.MONGJIN_TOURNAMENT_INAUGURAL = String(value);
    } else {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) return invalid();
      env[`MONGJIN_TOURNAMENT_${fields[key]}`] = String(value);
    }
  }
  const next = input.nextTournament;
  if (next !== undefined && next !== null) {
    if (typeof next !== 'object' || Array.isArray(next)) return invalid();
    const item = next as Record<string, unknown>;
    if (Object.keys(item).some(k => !['id', 'title', 'startsAt', 'endsAt'].includes(k)) || typeof item.id !== 'string' || !ID.test(item.id) || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 100) return invalid();
    env.MONGJIN_TOURNAMENT_NEXT_ID = item.id;
    env.MONGJIN_TOURNAMENT_NEXT_TITLE = item.title;
    env.MONGJIN_TOURNAMENT_NEXT_STARTS_AT = String(time(item.startsAt));
    env.MONGJIN_TOURNAMENT_NEXT_ENDS_AT = String(time(item.endsAt));
  }
  const settings = tournamentSettingsFromEnv(env, { warn: () => undefined });
  if (!settings || settings.title.length > 100 || settings.championTitle.length > 200 || settings.rewardDescription.length > 4000 ||
    settings.startingScore !== 0 || settings.matchCountdownMs !== 5000) return invalid();
  if (next && (!settings.nextTournament || settings.nextTournament.id === settings.id || settings.nextTournament.startsAt < settings.endsAt)) return invalid();
  for (const key of Object.keys(input)) {
    if (key === 'rankedBotIds') {
      const ids = typeof input[key] === 'string' ? parseTournamentRankedBotIds(input[key] as string) : null;
      if (!ids || ids.join(',') !== (settings.rankedBotIds ?? '')) return invalid();
      continue;
    }
    if (!textFields.has(key) && !times.has(key) && key !== 'nextTournament' && key !== 'isInaugural' && input[key] !== settings[key as keyof TournamentSettings]) return invalid();
  }
  return settings;
}
const overlaps = (a: TournamentSettings, b: TournamentSettings) => a.startsAt < b.endsAt && a.endsAt > b.startsAt;

export interface TournamentRegistryBackgroundOptions {
  /** Existing stored fixed-bot profiles; never creates profiles or credentials. */
  getBotProfiles?: () => Iterable<StoredProfile>;
  canBackgroundWait?: CanBackgroundWait;
  onBackgroundChange?: BackgroundChangeSink;
}

export class TournamentRegistry {
  private services = new Map<string, TournamentService>();
  private settings = new Map<string, TournamentSettings>();
  private selected = new WeakMap<TournamentClient, string>();
  private proxies = new WeakMap<TournamentClient, TournamentClient>();
  private identities = new Map<TournamentClient, TournamentIdentity>();
  private writes: Promise<unknown> = Promise.resolve();
  private disabled: TournamentService | null = null;
  private closed = false;
  private recoveredCancelled = new Set<string>();
  constructor(private readonly community: CommunityService, private readonly directory: string, private readonly isBusyNormal: (id: string) => boolean, private readonly env: Record<string, string | undefined> = process.env, private readonly backgroundOptions: TournamentRegistryBackgroundOptions = {}) {}
  async initialize() {
    if (this.disabled) return;
    this.disabled = await createTournamentService({ settings: null, store: null });
    const prepared = new Map<string, TournamentStore>();
    try {
      const saved = (await this.community.store.list<TournamentSettings>('schedules')).map(s => validateTournamentSettings(s as unknown as Record<string, unknown>));
      const legacy = tournamentSettingsFromEnv(this.env);
      const imported = legacy && !saved.some(s => s.id === legacy.id) ? validateTournamentSettings(legacy as unknown as Record<string, unknown>) : null;
      if (imported) saved.push(imported);
      saved.sort((a, b) => a.startsAt - b.startsAt);
      for (const settings of saved) {
        if (this.settings.has(settings.id)) throw new Error('DUPLICATE_EVENT_ID');
        if ([...this.settings.values()].some(s => overlaps(s, settings))) throw new Error('OVERLAPPING_EVENTS');
        this.settings.set(settings.id, settings);
      }
      if (imported) await this.community.store.commit([{ namespace: 'schedules', key: imported.id, value: imported }]);
      // Read every lifecycle before delivering recovered events, so next-event metadata skips cancelled schedules.
      for (const settings of saved) prepared.set(settings.id, await this.openStore(settings));
      for (const settings of saved) { await this.attach(settings, prepared.get(settings.id)); prepared.delete(settings.id); }
    } catch (error) {
      for (const service of this.services.values()) await service.shutdown();
      for (const store of prepared.values()) await store.close();
      this.services.clear(); this.settings.clear(); this.recoveredCancelled.clear();
      await this.disabled.shutdown(); this.disabled = null;
      throw error;
    }
  }
  private filePath(id: string): string {
    return this.env.MONGJIN_TOURNAMENT_ID === id && this.env.MONGJIN_TOURNAMENT_DATA_FILE ? this.env.MONGJIN_TOURNAMENT_DATA_FILE : join(this.directory, `${id}.json`);
  }
  /** Read stored records only; do not finalize a lifecycle or recalculate scores. */
  async completedRecords(): Promise<TournamentMatchRecord[]> {
    await this.writes;
    const records: TournamentMatchRecord[] = [];
    for (const id of this.settings.keys()) {
      const store = await createTournamentStore(id, this.filePath(id), this.env.DATABASE_URL ?? '');
      try {
        const data = await store.load();
        records.push(...data.matches.filter(m => m.status === 'completed' && m.scoring === TOURNAMENT_SCORING_VERSION && m.blackKind === 'human' && m.whiteKind === 'human'));
      } finally { await store.close(); }
    }
    return records;
  }
  private async openStore(settings: TournamentSettings): Promise<TournamentStore> {
    const store = await createTournamentStore(settings.id, this.filePath(settings.id), this.env.DATABASE_URL ?? '');
    try {
      const recovered = await store.load();
      if (recovered.settings && !isDeepStrictEqual(validateTournamentSettings(recovered.settings), settings)) throw new Error('RECOVERY_SETTINGS_MISMATCH');
      if (recovered.lifecycle.decision?.status === 'cancelled') this.recoveredCancelled.add(settings.id);
      return store;
    } catch (error) { await store.close(); throw error; }
  }
  private async attach(settings: TournamentSettings, prepared?: TournamentStore) {
    const id = settings.id;
    const store = prepared ?? await this.openStore(settings);
    try {
      const service = await createTournamentService({ settings, store,
        ...this.backgroundOptions,
        isPlayerBusyElsewhere: playerId => this.isBusyNormal(playerId) || [...this.services].some(([other, s]) => other !== id && s.isPlayerBusy(playerId)),
        onEvent: async event => {
          if (event.kind === 'cancelled') this.recoveredCancelled.add(id);
          await this.community.consumeEvent({ ...event, data: { ...event.data, startsAt: settings.startsAt, endsAt: settings.endsAt, rewardDescription: settings.rewardDescription, nextTournament: this.nextAfter(id) } });
          if (['cancelled', 'finished'].includes(event.kind)) this.broadcastSchedules();
        },
      });
      this.services.set(id, service);
    } catch (error) { if (!prepared) await store.close(); throw error; }
  }
  private nextAfter(id: string): TournamentNextEvent | null {
    const current = this.settings.get(id);
    const next = [...this.settings.values()].filter(s => s.id !== id && !this.recoveredCancelled.has(s.id) && s.startsAt >= (current?.endsAt ?? Date.now()) && this.services.get(s.id)?.phase() !== 'cancelled').sort((a, b) => a.startsAt - b.startsAt)[0];
    if (next) return { id: next.id, title: next.title, startsAt: next.startsAt, endsAt: next.endsAt };
    const hinted = current?.nextTournament;
    // A published event is authoritative, including cancellation; never resurrect its old hint.
    return hinted && !this.settings.has(hinted.id) ? { ...hinted } : null;
  }
  private defaultId(): string | undefined {
    const entries = [...this.services.entries()];
    const active = entries.find(([, s]) => ['active', 'finishing'].includes(s.phase()));
    if (active) return active[0];
    const future = entries.filter(([, s]) => ['scheduled', 'recruiting', 'confirmed'].includes(s.phase())).sort(([a], [b]) => this.settings.get(a)!.startsAt - this.settings.get(b)!.startsAt);
    if (future.length) return future[0]![0];
    return entries.sort(([a], [b]) => this.settings.get(b)!.startsAt - this.settings.get(a)!.startsAt)[0]?.[0];
  }
  has(id: string): boolean { return this.settings.has(id); }
  publicStatus(id?: string): TournamentPublicStatus {
    const selected = id ?? this.defaultId();
    const result = this.services.get(selected ?? '')?.publicStatus() ?? this.disabled?.publicStatus() ?? { ...emptyTournamentStatus, serverNow: Date.now() };
    return { ...result, nextTournament: selected && this.services.has(selected) ? this.nextAfter(selected) : null };
  }
  private proxy(client: TournamentClient): TournamentClient {
    let proxy = this.proxies.get(client);
    if (!proxy) {
      proxy = { send: message => client.send(message.type === 'TOURNAMENT_SNAPSHOT' ? { ...message, snapshot: { ...message.snapshot, nextTournament: message.snapshot.config ? this.nextAfter(message.snapshot.config.id) : null } } : message) };
      this.proxies.set(client, proxy);
    }
    return proxy;
  }
  private broadcastSchedules() {
    for (const [client, identity] of this.identities) {
      const id = this.selected.get(client) ?? this.defaultId();
      if (id && !this.selected.has(client)) this.selected.set(client, id);
      const service = id ? this.services.get(id) : undefined;
      if (service) {
        try { this.proxy(client).send({ type: 'TOURNAMENT_SNAPSHOT', snapshot: service.snapshotFor(identity.playerId) }); } catch { /* Main owns socket cleanup. */ }
      }
    }
  }
  async handle(client: TournamentClient, identity: TournamentIdentity | null, message: unknown) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    const msg = message as Record<string, unknown>;
    // Do not detach the current match on a malformed/unauthenticated request.
    if (msg.protocolVersion !== TOURNAMENT_PROTOCOL_VERSION || !identity) {
      await this.disabled?.handle(client, identity, msg); return;
    }
    if (!messageTypes.has(String(msg.type))) { client.send({ type: 'TOURNAMENT_ERROR', code: 'INVALID_MESSAGE', message: '잘못된 요청이에요' }); return; }
    if (msg.tournamentId !== undefined && (typeof msg.tournamentId !== 'string' || !ID.test(msg.tournamentId) || !this.services.has(msg.tournamentId))) {
      client.send({ type: 'TOURNAMENT_ERROR', code: 'INVALID_MESSAGE', message: '대회 ID를 확인해 주세요' }); return;
    }
    const id = typeof msg.tournamentId === 'string' ? msg.tournamentId : this.selected.get(client) ?? this.defaultId();
    const previous = this.selected.get(client);
    const proxy = this.proxy(client);
    if (previous && previous !== id) {
      const prior = this.services.get(previous);
      if (prior?.isPlayerBusy(identity.playerId)) {
        client.send({ type: 'TOURNAMENT_ERROR', code: 'IN_MATCH', message: '현재 대회 대기나 대국을 마친 뒤 이동해 주세요' }); return;
      }
      prior?.detach(proxy, false);
    }
    if (id) this.selected.set(client, id);
    this.identities.set(client, identity);
    await (this.services.get(id ?? '') ?? this.disabled)?.handle(proxy, identity, msg);
  }
  detach(client: TournamentClient) { const proxy = this.proxies.get(client); if (proxy) for (const service of this.services.values()) service.detach(proxy); this.disabled?.detach(client); this.selected.delete(client); this.identities.delete(client); this.proxies.delete(client); }
  canPractice(id: string) { return [...this.services.values()].some(s => s.canPractice(id)); }
  backgroundStatus(playerId: string, tournamentId: string): TournamentBackgroundStatus | null {
    return this.services.get(tournamentId)?.backgroundStatus(playerId) ?? null;
  }
  cancelWaiting(playerId: string, tournamentId?: string): boolean {
    if (tournamentId !== undefined) return this.services.get(tournamentId)?.cancelWaiting(playerId) ?? false;
    let cancelled = false;
    for (const service of this.services.values()) cancelled = service.cancelWaiting(playerId) || cancelled;
    return cancelled;
  }
  isPlayerBusy(id: string) { return [...this.services.values()].some(s => s.isPlayerBusy(id)); }
  updateName(id: string, name: string) { for (const service of this.services.values()) service.updateName(id, name); }
  list() { return [...this.settings.values()].sort((a, b) => a.startsAt - b.startsAt).map(s => ({ settings: structuredClone(s), status: this.publicStatus(s.id) })); }
  publish(input: Record<string, unknown>): Promise<TournamentPublicStatus> {
    const run = this.writes.then(async () => {
      if (this.closed || !this.disabled) throw new Error('REGISTRY_UNAVAILABLE');
      const settings = validateTournamentSettings(input);
      const existing = this.settings.get(settings.id) ?? await this.community.store.get<TournamentSettings>('schedules', settings.id);
      if (existing) {
        if (!isDeepStrictEqual(validateTournamentSettings(existing as unknown as Record<string, unknown>), settings)) throw new Error('EVENT_ALREADY_PUBLISHED');
        if (!this.services.has(settings.id)) { this.settings.set(settings.id, settings); await this.attach(settings); }
        this.broadcastSchedules();
        return this.publicStatus(settings.id);
      }
      if (settings.startsAt <= Date.now() || settings.registrationEndsAt <= Date.now()) throw new Error('INVALID_SETTINGS');
      if ([...this.settings.values()].some(s => overlaps(s, settings))) throw new Error('OVERLAPPING_EVENTS');
      await this.community.store.commit([{ namespace: 'schedules', key: settings.id, value: settings }]);
      this.settings.set(settings.id, settings);
      await this.attach(settings);
      this.broadcastSchedules(); // Durable schedule remains recoverable if attaching fails.
      return this.publicStatus(settings.id);
    });
    this.writes = run.catch(() => undefined); return run;
  }
  async shutdown() { this.closed = true; this.identities.clear(); await this.writes; for (const s of this.services.values()) await s.shutdown(); await this.disabled?.shutdown(); }
}
export const emptyTournamentStatus: TournamentPublicStatus = { protocolVersion: TOURNAMENT_PROTOCOL_VERSION, config: null, phase: 'disabled', serverNow: 0, entrantCount: 0, registrationCount: 0, nextTournament: null };
