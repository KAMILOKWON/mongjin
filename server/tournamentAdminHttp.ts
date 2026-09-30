import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState, legalMoves } from '../src/core/rules';
import { applyMove } from '../src/core/apply';
import { getResult } from '../src/core/result';
import type { Move } from '../src/core/types';
import type { CommunityService, TournamentReward } from './community';
import { communityReply, hasAdminAuthorization, HttpError, readCommunityJson } from './communityHttp';
import type { RecordedMatchEvent } from './profileRepository';
import type { TournamentRegistry } from './tournamentRegistry';
import type { TournamentTelemetry } from './tournamentTelemetry';
import type { TournamentScheduler } from './tournamentScheduler';
import { TOURNAMENT_SCORING_VERSION, type TournamentMatchRecord } from './tournamentStore';

export type GetNormalEvents = () => Promise<RecordedMatchEvent[]>;
const methods: Record<string, string[]> = {
  '/admin/tournaments': ['GET', 'POST'], '/admin/analytics': ['GET'], '/admin/notifications': ['GET'],
  '/admin/rewards': ['GET', 'POST'], '/admin/training-export': ['GET'], '/tournament/analytics': ['POST'],
  '/admin/tournament-scheduler': ['GET', 'POST'], '/admin/tournament-scheduler/dry-run': ['GET'],
};
const countStates = (rows: { state?: string; status?: string }[], field: 'state' | 'status', allowed: string[]) =>
  Object.fromEntries(allowed.map(state => [state, rows.filter(row => row[field] === state).length]));
function exportMoves(input: unknown, allowEmpty = false): Move[] | null {
  if (!Array.isArray(input) || (!allowEmpty && input.length === 0) || input.length > 512) return null;
  let state = initialState(DEFAULT_CONFIG);
  const result: Move[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object' || !raw.to) return null;
    const coord = (value: { r?: unknown; c?: unknown } | undefined) => value && typeof value.r === 'number' && typeof value.c === 'number' && Number.isInteger(value.r) && Number.isInteger(value.c) ? { r: value.r, c: value.c } : null;
    const to = coord(raw.to), from = coord(raw.from);
    if (!to || raw.kind !== 'PLACE' && raw.kind !== 'MOVE' || raw.kind === 'MOVE' && !from) return null;
    const move: Move = raw.kind === 'PLACE' ? { kind: 'PLACE', to } : { kind: 'MOVE', from: from!, to };
    if (getResult(state, DEFAULT_CONFIG) || !legalMoves(state, DEFAULT_CONFIG).some(m => JSON.stringify(m) === JSON.stringify(move))) return null;
    state = applyMove(state, move); result.push(move);
  }
  return result;
}
/** Explicit projection; never spread stored records (which may contain credentials or identifiers). */
export async function trainingExport(community: CommunityService, getTournamentRecords?: () => Promise<TournamentMatchRecord[]>) {
  const records = await community.store.list<Record<string, unknown>>('practiceRecords');
  const exported: unknown[] = [];
  let rejected = 0, skipped = 0;
  for (const record of records) {
    if (record.completed !== true) { skipped++; continue; }
    const moves = exportMoves(record.moves);
    if (!moves || record.rulesVersion !== 'mongjin-core-1' || typeof record.modelVersion !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(record.modelVersion) || !['completed', 'resign', 'interrupted'].includes(String(record.reason))) { rejected++; continue; }
    let state = initialState(DEFAULT_CONFIG);
    for (const move of moves) state = applyMove(state, move);
    const result = getResult(state, DEFAULT_CONFIG);
    if (record.reason !== 'resign' && !result) { rejected++; continue; }
    exported.push({ schemaVersion: 1, source: 'tournament_practice', rulesVersion: 'mongjin-core-1', modelVersion: record.modelVersion, moves, reason: record.reason, winner: result?.winner ?? null });
  }
  let tournamentCount: number | null = getTournamentRecords ? 0 : null;
  for (const record of getTournamentRecords ? await getTournamentRecords() : []) {
    if (record.status !== 'completed' || record.scoring !== TOURNAMENT_SCORING_VERSION || record.blackKind !== 'human' || record.whiteKind !== 'human') { skipped++; continue; }
    const moves = exportMoves(record.moves, true);
    if (!moves || !['BLACK', 'WHITE'].includes(String(record.winner)) || !['goal', 'capture', 'surround', 'no-moves', 'resign', 'timeout', 'disconnect'].includes(String(record.reason))) { rejected++; continue; }
    let state = initialState(DEFAULT_CONFIG);
    for (const move of moves) state = applyMove(state, move);
    const result = getResult(state, DEFAULT_CONFIG);
    if (result && result.winner !== record.winner || !['resign', 'timeout', 'disconnect'].includes(record.reason!) && (!result || result.reason !== record.reason)) { rejected++; continue; }
    exported.push({ schemaVersion: 1, source: 'human_tournament', rulesVersion: 'mongjin-core-1', scoring: TOURNAMENT_SCORING_VERSION, moves, reason: record.reason, winner: record.winner });
    tournamentCount!++;
  }
  return { records: exported, exportedCount: exported.length, tournamentCount, rejectedCount: rejected, skippedCount: skipped, scope: 'completed human tournament records and completed practice records; normal export uses server/exportGames.ts; not model training' };
}

export function createTournamentAdminHandler(
  registry: TournamentRegistry,
  community: CommunityService,
  telemetry: TournamentTelemetry,
  authorize: (playerId: string, token: string) => boolean,
  getNormalEvents?: GetNormalEvents,
  scheduler?: TournamentScheduler,
) {
  let rewardTail: Promise<unknown> = Promise.resolve();
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const path = req.url?.split('?')[0] ?? '';
    if (!Object.hasOwn(methods, path)) return false;
    try {
      if (path.startsWith('/admin/') && !hasAdminAuthorization(req)) throw new HttpError(401, 'NOT_AUTHORIZED');
      if (!methods[path].includes(req.method ?? '')) throw new HttpError(405, 'METHOD_NOT_ALLOWED');
      const url = new URL(req.url ?? '/', 'http://localhost');
      let result: unknown;
      let status = 200;
      switch (path) {
        case '/admin/tournament-scheduler':
          if (!scheduler) throw new HttpError(503, 'SCHEDULER_UNAVAILABLE');
          result = req.method === 'GET' ? scheduler.status() : await scheduler.configure(await readCommunityJson(req));
          break;
        case '/admin/tournament-scheduler/dry-run':
          if (!scheduler) throw new HttpError(503, 'SCHEDULER_UNAVAILABLE');
          result = await scheduler.dryRun();
          break;
        case '/admin/tournaments':
          if (req.method === 'GET') result = { tournaments: registry.list() };
          else { result = await registry.publish(await readCommunityJson(req)); status = 201; }
          break;
        case '/admin/analytics': {
          const value = url.searchParams.get('days') ?? '14';
          if (!['14', '28'].includes(value) || url.searchParams.getAll('days').length > 1) throw new HttpError(400, 'INVALID_DAYS');
          const normal = getNormalEvents ? await getNormalEvents() : undefined;
          result = await telemetry.stats(value === '14' ? 14 : 28, normal); break;
        }
        case '/admin/notifications': {
          const [notices, jobs, receipts, devices, prefs] = await Promise.all([
            community.store.list('notices'), community.store.list<{ state: string }>('pushJobs'),
            community.store.list<{ status: string }>('pushReceipts'), community.store.list('devices'),
            community.store.list<{ tournamentReminders: boolean }>('preferences'),
          ]);
          result = { noticeCount: notices.length, deviceCount: devices.length, optedInCount: prefs.filter(p => p.tournamentReminders === true).length,
            jobs: countStates(jobs, 'state', ['pending', 'accepted', 'skipped', 'failed']), receipts: countStates(receipts, 'status', ['accepted', 'delivered', 'failed', 'unknown']),
            pushEnabled: process.env.MONGJIN_PUSH_ENABLED === '1', scope: 'stored delivery status; accepted is not proof of delivery' }; break;
        }
        case '/admin/rewards':
          if (req.method === 'GET') {
            const rewards = await community.store.list<TournamentReward>('rewards');
            result = { rewards: rewards.map(r => ({ id: r.id, tournamentId: r.tournamentId, description: r.description, status: r.status, updatedAt: r.updatedAt })), fulfillment: 'operator status only; no gift is sent' };
          } else {
            const body = await readCommunityJson(req);
            if (typeof body.id !== 'string' || !body.id || body.id.length > 512 || !['pending', 'fulfilled'].includes(String(body.status)) || Object.keys(body).some(k => !['id', 'status'].includes(k))) throw new HttpError(400, 'INVALID_REQUEST');
            const update = rewardTail.then(async () => {
              const reward = await community.store.get<TournamentReward>('rewards', body.id as string);
              if (!reward) throw new HttpError(404, 'NOT_FOUND');
              if (reward.status === body.status) return { id: reward.id, status: reward.status, updatedAt: reward.updatedAt };
              const now = new Date().toISOString();
              const auditId = randomUUID();
              await community.store.commit([
                { namespace: 'rewards', key: reward.id, value: { ...reward, status: body.status, updatedAt: now } },
                { namespace: 'rewardAudit', key: auditId, value: { id: auditId, rewardId: reward.id, from: reward.status, to: body.status, occurredAt: now, actor: 'admin' } },
              ]);
              return { id: reward.id, status: body.status, updatedAt: now };
            });
            rewardTail = update.catch(() => undefined); result = await update;
          }
          break;
        case '/admin/training-export': result = await trainingExport(community, () => registry.completedRecords()); break;
        case '/tournament/analytics': {
          const body = await readCommunityJson(req);
          if (typeof body.playerId !== 'string' || typeof body.token !== 'string' || !authorize(body.playerId, body.token)) throw new HttpError(401, 'NOT_AUTHENTICATED');
          if (typeof body.tournamentId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(body.tournamentId)) throw new HttpError(400, 'INVALID_REQUEST');
          if (!registry.has(body.tournamentId)) throw new HttpError(404, 'NOT_FOUND');
          result = await telemetry.recordClientEvent(body.playerId, body); break;
        }
      }
      communityReply(res, status, result);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'INTERNAL_ERROR';
      const bad = ['INVALID_SETTINGS', 'INVALID_REQUEST', 'INVALID_DAYS', 'INVALID_SCHEDULER_POLICY'];
      const conflict = ['EVENT_ALREADY_PUBLISHED', 'OVERLAPPING_EVENTS', 'EVENT_ID_CONFLICT'];
      const status = error instanceof HttpError ? error.status : bad.includes(code) ? 400 : conflict.includes(code) ? 409 : code === 'RATE_LIMITED' ? 429 : 500;
      communityReply(res, status, { error: status === 500 ? 'INTERNAL_ERROR' : code });
    }
    return true;
  };
}
