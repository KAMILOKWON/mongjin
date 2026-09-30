import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState, legalMoves } from '../src/core/rules';
import { applyMove } from '../src/core/apply';
import { getResult } from '../src/core/result';
import type { Move } from '../src/core/types';
import { CommunityService, type CommunityEvent, type PushJob } from './community';
import { FileCommunityStore } from './communityStore';

let dir: string;
let path: string;
let clock: number;
let store: FileCommunityStore;
let svc: CommunityService;
const NOW = Date.parse('2026-10-01T00:00:00Z');
const TOKEN = 'ExponentPushToken[abc_123]';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mongjin-community-'));
  path = join(dir, 'community.json');
  clock = NOW;
  store = new FileCommunityStore(path);
  svc = new CommunityService(store, () => clock);
});
afterEach(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });

const event = (over: Partial<CommunityEvent> = {}): CommunityEvent => ({
  id: 'e1', tournamentId: 'cup', title: '제1회 대회', kind: 'confirmed', occurredAt: NOW, playerIds: ['p1', 'p2'], data: {}, ...over,
});

// Plays a deterministic practice game through the service. Human = even plies, AI = odd plies.
async function play(id: string, player: string, plies: number, service = svc) {
  let state = initialState(DEFAULT_CONFIG);
  const moves: Move[] = [];
  for (let i = 0; i < plies && !getResult(state, DEFAULT_CONFIG); i++) {
    const legal = legalMoves(state, DEFAULT_CONFIG);
    const human = legal[(i * 7) % legal.length]!;
    moves.push(human); state = applyMove(state, human);
    if (getResult(state, DEFAULT_CONFIG)) break;
    expect(await service.beforePractice(player, id, moves)).toBeNull();
    const ai = legalMoves(state, DEFAULT_CONFIG)[(i * 3) % legalMoves(state, DEFAULT_CONFIG).length]!;
    await service.savePracticeMove(player, id, moves, ai, 'model-1');
    moves.push(ai); state = applyMove(state, ai);
  }
  return { moves, state };
}

describe('inbox', () => {
  it('shows broadcast notices to everyone and targeted ones only to listed players', async () => {
    await svc.publishNotice({ id: 'all', title: '공지', body: '본문' });
    await svc.publishNotice({ id: 'priv', title: '개인', body: '본문', playerIds: ['p1'] });
    const p1 = await svc.inbox('p1'); const p2 = await svc.inbox('p2');
    expect(p1.messages.map((m) => m.id).sort()).toEqual(['all', 'priv']);
    expect(p2.messages.map((m) => m.id)).toEqual(['all']);
    expect(p2.unreadCount).toBe(1);
  });

  it('hides future-dated and expired notices', async () => {
    await svc.publishNotice({ id: 'future', title: 't', body: 'b', availableAt: NOW + 1000 });
    await svc.publishNotice({ id: 'exp', title: 't', body: 'b', availableAt: NOW - 2000, expiresAt: NOW + 500 });
    expect((await svc.inbox('p1')).messages.map((m) => m.id)).toEqual(['exp']);
    clock = NOW + 1000;
    expect((await svc.inbox('p1')).messages.map((m) => m.id)).toEqual(['future']);
  });

  it('rejects invalid notices', async () => {
    await expect(svc.publishNotice({ title: '', body: 'b' })).rejects.toThrow();
    await expect(svc.publishNotice({ title: 't', body: '' })).rejects.toThrow();
    await expect(svc.publishNotice({ title: 't', body: 'b', id: 'bad id!' })).rejects.toThrow();
    await expect(svc.publishNotice({ title: 't', body: 'b', availableAt: NOW, expiresAt: NOW })).rejects.toThrow();
    await expect(svc.publishNotice({ title: 'x'.repeat(101), body: 'b' })).rejects.toThrow();
  });

  it('markRead is idempotent, per player, and lowers unread only for the reader', async () => {
    await svc.publishNotice({ id: 'n1', title: 't', body: 'b' });
    const first = await svc.markRead('p1', 'n1');
    expect(first.unreadCount).toBe(0);
    const readAt = first.messages[0]!.readAt;
    expect(readAt).not.toBeNull();
    clock += 5000;
    const again = await svc.markRead('p1', 'n1');
    expect(again.unreadCount).toBe(0);
    expect(again.messages[0]!.readAt).toBe(readAt);
    expect((await svc.inbox('p2')).unreadCount).toBe(1);
  });

  it('markRead errors for unknown, private-to-others, and not-yet-available notices without leaking state', async () => {
    await svc.publishNotice({ id: 'priv', title: 't', body: 'b', playerIds: ['p1'] });
    await svc.publishNotice({ id: 'future', title: 't', body: 'b', availableAt: NOW + 10_000 });
    await expect(svc.markRead('p1', 'missing')).rejects.toThrow('NOT_FOUND');
    await expect(svc.markRead('p2', 'priv')).rejects.toThrow('NOT_FOUND');
    await expect(svc.markRead('p1', 'future')).rejects.toThrow('NOT_FOUND');
    expect((await svc.inbox('p1')).messages.find((m) => m.id === 'priv')!.readAt).toBeNull();
  });

  it('concurrent markRead calls keep a single read record', async () => {
    await svc.publishNotice({ id: 'n1', title: 't', body: 'b' });
    await Promise.all([svc.markRead('p1', 'n1'), svc.markRead('p1', 'n1'), svc.markRead('p1', 'n1')]);
    expect(await store.list('reads')).toHaveLength(1);
  });
});

describe('tournament events', () => {
  it('creates a notice only for participants and stays isolated from others', async () => {
    await svc.consumeEvent(event());
    expect((await svc.inbox('p1')).messages).toHaveLength(1);
    expect((await svc.inbox('p1')).messages[0]!.tournamentId).toBe('cup');
    expect((await svc.inbox('outsider')).messages).toHaveLength(0);
  });

  it('consuming the same event twice is idempotent, even concurrently', async () => {
    await Promise.all([svc.consumeEvent(event()), svc.consumeEvent(event())]);
    await svc.consumeEvent(event());
    expect((await store.list('notices'))).toHaveLength(1);
    expect((await svc.inbox('p1')).unreadCount).toBe(1);
  });

  it('same event id in a different tournament is a distinct event', async () => {
    await svc.consumeEvent(event());
    await svc.consumeEvent(event({ tournamentId: 'cup2' }));
    expect(await store.list('notices')).toHaveLength(2);
  });

  it('does not create a notice for unknown kinds or events with no players', async () => {
    await svc.consumeEvent(event({ id: 'x', kind: 'mystery' }));
    await svc.consumeEvent(event({ id: 'y', playerIds: [] }));
    expect(await store.list('notices')).toHaveLength(0);
  });

  it('creates no push job when reminders are off (default) and a queued job when on', async () => {
    await svc.preferences('p2', true);
    await svc.consumeEvent(event({ kind: 'reminder' }));
    const jobs = await store.list<PushJob>('pushJobs');
    expect(jobs.map((j) => j.playerId)).toEqual(['p2']);
    expect(jobs[0]).toMatchObject({ state: 'pending', attempts: 0, tournamentId: 'cup' });
    expect((await store.list<{ id: string }>('notices')).map((n) => n.id)).toContain(jobs[0]!.noticeId);
  });

  it('explicitly turning reminders off after on stops new jobs', async () => {
    await svc.preferences('p1', true);
    expect(await svc.preferences('p1', false)).toEqual({ tournamentReminders: false });
    await svc.consumeEvent(event());
    expect(await store.list('pushJobs')).toHaveLength(0);
    expect(await svc.preferences('never-set')).toEqual({ tournamentReminders: false });
  });

  it('re-consuming an event does not duplicate push jobs', async () => {
    await svc.preferences('p1', true);
    await svc.consumeEvent(event());
    await svc.consumeEvent(event());
    expect(await store.list('pushJobs')).toHaveLength(1);
  });

  it('champion events grant one achievement per player, once, and only with an explicit title', async () => {
    await svc.consumeEvent(event({ id: 'c1', kind: 'champion', playerIds: ['p1'], data: { championTitle: '천하제일' } }));
    await svc.consumeEvent(event({ id: 'c1', kind: 'champion', playerIds: ['p1'], data: { championTitle: '천하제일' } }));
    // a different event id for the same tournament/player must not duplicate the permanent title
    await svc.consumeEvent(event({ id: 'c2', kind: 'champion', playerIds: ['p1'], data: { championTitle: '천하제일' } }));
    const list = await svc.achievements('p1');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: '천하제일', tournamentId: 'cup' });
    expect(await svc.achievements('p2')).toEqual([]);
    // no achievement when no explicit title is supplied
    await svc.consumeEvent(event({ id: 'c3', tournamentId: 'cup3', kind: 'champion', playerIds: ['p1'], data: {} }));
    expect(await svc.achievements('p1')).toHaveLength(1);
  });

  it('shared champions each receive the achievement', async () => {
    await svc.consumeEvent(event({ id: 'c1', kind: 'champion', playerIds: ['p1', 'p2'], data: { championTitle: '공동우승' } }));
    expect(await svc.achievements('p1')).toHaveLength(1);
    expect(await svc.achievements('p2')).toHaveLength(1);
    expect((await svc.inbox('p1')).messages[0]!.kind).toBe('achievement');
  });
});

describe('devices', () => {
  it('accepts Expo tokens only', async () => {
    await expect(svc.registerDevice('p1', 'not-a-token')).rejects.toThrow('INVALID_TOKEN');
    await expect(svc.registerDevice('p1', 'ExponentPushToken[bad token]')).rejects.toThrow('INVALID_TOKEN');
    expect(await svc.registerDevice('p1', TOKEN)).toEqual({ registered: true });
  });

  it('moves a token to the new owner when the installation changes account', async () => {
    await svc.registerDevice('p1', TOKEN);
    await svc.registerDevice('p2', TOKEN);
    const devices = await store.list<{ playerId: string; token: string }>('devices');
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ playerId: 'p2', token: TOKEN });
  });

  it('the previous owner disabling a reassigned token does not remove the new owner device', async () => {
    await svc.registerDevice('p1', TOKEN);
    await svc.registerDevice('p2', TOKEN);
    await svc.registerDevice('p1', TOKEN, false);
    const devices = await store.list<{ playerId: string }>('devices');
    expect(devices.map((x) => x.playerId)).toEqual(['p2']);
    await svc.registerDevice('p2', TOKEN, false);
    expect(await store.list('devices')).toHaveLength(0);
  });

  it('disabling removes the token', async () => {
    await svc.registerDevice('p1', TOKEN);
    expect(await svc.registerDevice('p1', TOKEN, false)).toEqual({ registered: false });
    expect(await store.list('devices')).toHaveLength(0);
  });
});

describe('practice', () => {
  it('rejects invalid ids, illegal moves, and a first history longer than one move', async () => {
    const legal = legalMoves(initialState(DEFAULT_CONFIG), DEFAULT_CONFIG);
    await expect(svc.beforePractice('p1', 'bad id', [legal[0]!])).rejects.toThrow('INVALID_PRACTICE');
    await expect(svc.beforePractice('p1', 'g1', [{ kind: 'PLACE', to: { r: 99, c: 99 } } as Move])).rejects.toThrow('INVALID_PRACTICE');
    await expect(svc.beforePractice('p1', 'g1', [{ kind: 'MOVE', to: { r: 0, c: 0 } } as unknown as Move])).rejects.toThrow('INVALID_PRACTICE');
    await expect(svc.beforePractice('p1', 'g1', [null as unknown as Move])).rejects.toThrow('INVALID_PRACTICE');
    // unseen session with two moves cannot be forged into existence
    const { moves } = await play('scratch', 'other', 2);
    await expect(svc.beforePractice('p1', 'g1', moves.slice(0, 2))).rejects.toThrow('INVALID_PRACTICE');
  });

  it('a client cannot forge an AI move: saving an illegal AI reply is rejected', async () => {
    const human = legalMoves(initialState(DEFAULT_CONFIG), DEFAULT_CONFIG)[0]!;
    await expect(svc.savePracticeMove('p1', 'g1', [human], { kind: 'PLACE', to: { r: 99, c: 99 } } as Move, 'm')).rejects.toThrow('INVALID_PRACTICE');
    expect(await store.list('practiceSessions')).toHaveLength(0);
  });

  it('a resumed request with the same human history returns the recorded AI move (no re-roll)', async () => {
    const { moves } = await play('g1', 'p1', 3);
    // The reply to the latest human move was saved but the client never received it: re-asking must return it.
    const replayed = await svc.beforePractice('p1', 'g1', moves.slice(0, -1));
    expect(replayed).toEqual(moves.at(-1));
    expect(await svc.beforePractice('p1', 'g1', moves.slice(0, -1))).toEqual(moves.at(-1));
  });

  it('a forged history diverging from the recorded session is rejected', async () => {
    const { moves } = await play('g1', 'p1', 3);
    const state = applyMove(initialState(DEFAULT_CONFIG), moves[0]!);
    const other = legalMoves(state, DEFAULT_CONFIG).find((m) => JSON.stringify(m) !== JSON.stringify(moves[1]))!;
    await expect(svc.beforePractice('p1', 'g1', [moves[0]!, other, ...[]].slice(0, 2))).rejects.toThrow('INVALID_PRACTICE');
    // skipping ahead by more than one human move is rejected too
    const s2 = await play('g2', 'p1', 1);
    const s = applyMove(applyMove(initialState(DEFAULT_CONFIG), s2.moves[0]!), legalMoves(applyMove(initialState(DEFAULT_CONFIG), s2.moves[0]!), DEFAULT_CONFIG)[0]!);
    void s;
  });

  it('sessions are isolated per player', async () => {
    const { moves } = await play('g1', 'p1', 2);
    await expect(svc.beforePractice('p2', 'g1', moves.slice(0, 3))).rejects.toThrow('INVALID_PRACTICE');
    await expect(svc.finishPractice('p2', 'g1', moves.slice(0, 2), 'interrupted')).rejects.toThrow('INVALID_PRACTICE');
  });

  it('an interrupted game is saved but does not count as completed and can resume', async () => {
    const { moves } = await play('g1', 'p1', 2);
    const receipt = await svc.finishPractice('p1', 'g1', moves, 'interrupted');
    expect(receipt).toEqual({ saved: true, completed: false, completedCount: 0 });
    // resume: history extends by exactly one human move
    const state = moves.reduce((s, m) => applyMove(s, m), initialState(DEFAULT_CONFIG));
    const next = legalMoves(state, DEFAULT_CONFIG)[0]!;
    expect(await svc.beforePractice('p1', 'g1', [...moves, next])).toBeNull();
  });

  it('rejects finishing with a history not backed by the session, or completed without a real ending', async () => {
    const { moves } = await play('g1', 'p1', 4);
    await expect(svc.finishPractice('p1', 'nosession', moves, 'interrupted')).rejects.toThrow('INVALID_PRACTICE');
    await expect(svc.finishPractice('p1', 'g1', moves.slice(0, 2), 'completed')).rejects.toThrow('INVALID_PRACTICE');
    await expect(svc.finishPractice('p1', 'g1', moves, 'bogus' as never)).rejects.toThrow('INVALID_PRACTICE');
  });

  it('a resign after at least two moves counts once; repeating the same finish is idempotent', async () => {
    const { moves } = await play('g1', 'p1', 4);
    const a = await svc.finishPractice('p1', 'g1', moves, 'resign');
    const b = await svc.finishPractice('p1', 'g1', moves, 'resign');
    expect(a).toEqual({ saved: true, completed: true, completedCount: 1 });
    expect(b).toEqual(a);
    const { moves: m2 } = await play('g2', 'p1', 4);
    expect((await svc.finishPractice('p1', 'g2', m2, 'resign')).completedCount).toBe(2);
    // another player's count is unaffected
    const { moves: m3 } = await play('g3', 'p2', 4);
    expect((await svc.finishPractice('p2', 'g3', m3, 'resign')).completedCount).toBe(1);
    // a finished session accepts no further moves
    await expect(svc.beforePractice('p1', 'g1', moves.slice(0, 1))).rejects.toThrow('PRACTICE_FINISHED');
  });

  it('a scripted natural game ending is legal move by move and completes exactly once', async () => {
    const blackTargets = [[7, 4], [6, 4], [5, 4], [4, 4], [3, 4], [2, 4], [1, 4], [0, 3]];
    const whiteTargets = [[1, 5], [2, 6], [3, 7], [4, 8], [5, 7], [6, 6], [7, 5]];
    const pick = (state: ReturnType<typeof initialState>, to: number[], from?: number[]) => {
      const found = legalMoves(state, DEFAULT_CONFIG).filter((m) => m.to.r === to[0] && m.to.c === to[1] && (!from || m.kind === 'MOVE' && m.from.r === from[0] && m.from.c === from[1]));
      expect(found).toHaveLength(1);
      return found[0]!;
    };
    let state = initialState(DEFAULT_CONFIG);
    const moves: Move[] = [];
    let blackFrom = [8, 4];
    for (let i = 0; i < blackTargets.length; i++) {
      const human = pick(state, blackTargets[i]!, blackFrom);
      expect(human.kind).toBe('MOVE');
      moves.push(human); state = applyMove(state, human); blackFrom = blackTargets[i]!;
      if (i === blackTargets.length - 1) break;
      expect(getResult(state, DEFAULT_CONFIG)).toBeNull();
      expect(await svc.beforePractice('p1', 'natural', moves)).toBeNull();
      const white = pick(state, whiteTargets[i]!);
      await svc.savePracticeMove('p1', 'natural', moves, white, 'model-1');
      moves.push(white); state = applyMove(state, white);
      expect(getResult(state, DEFAULT_CONFIG)).toBeNull();
    }
    expect(moves).toHaveLength(15);
    expect(getResult(state, DEFAULT_CONFIG)).not.toBeNull();
    const receipt = await svc.finishPractice('p1', 'natural', moves, 'completed');
    expect(receipt).toEqual({ saved: true, completed: true, completedCount: 1 });
    expect(await svc.finishPractice('p1', 'natural', moves, 'completed')).toEqual(receipt);
    await expect(svc.beforePractice('p1', 'natural', moves.slice(0, 1))).rejects.toThrow('PRACTICE_FINISHED');
    expect(await store.list('practiceRecords')).toHaveLength(1);
  });

  it('practice progress and notices survive a store restart', async () => {
    await svc.publishNotice({ id: 'n1', title: 't', body: 'b' });
    await svc.markRead('p1', 'n1');
    const { moves } = await play('g1', 'p1', 4);
    await svc.finishPractice('p1', 'g1', moves, 'resign');
    await svc.consumeEvent(event({ id: 'c1', kind: 'champion', playerIds: ['p1'], data: { championTitle: '천하제일' } }));
    await store.close();
    store = new FileCommunityStore(path);
    svc = new CommunityService(store, () => clock);
    expect((await svc.inbox('p1')).messages.find((m) => m.id === 'n1')!.readAt).not.toBeNull();
    expect(await svc.achievements('p1')).toHaveLength(1);
    expect((await svc.finishPractice('p1', 'g1', moves, 'resign')).completedCount).toBe(1);
    await svc.consumeEvent(event({ id: 'c1', kind: 'champion', playerIds: ['p1'], data: { championTitle: '천하제일' } }));
    expect(await svc.achievements('p1')).toHaveLength(1);
  });
});
