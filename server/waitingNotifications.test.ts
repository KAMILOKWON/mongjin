import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileCommunityStore } from './communityStore';
import { parseWaitingDestination, WaitingNotifications, type WaitingUpdate } from './waitingNotifications';

const expo = (suffix = 'abcdefgh') => ({ kind: 'expo' as const, token: `ExponentPushToken[${suffix}]` });
const update = (patch: Partial<WaitingUpdate> = {}): WaitingUpdate => ({
  playerId: 'player_1', tournamentId: 'event_1', title: '대회', queuedAt: 1_000,
  expiresAt: 100_000, state: 'waiting', ...patch,
});
const enabled = { MONGJIN_MATCH_PUSH_ENABLED: '1' };
const jobs = (store: FileCommunityStore) => store.list<{ status: string; attempts: number }>('waitingPushJobs');
async function drain(notifications: WaitingNotifications) {
  for (let i = 0; i < 3; i++) { await notifications.flush(); await new Promise(resolve => setTimeout(resolve, 0)); }
}
afterEach(() => vi.restoreAllMocks());

describe('ordinary tournament match push', () => {
  it('stores a valid owned Expo destination even when delivery is unconfigured', async () => {
    const store = new FileCommunityStore(null), send = vi.fn(async () => undefined);
    const notifications = new WaitingNotifications(store, {}, send, () => 10_000);
    expect(parseWaitingDestination(expo())).toEqual(expo());
    expect(parseWaitingDestination({ kind: 'expo', token: 'bad' })).toBeNull();
    expect(await notifications.register('player_1', 'event_1', expo())).toEqual({ canBackgroundWait: false });
    await expect(notifications.register('player_2', 'event_2', expo())).rejects.toThrow('DESTINATION_OWNED');
    await notifications.update(update({ state: 'matched', matchId: 'match_1' }));
    await drain(notifications);
    expect(send).not.toHaveBeenCalled();
    await notifications.close(); await store.close();
  });
  it('sends a visible Expo push only for a human match, not waiting or ended', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ data: { status: 'ok' } }), { status: 200 }));
    const store = new FileCommunityStore(null), notifications = new WaitingNotifications(store, enabled, undefined, () => 10_000);
    await notifications.register('player_1', 'event_1', expo());
    await notifications.update(update()); await drain(notifications);
    expect(fetchMock).not.toHaveBeenCalled();
    await notifications.update(update({ state: 'matched', matchId: 'match_1' })); await drain(notifications);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ to: expo().token, channelId: 'tournament-match', priority: 'high', sound: 'default',
      title: '대국 상대를 찾았어요', body: '대회로 돌아와 준비해 주세요',
      data: { tournamentId: 'event_1', waitingState: 'matched', matchId: 'match_1' } });
    expect(body).not.toHaveProperty('_contentAvailable');
    await notifications.update(update({ state: 'ended', expiresAt: null })); await drain(notifications);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await notifications.close(); await store.close();
  });
  it('replays a still-valid match alert when token registration finishes after pairing', async () => {
    const store = new FileCommunityStore(null), send = vi.fn(async () => undefined);
    const notifications = new WaitingNotifications(store, enabled, send, () => 10_000);
    await notifications.update(update({ state: 'matched', matchId: 'match_2' }));
    await notifications.register('player_1', 'event_1', expo()); await drain(notifications);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expo(), expect.objectContaining({ state: 'matched', matchId: 'match_2' }));
    await notifications.close(); await store.close();
  });
  it('drops obsolete match jobs after a newer lifecycle state', async () => {
    const store = new FileCommunityStore(null), env: Record<string, string | undefined> = {}, send = vi.fn(async () => undefined);
    const notifications = new WaitingNotifications(store, env, send, () => 10_000);
    await notifications.register('player_1', 'event_1', expo());
    await notifications.update(update({ state: 'matched', matchId: 'match_1' }));
    await notifications.update(update({ state: 'ended', expiresAt: null }));
    Object.assign(env, enabled); await drain(notifications);
    expect(send).not.toHaveBeenCalled();
    expect((await jobs(store)).map(job => job.status)).toEqual(['skipped', 'skipped']);
    await notifications.close(); await store.close();
  });
  it('records provider rejection as a retry, never a delivery claim', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ data: { status: 'error' } }), { status: 200 }));
    const store = new FileCommunityStore(null), notifications = new WaitingNotifications(store, enabled, undefined, () => 10_000);
    await notifications.register('player_1', 'event_1', expo());
    await notifications.update(update({ state: 'matched', matchId: 'match_1' })); await drain(notifications);
    expect(await jobs(store)).toMatchObject([{ status: 'pending', attempts: 1 }]);
    await notifications.close(); await store.close();
  });
});
