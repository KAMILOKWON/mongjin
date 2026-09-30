import { randomUUID, createPrivateKey, sign } from 'node:crypto';
import { connect } from 'node:http2';
import { readFile, access } from 'node:fs/promises';
import type { CommunityStore } from './communityStore';

export type WaitingDestination = { kind: 'expo'; token: string } | { kind: 'live_activity'; token: string; activityId: string };
export interface WaitingUpdate {
  playerId: string;
  tournamentId: string;
  title: string;
  queuedAt: number | null;
  expiresAt: number | null;
  state: 'waiting' | 'matched' | 'ended';
  matchId?: string;
}
interface WaitingDevice { playerId: string; tournamentId: string; destination: WaitingDestination; updatedAt: number }
interface WaitingState extends WaitingUpdate { id: string; version: string; updatedAt: number; issuedAt: number; deliveryQueuedAt: number | null }
interface WaitingJob { id: string; stateId: string; version: string; destination: WaitingDestination; attempts: number; nextAttemptAt: number; status: 'pending' | 'accepted' | 'failed' | 'skipped' }
export type WaitingTransport = (destination: WaitingDestination, update: WaitingUpdate) => Promise<void>;
const scopeKey = (playerId: string, tournamentId: string) => JSON.stringify([playerId, tournamentId]);
const deviceKey = (playerId: string, tournamentId: string, kind: string) => JSON.stringify([playerId, tournamentId, kind]);
const idPattern = /^[A-Za-z0-9_-]{1,64}$/;
export function parseWaitingDestination(value: unknown): WaitingDestination | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.token !== 'string') return null;
  if (input.kind === 'expo' && /^(?:ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{8,200}\]$/.test(input.token)) return { kind: 'expo', token: input.token };
  if (input.kind === 'live_activity' && /^[a-fA-F0-9]{64,512}$/.test(input.token) && typeof input.activityId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(input.activityId))
    return { kind: 'live_activity', token: input.token.toLowerCase(), activityId: input.activityId };
  return null;
}

/** Queue notification permissions are separate from event reminder consent. */
export class WaitingNotifications {
  private writes: Promise<unknown> = Promise.resolve();
  private flushing = false;
  private closed = false;
  private delivery: Promise<void> | null = null;
  constructor(private readonly store: CommunityStore, private readonly env: Record<string, string | undefined> = process.env,
    private readonly transport: WaitingTransport = (destination, update) => this.send(destination, update), private readonly now: () => number = Date.now) {}

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writes.then(operation);
    this.writes = run.catch(() => undefined);
    return run;
  }
  async available(kind: WaitingDestination['kind']): Promise<boolean> {
    if (this.closed || this.env.MONGJIN_MATCH_PUSH_ENABLED !== '1') return false;
    if (kind === 'expo') return true;
    if (!this.env.MONGJIN_APNS_KEY_ID || !this.env.MONGJIN_APNS_TEAM_ID || !this.env.MONGJIN_APNS_KEY_PATH || !this.env.MONGJIN_APNS_BUNDLE_ID) return false;
    try { await access(this.env.MONGJIN_APNS_KEY_PATH); return true; } catch { return false; }
  }
  register(playerId: string, tournamentId: string, destination: WaitingDestination): Promise<{ canBackgroundWait: boolean }> {
    return this.serial(async () => {
      if (!idPattern.test(tournamentId) || !parseWaitingDestination(destination)) throw new Error('INVALID_DESTINATION');
      const devices = await this.store.list<WaitingDevice>('waitingDevices');
      // Tokens are private to their authenticated owner, even across events.
      if (devices.some(device => device.destination.token === destination.token && device.playerId !== playerId)) throw new Error('DESTINATION_OWNED');
      await this.store.commit([{ namespace: 'waitingDevices', key: deviceKey(playerId, tournamentId, destination.kind), value: { playerId, tournamentId, destination, updatedAt: this.now() } }]);
      const state = await this.store.get<WaitingState>('waitingStates', scopeKey(playerId, tournamentId));
      if (state?.state === 'matched' && state.expiresAt !== null && state.expiresAt > this.now()) {
        const job: WaitingJob = { id: randomUUID(), stateId: state.id, version: state.version, destination, attempts: 0, nextAttemptAt: this.now(), status: 'pending' };
        await this.store.commit([{ namespace: 'waitingPushJobs', key: job.id, value: job }]);
        queueMicrotask(() => { void this.flush().catch(() => undefined); });
      }
      return { canBackgroundWait: await this.available(destination.kind) };
    });
  }
  async canBackgroundWait(playerId: string, tournamentId: string, destination: WaitingDestination): Promise<boolean> {
    if (!parseWaitingDestination(destination) || !await this.available(destination.kind)) return false;
    await this.writes;
    const device = await this.store.get<WaitingDevice>('waitingDevices', deviceKey(playerId, tournamentId, destination.kind));
    return Boolean(device && device.destination.token === destination.token &&
      (destination.kind !== 'live_activity' || device.destination.kind === 'live_activity' && device.destination.activityId === destination.activityId));
  }
  update(input: WaitingUpdate): Promise<void> {
    return this.serial(async () => {
      if (this.closed || !idPattern.test(input.tournamentId)) return;
      const id = scopeKey(input.playerId, input.tournamentId);
      const prior = await this.store.get<WaitingState>('waitingStates', id);
      // Duplicate lifecycle callbacks don't create duplicate alerts.
      if (prior && prior.state === input.state && prior.matchId === input.matchId && prior.queuedAt === input.queuedAt && prior.expiresAt === input.expiresAt) return;
      const state: WaitingState = { ...input, title: input.title.slice(0, 100), id, version: randomUUID(),
        updatedAt: this.now(), issuedAt: Math.max(this.now(), (prior?.issuedAt ?? prior?.updatedAt ?? 0) + 1),
        deliveryQueuedAt: input.queuedAt ?? prior?.deliveryQueuedAt ?? prior?.queuedAt ?? null };
      const devices = (await this.store.list<WaitingDevice>('waitingDevices')).filter(device => device.playerId === input.playerId && device.tournamentId === input.tournamentId);
      const jobs: WaitingJob[] = devices.map(device => ({ id: randomUUID(), stateId: id, version: state.version, destination: device.destination, attempts: 0, nextAttemptAt: this.now(), status: 'pending' }));
      await this.store.commit([{ namespace: 'waitingStates', key: id, value: state }, ...jobs.map(job => ({ namespace: 'waitingPushJobs', key: job.id, value: job }))]);
      // Delivery runs after this serialized write, with no network in a rules tick.
      queueMicrotask(() => { void this.flush().catch(() => undefined); });
    });
  }
  async recover(): Promise<void> {
    // Queue leases deliberately do not survive a server restart.
    const states = await this.store.list<WaitingState>('waitingStates');
    for (const state of states) if (state.state !== 'ended') await this.update({ ...state, state: 'ended', expiresAt: this.now(), matchId: undefined });
  }
  async flush(): Promise<void> {
    if (this.closed || this.flushing || this.env.MONGJIN_MATCH_PUSH_ENABLED !== '1') return;
    this.flushing = true;
    this.delivery = this.deliverPending();
    try { await this.delivery; } finally { this.flushing = false; this.delivery = null; }
  }
  private async deliverPending(): Promise<void> {
    try {
      await this.writes;
      const jobs = (await this.store.list<WaitingJob>('waitingPushJobs')).filter(job => job.status === 'pending' && job.nextAttemptAt <= this.now()).slice(0, 30);
      for (const job of jobs) {
        const state = await this.store.get<WaitingState>('waitingStates', job.stateId);
        const valid = state && state.version === job.version && (state.state === 'ended' ? this.now() - state.updatedAt < 4 * 60 * 60_000 : state.expiresAt !== null && state.expiresAt > this.now());
        const owned = state && await this.canBackgroundWait(state.playerId, state.tournamentId, job.destination);
        if (!valid || !owned) {
          await this.store.commit([{ namespace: 'waitingPushJobs', key: job.id, value: { ...job, status: 'skipped' } }]);
          continue;
        }
        try {
          // Check current state again before transport after asynchronous capability reads.
          const latest = await this.store.get<WaitingState>('waitingStates', job.stateId);
          if (latest?.version !== job.version) { await this.store.commit([{ namespace: 'waitingPushJobs', key: job.id, value: { ...job, status: 'skipped' } }]); continue; }
          if (job.destination.kind === 'expo' && state.state !== 'matched') {
            await this.store.commit([{ namespace: 'waitingPushJobs', key: job.id, value: { ...job, status: 'skipped' } }]);
            continue;
          }
          await this.transport(job.destination, state);
          await this.store.commit([{ namespace: 'waitingPushJobs', key: job.id, value: { ...job, status: 'accepted', attempts: job.attempts + 1 } }]);
        } catch {
          const attempts = job.attempts + 1;
          await this.store.commit([{ namespace: 'waitingPushJobs', key: job.id, value: { ...job, attempts, status: attempts >= 3 ? 'failed' : 'pending', nextAttemptAt: this.now() + 5_000 * attempts } }]);
        }
      }
    } finally { /* The caller owns the in-flight delivery lifetime. */ }
  }
  async close(): Promise<void> {
    await this.writes;
    // Keep ownership/capability checks available while the last cleanup batch
    // drains; closing first would silently skip its remaining destinations.
    await this.delivery;
    await this.flush();
    this.closed = true;
  }

  private async send(destination: WaitingDestination, update: WaitingUpdate): Promise<void> {
    if (destination.kind === 'live_activity') {
      await sendWaitingApns(destination.token, update, this.env, this.now());
      return;
    }
    // The OS displays this ordinary push while JavaScript is suspended.
    const state = update as Partial<WaitingState>;
    const data = { tournamentId: update.tournamentId, waitingState: update.state,
      queuedAt: update.queuedAt ?? state.deliveryQueuedAt ?? null, expiresAt: update.expiresAt,
      issuedAt: state.issuedAt ?? state.updatedAt ?? this.now(), matchId: update.matchId };
    const response = await fetch('https://exp.host/--/api/v2/push/send', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(this.env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${this.env.EXPO_ACCESS_TOKEN}` } : {}) },
      body: JSON.stringify({ to: destination.token, priority: 'high', channelId: 'tournament-match', sound: 'default',
        title: '대국 상대를 찾았어요', body: '대회로 돌아와 준비해 주세요', data,
        ttl: update.state === 'ended' ? 120 : Math.max(1, Math.min(120, Math.ceil(((update.expiresAt ?? this.now()) - this.now()) / 1000))) }), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('WAITING_PUSH_FAILED');
    const body = await response.json() as { data?: { status?: string } };
    if (body.data?.status !== 'ok') throw new Error('WAITING_PUSH_REJECTED');
  }
}

export function waitingActivityPayload(update: WaitingUpdate, timestamp: number) {
  const props = { tournamentId: update.tournamentId, title: update.title, queuedAt: update.queuedAt ?? timestamp, expiresAt: update.expiresAt ?? timestamp, state: update.state, ...(update.matchId ? { matchId: update.matchId } : {}) };
  return { aps: { timestamp: Math.floor(timestamp / 1000), event: update.state === 'ended' ? 'end' : 'update', 'content-state': { name: 'MongjinWaitingActivity', props: JSON.stringify(props) },
    ...(update.state === 'ended' ? { 'dismissal-date': Math.floor(timestamp / 1000) } : { 'stale-date': Math.floor((update.expiresAt ?? timestamp) / 1000) }),
    ...(update.state === 'matched' ? { alert: { title: '실제 대국 상대를 찾았습니다!', body: '대회로 돌아와 대국을 준비해 주세요.' } } : {}) } };
}
async function sendWaitingApns(token: string, update: WaitingUpdate, env: Record<string, string | undefined>, now: number) {
  const privateKey = createPrivateKey(await readFile(env.MONGJIN_APNS_KEY_PATH!));
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'ES256', kid: env.MONGJIN_APNS_KEY_ID });
  const claims = encode({ iss: env.MONGJIN_APNS_TEAM_ID, iat: Math.floor(now / 1000) });
  const unsigned = `${header}.${claims}`;
  const jwt = `${unsigned}.${sign('sha256', Buffer.from(unsigned), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  const payload = JSON.stringify(waitingActivityPayload(update, now));
  if (Buffer.byteLength(payload) > 4096) throw new Error('WAITING_PAYLOAD_TOO_LARGE');
  const origin = env.MONGJIN_APNS_ENVIRONMENT === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
  await new Promise<void>((resolve, reject) => {
    const client = connect(origin);
    const timer = setTimeout(() => { client.destroy(); reject(new Error('WAITING_APNS_TIMEOUT')); }, 10_000);
    const finish = (error?: Error) => { clearTimeout(timer); client.close(); error ? reject(error) : resolve(); };
    client.on('error', () => finish(new Error('WAITING_APNS_FAILED')));
    const expiration = update.state === 'ended' ? now + 120_000 : update.expiresAt ?? now + 120_000;
    const stream = client.request({ ':method': 'POST', ':path': `/3/device/${token}`, authorization: `bearer ${jwt}`, 'apns-topic': `${env.MONGJIN_APNS_BUNDLE_ID}.push-type.liveactivity`, 'apns-push-type': 'liveactivity', 'apns-priority': update.state === 'matched' ? '10' : '5', 'apns-expiration': String(Math.floor(expiration / 1000)), 'content-type': 'application/json' });
    let status = 0;
    stream.on('response', headers => { status = Number(headers[':status']); });
    stream.on('data', () => undefined);
    stream.on('error', () => finish(new Error('WAITING_APNS_FAILED')));
    stream.on('end', () => finish(status === 200 ? undefined : new Error('WAITING_APNS_REJECTED')));
    stream.end(payload);
  });
}
