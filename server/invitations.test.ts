import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MatchInvitation, PlayerPresence } from '../src/net/invitationProtocol';
import {
  InvitationManager,
  type InvitationAcceptResult,
  type InvitationProfile,
} from './invitations';

interface TestSocket { id: string; playerId: string }
interface SentMessage { socket: TestSocket; message: Record<string, unknown> }

function fixture(options: { ttlMs?: number; now?: () => number; automaticDelayMs?: number } = {}) {
  const profiles = new Map<string, InvitationProfile>([
    ['alice', { playerId: 'alice', name: 'Alice', rating: 1300 }],
    ['bob', { playerId: 'bob', name: 'Bobby', rating: 1400 }],
    ['cara', { playerId: 'cara', name: 'Cara', rating: 1200 }],
    ['dave', { playerId: 'dave', name: 'Dave', rating: 1500 }],
    ['bot', { playerId: 'bot', name: 'Bot', rating: 1350 }],
  ]);
  const presence = new Map<string, PlayerPresence>([
    ['alice', 'idle'], ['bob', 'matching'], ['cara', 'idle'], ['dave', 'idle'], ['bot', 'idle'],
  ]);
  const automaticDelays = new Map<string, number>();
  if (options.automaticDelayMs !== undefined) automaticDelays.set('bot', options.automaticDelayMs);
  const sockets = new Map<string, TestSocket[]>();
  const selected = new Map<string, TestSocket>();
  const authorized = new Set<TestSocket>();
  const sent: SentMessage[] = [];
  const accept = vi.fn((_invitation: MatchInvitation, _from: TestSocket, _to: TestSocket) => ({ accepted: true as const }));
  const acceptAutomatic = vi.fn((_invitation: MatchInvitation, _from: TestSocket): InvitationAcceptResult => ({ accepted: true }));
  const manager = new InvitationManager<TestSocket>({
    getProfile: (id) => profiles.get(id),
    getPresence: (id) => presence.get(id) ?? 'offline',
    getSelectedSocket: (id) => selected.get(id),
    isAuthorizedSocket: (id, socket) => authorized.has(socket) && socket.playerId === id,
    getPlayerSockets: (id) => sockets.get(id) ?? [],
    send: (socket, message) => sent.push({ socket, message: message as Record<string, unknown> }),
    accept,
    getAutomaticAcceptDelayMs: (id) => automaticDelays.get(id),
    acceptAutomatic,
    ...(options.now ? { now: options.now } : {}),
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
    createId: (() => { let id = 0; return () => `invite-${++id}`; })(),
  });
  const addSocket = (id: string, playerId: string, isSelected = true): TestSocket => {
    const socket = { id, playerId };
    const playerSockets = sockets.get(playerId) ?? [];
    playerSockets.push(socket);
    sockets.set(playerId, playerSockets);
    authorized.add(socket);
    if (isSelected) selected.set(playerId, socket);
    return socket;
  };
  const messages = (socket: TestSocket, type?: string) => sent
    .filter((entry) => entry.socket === socket && (!type || entry.message.type === type))
    .map((entry) => entry.message);
  return {
    manager, profiles, presence, sockets, selected, authorized, automaticDelays,
    sent, accept, acceptAutomatic, addSocket, messages,
  };
}

afterEach(() => vi.useRealTimers());

describe('profile invitations', () => {
  it('lets a hidden player send and accept an outgoing invitation while refusing hidden recipients', () => {
    const f = fixture();
    const alice = f.addSocket('alice-1', 'alice');
    const bob = f.addSocket('bob-1', 'bob');
    f.profiles.get('alice')!.showOnline = false;

    f.manager.handleMessage(alice, 'alice', { type: 'SEND_INVITATION', playerId: 'bob' });
    const invitation = f.messages(bob, 'INVITATION')[0]!.invitation as MatchInvitation;
    expect(invitation.from.playerId).toBe('alice');
    expect(f.messages(alice, 'INVITATION')[0]).toMatchObject({ direction: 'outgoing' });
    f.manager.handleMessage(bob, 'bob', { type: 'RESPOND_INVITATION', invitationId: invitation.id, accept: true });
    expect(f.accept).toHaveBeenCalledTimes(1);
    expect(f.messages(alice, 'INVITATION_CLOSED')).toContainEqual({
      type: 'INVITATION_CLOSED', invitationId: invitation.id, reason: 'accepted',
    });

    f.manager.handleMessage(bob, 'bob', { type: 'SEND_INVITATION', playerId: 'alice' });
    expect(f.messages(bob, 'INVITATION_ERROR').at(-1)).toMatchObject({ code: 'UNAVAILABLE' });
    expect(f.messages(alice, 'INVITATION').filter((message) => (message.invitation as MatchInvitation).from.playerId === 'bob')).toHaveLength(0);
  });

  it('binds acceptance to the selected recipient socket and closes exactly once on duplicate responses', () => {
    const f = fixture();
    const alice = f.addSocket('alice-1', 'alice');
    const bobOld = f.addSocket('bob-old', 'bob');
    const bobCurrent = f.addSocket('bob-current', 'bob');
    f.selected.set('bob', bobCurrent);

    f.manager.handleMessage(alice, 'alice', { type: 'SEND_INVITATION', playerId: 'bob' });
    const invitation = f.messages(bobCurrent, 'INVITATION')[0]!.invitation as MatchInvitation;
    expect(f.messages(bobOld, 'INVITATION')).toHaveLength(0);

    f.manager.handleMessage(bobOld, 'bob', { type: 'RESPOND_INVITATION', invitationId: invitation.id, accept: true });
    expect(f.messages(bobOld, 'INVITATION_ERROR').at(-1)).toMatchObject({ code: 'INVALID_REQUEST' });
    f.manager.handleMessage(bobCurrent, 'bob', { type: 'RESPOND_INVITATION', invitationId: invitation.id, accept: true });
    f.manager.handleMessage(bobCurrent, 'bob', { type: 'RESPOND_INVITATION', invitationId: invitation.id, accept: true });

    expect(f.accept).toHaveBeenCalledTimes(1);
    expect(f.messages(alice, 'INVITATION_CLOSED').filter((message) => message.invitationId === invitation.id)).toEqual([
      { type: 'INVITATION_CLOSED', invitationId: invitation.id, reason: 'accepted' },
    ]);
    expect(f.messages(bobOld, 'INVITATION_CLOSED')).toHaveLength(1);
  });

  it('validates message shapes, rejects account spoofing, enforces one pending invite per player, and expires once', async () => {
    vi.useFakeTimers();
    let now = 10_000;
    const f = fixture({ ttlMs: 30, now: () => now });
    const alice = f.addSocket('alice-1', 'alice');
    const bob = f.addSocket('bob-1', 'bob');
    const cara = f.addSocket('cara-1', 'cara');
    f.addSocket('dave-1', 'dave');

    f.manager.handleMessage(alice, 'alice', { type: 'SEND_INVITATION', playerId: { id: 'bob' } });
    expect(f.messages(alice, 'INVITATION_ERROR').at(-1)).toMatchObject({ code: 'INVALID_REQUEST' });
    f.manager.handleMessage(bob, 'alice', { type: 'SEND_INVITATION', playerId: 'cara' });
    expect(f.messages(bob, 'INVITATION_ERROR').at(-1)).toMatchObject({ code: 'INVALID_REQUEST' });

    f.manager.handleMessage(alice, 'alice', { type: 'SEND_INVITATION', playerId: 'bob' });
    const invitation = f.messages(bob, 'INVITATION')[0]!.invitation as MatchInvitation;
    f.manager.handleMessage(cara, 'cara', { type: 'SEND_INVITATION', playerId: 'bob' });
    expect(f.messages(cara, 'INVITATION_ERROR').at(-1)).toMatchObject({ code: 'PENDING' });
    f.manager.handleMessage(bob, 'bob', { type: 'RESPOND_INVITATION', invitationId: invitation.id, accept: 'yes' });
    expect(f.messages(bob, 'INVITATION_ERROR').at(-1)).toMatchObject({ code: 'INVALID_REQUEST' });

    now += 30;
    await vi.advanceTimersByTimeAsync(30);
    expect(f.manager.size).toBe(0);
    expect(f.messages(alice, 'INVITATION_CLOSED')).toEqual([
      { type: 'INVITATION_CLOSED', invitationId: invitation.id, reason: 'expired' },
    ]);
    f.manager.handleMessage(bob, 'bob', { type: 'RESPOND_INVITATION', invitationId: invitation.id, accept: true });
    expect(f.messages(alice, 'INVITATION_CLOSED')).toHaveLength(1);
    expect(f.messages(bob, 'INVITATION_ERROR').at(-1)).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('only tells the two reserved sockets to wait for an accepted match', () => {
    const f = fixture();
    const alice = f.addSocket('alice-match', 'alice');
    const otherAlice = f.addSocket('alice-other', 'alice', false);
    const otherBob = f.addSocket('bob-other', 'bob');
    const bob = f.addSocket('bob-match', 'bob');
    f.manager.handleMessage(alice, 'alice', { type: 'SEND_INVITATION', playerId: 'bob' });
    const invitation = f.messages(bob, 'INVITATION')[0]!.invitation as MatchInvitation;

    f.manager.handleMessage(bob, 'bob', { type: 'RESPOND_INVITATION', invitationId: invitation.id, accept: true });
    expect(f.accept).toHaveBeenCalledExactlyOnceWith(invitation, alice, bob);
    for (const socket of [alice, bob]) {
      expect(f.messages(socket, 'INVITATION_CLOSED')).toEqual([
        { type: 'INVITATION_CLOSED', invitationId: invitation.id, reason: 'accepted' },
      ]);
    }
    for (const socket of [otherAlice, otherBob]) {
      expect(f.messages(socket, 'INVITATION_CLOSED')).toEqual([
        { type: 'INVITATION_CLOSED', invitationId: invitation.id, reason: 'unavailable' },
      ]);
    }
  });

  it('keeps a hidden sender unavailable to third parties while its outgoing invite is pending', () => {
    const f = fixture();
    const alice = f.addSocket('alice-1', 'alice');
    const bob = f.addSocket('bob-1', 'bob');
    const cara = f.addSocket('cara-1', 'cara');
    f.profiles.get('alice')!.showOnline = false;
    f.manager.handleMessage(alice, 'alice', { type: 'SEND_INVITATION', playerId: 'bob' });
    const invitation = f.messages(bob, 'INVITATION')[0]!.invitation as MatchInvitation;

    f.manager.handleMessage(cara, 'cara', { type: 'SEND_INVITATION', playerId: 'alice' });
    expect(f.messages(cara, 'INVITATION_ERROR').at(-1)).toMatchObject({ code: 'UNAVAILABLE' });
    expect(f.manager.size).toBe(1);
    f.manager.handleMessage(bob, 'bob', { type: 'RESPOND_INVITATION', invitationId: invitation.id, accept: true });
    expect(f.accept).toHaveBeenCalledTimes(1);
  });

  it('invalidates a pending invitation if the selected recipient socket changes', () => {
    const f = fixture();
    const alice = f.addSocket('alice-1', 'alice');
    const bob = f.addSocket('bob-1', 'bob');
    const otherBob = f.addSocket('bob-2', 'bob', false);
    f.manager.handleMessage(alice, 'alice', { type: 'SEND_INVITATION', playerId: 'bob' });
    const invitation = f.messages(bob, 'INVITATION')[0]!.invitation as MatchInvitation;

    f.selected.set('bob', otherBob);
    f.manager.revalidateAll();
    expect(f.manager.size).toBe(0);
    expect(f.messages(alice, 'INVITATION_CLOSED')).toContainEqual({
      type: 'INVITATION_CLOSED', invitationId: invitation.id, reason: 'unavailable',
    });
  });

  it('closes safely if the synchronous match reservation callback throws', () => {
    const f = fixture();
    const alice = f.addSocket('alice-1', 'alice');
    const bob = f.addSocket('bob-1', 'bob');
    f.accept.mockImplementation(() => { throw new Error('reservation failed'); });
    f.manager.handleMessage(alice, 'alice', { type: 'SEND_INVITATION', playerId: 'bob' });
    const invitation = f.messages(bob, 'INVITATION')[0]!.invitation as MatchInvitation;

    f.manager.handleMessage(bob, 'bob', { type: 'RESPOND_INVITATION', invitationId: invitation.id, accept: true });
    expect(f.manager.size).toBe(0);
    expect(f.messages(bob, 'INVITATION_ERROR').at(-1)).toMatchObject({ code: 'UNAVAILABLE' });
    expect(f.messages(alice, 'INVITATION_CLOSED')).toContainEqual({
      type: 'INVITATION_CLOSED', invitationId: invitation.id, reason: 'unavailable',
    });
  });

  it.each([2_000, 5_000])('accepts a socketless automatic recipient after %i ms', async (delayMs) => {
    vi.useFakeTimers();
    const f = fixture({ automaticDelayMs: delayMs });
    const aliceOld = f.addSocket('alice-old', 'alice', false);
    const aliceCurrent = f.addSocket('alice-current', 'alice');

    f.manager.handleMessage(aliceOld, 'alice', { type: 'SEND_INVITATION', playerId: 'bot' });
    const invitation = f.messages(aliceOld, 'INVITATION')[0]!.invitation as MatchInvitation;
    expect(f.messages(aliceOld, 'INVITATION')[0]).toMatchObject({ direction: 'outgoing' });
    expect(f.messages(aliceCurrent, 'INVITATION')[0]).toMatchObject({ direction: 'outgoing' });
    expect(f.manager.hasPending('alice')).toBe(true);
    expect(f.manager.hasPending('bot')).toBe(true);
    expect(f.acceptAutomatic).not.toHaveBeenCalled();
    expect(f.accept).not.toHaveBeenCalled();

    // The original authorized sender socket remains the invitation owner even after selection changes.
    f.selected.set('alice', aliceCurrent);
    await vi.advanceTimersByTimeAsync(delayMs - 1);
    expect(f.acceptAutomatic).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(f.acceptAutomatic).toHaveBeenCalledTimes(1);
    expect(f.acceptAutomatic).toHaveBeenCalledWith(invitation, aliceOld);
    expect(f.accept).not.toHaveBeenCalled();
    expect(f.manager.size).toBe(0);
    expect(f.manager.hasPending('alice')).toBe(false);
    expect(f.manager.hasPending('bot')).toBe(false);
    expect(f.messages(aliceOld, 'INVITATION_CLOSED')).toContainEqual({
      type: 'INVITATION_CLOSED', invitationId: invitation.id, reason: 'accepted',
    });
  });

  it('clears both automatic timers and player indexes when the sender cancels', async () => {
    vi.useFakeTimers();
    const f = fixture({ automaticDelayMs: 2_000 });
    const alice = f.addSocket('alice-1', 'alice');
    f.manager.handleMessage(alice, 'alice', { type: 'SEND_INVITATION', playerId: 'bot' });
    const invitation = f.messages(alice, 'INVITATION')[0]!.invitation as MatchInvitation;

    f.manager.handleMessage(alice, 'alice', { type: 'CANCEL_INVITATION', invitationId: invitation.id });
    expect(f.manager.hasPending('alice')).toBe(false);
    expect(f.manager.hasPending('bot')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.acceptAutomatic).not.toHaveBeenCalled();
  });

  it('revalidates sender authorization, presence, target privacy, presence, and automatic eligibility before accepting', async () => {
    vi.useFakeTimers();
    const cases: Array<{
      label: string;
      code: 'BUSY' | 'UNAVAILABLE';
      change(f: ReturnType<typeof fixture>, alice: TestSocket): void;
    }> = [
      { label: 'sender becomes unauthorized', code: 'UNAVAILABLE', change: (f, alice) => { f.authorized.delete(alice); } },
      { label: 'sender enters a match', code: 'BUSY', change: (f) => { f.presence.set('alice', 'playing'); } },
      { label: 'sender goes offline', code: 'UNAVAILABLE', change: (f) => { f.presence.set('alice', 'offline'); } },
      { label: 'recipient enters a match', code: 'BUSY', change: (f) => { f.presence.set('bot', 'playing'); } },
      { label: 'recipient goes offline', code: 'UNAVAILABLE', change: (f) => { f.presence.set('bot', 'offline'); } },
      { label: 'recipient hides its profile', code: 'UNAVAILABLE', change: (f) => { f.profiles.get('bot')!.showOnline = false; } },
      { label: 'recipient stops being automatic', code: 'UNAVAILABLE', change: (f) => { f.automaticDelays.delete('bot'); } },
    ];

    for (const testCase of cases) {
      const f = fixture({ automaticDelayMs: 2_000 });
      const alice = f.addSocket(`alice-${testCase.label}`, 'alice');
      f.manager.handleMessage(alice, 'alice', { type: 'SEND_INVITATION', playerId: 'bot' });
      const invitation = f.messages(alice, 'INVITATION')[0]!.invitation as MatchInvitation;
      testCase.change(f, alice);
      await vi.advanceTimersByTimeAsync(2_000);

      expect(f.acceptAutomatic, testCase.label).not.toHaveBeenCalled();
      expect(f.manager.hasPending('alice'), testCase.label).toBe(false);
      expect(f.manager.hasPending('bot'), testCase.label).toBe(false);
      expect(f.messages(alice, 'INVITATION_ERROR').at(-1), testCase.label).toMatchObject({
        code: testCase.code, invitationId: invitation.id,
      });
    }
  });

  it('does not invoke automatic acceptance after sender disconnect or a new match invalidates the invite', async () => {
    vi.useFakeTimers();
    const disconnected = fixture({ automaticDelayMs: 2_000 });
    const disconnectedAlice = disconnected.addSocket('alice-disconnect', 'alice');
    disconnected.manager.handleMessage(disconnectedAlice, 'alice', { type: 'SEND_INVITATION', playerId: 'bot' });
    disconnected.manager.invalidateSocket(disconnectedAlice);
    expect(disconnected.manager.hasPending('alice')).toBe(false);
    expect(disconnected.manager.hasPending('bot')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(disconnected.acceptAutomatic).not.toHaveBeenCalled();

    const newMatch = fixture({ automaticDelayMs: 2_000 });
    const alice = newMatch.addSocket('alice-new-match', 'alice');
    newMatch.manager.handleMessage(alice, 'alice', { type: 'SEND_INVITATION', playerId: 'bot' });
    const invitation = newMatch.messages(alice, 'INVITATION')[0]!.invitation as MatchInvitation;
    newMatch.presence.set('alice', 'playing');
    newMatch.manager.revalidateAll();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(newMatch.acceptAutomatic).not.toHaveBeenCalled();
    expect(newMatch.messages(alice, 'INVITATION_ERROR').at(-1)).toMatchObject({
      code: 'BUSY', invitationId: invitation.id,
    });
  });

  it('expires automatic invitations before their delay and clears both timers on shutdown', async () => {
    vi.useFakeTimers();
    const expired = fixture({ ttlMs: 1_000, automaticDelayMs: 2_000 });
    const alice = expired.addSocket('alice-expired', 'alice');
    expired.manager.handleMessage(alice, 'alice', { type: 'SEND_INVITATION', playerId: 'bot' });
    const expiredInvitation = expired.messages(alice, 'INVITATION')[0]!.invitation as MatchInvitation;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(expired.acceptAutomatic).not.toHaveBeenCalled();
    expect(expired.manager.hasPending('alice')).toBe(false);
    expect(expired.manager.hasPending('bot')).toBe(false);
    expect(expired.messages(alice, 'INVITATION_CLOSED')).toContainEqual({
      type: 'INVITATION_CLOSED', invitationId: expiredInvitation.id, reason: 'expired',
    });
    expect(vi.getTimerCount()).toBe(0);

    const shutdown = fixture({ automaticDelayMs: 2_000 });
    const shutdownAlice = shutdown.addSocket('alice-shutdown', 'alice');
    shutdown.manager.handleMessage(shutdownAlice, 'alice', { type: 'SEND_INVITATION', playerId: 'bot' });
    shutdown.manager.closeAll();
    expect(shutdown.manager.hasPending('alice')).toBe(false);
    expect(shutdown.manager.hasPending('bot')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(shutdown.acceptAutomatic).not.toHaveBeenCalled();
  });

  it('rejects a competing invitation and a busy automatic target', () => {
    const f = fixture({ automaticDelayMs: 2_000 });
    const alice = f.addSocket('alice-competitive', 'alice');
    const cara = f.addSocket('cara-competitive', 'cara');
    f.manager.handleMessage(alice, 'alice', { type: 'SEND_INVITATION', playerId: 'bot' });
    f.manager.handleMessage(cara, 'cara', { type: 'SEND_INVITATION', playerId: 'bot' });
    expect(f.messages(cara, 'INVITATION_ERROR').at(-1)).toMatchObject({ code: 'PENDING' });
    expect(f.messages(cara, 'INVITATION')).toHaveLength(0);
    expect(f.manager.size).toBe(1);
    expect(f.manager.hasPending('bot')).toBe(true);

    const busy = fixture({ automaticDelayMs: 2_000 });
    const busyAlice = busy.addSocket('alice-busy-target', 'alice');
    busy.presence.set('bot', 'playing');
    busy.manager.handleMessage(busyAlice, 'alice', { type: 'SEND_INVITATION', playerId: 'bot' });
    expect(busy.messages(busyAlice, 'INVITATION_ERROR').at(-1)).toMatchObject({ code: 'BUSY' });
    expect(busy.manager.hasPending('bot')).toBe(false);
    expect(busy.acceptAutomatic).not.toHaveBeenCalled();
    f.manager.closeAll();
  });

  it('does not let a client forge the response for an automatic recipient', () => {
    const f = fixture({ automaticDelayMs: 2_000 });
    const alice = f.addSocket('alice-forged', 'alice');
    const bob = f.addSocket('bob-forged', 'bob');
    f.manager.handleMessage(alice, 'alice', { type: 'SEND_INVITATION', playerId: 'bot' });
    const invitation = f.messages(alice, 'INVITATION')[0]!.invitation as MatchInvitation;

    f.manager.handleMessage(bob, 'bot', {
      type: 'RESPOND_INVITATION', invitationId: invitation.id, accept: true,
    });
    f.manager.handleMessage(alice, 'alice', {
      type: 'RESPOND_INVITATION', invitationId: invitation.id, accept: true,
    });
    expect(f.messages(bob, 'INVITATION_ERROR').at(-1)).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(f.messages(alice, 'INVITATION_ERROR').at(-1)).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(f.acceptAutomatic).not.toHaveBeenCalled();
    expect(f.accept).not.toHaveBeenCalled();

    f.manager.handleMessage(alice, 'alice', { type: 'CANCEL_INVITATION', invitationId: invitation.id });
  });

  it('reports automatic reservation failures to the caller and closes the invitation once', async () => {
    vi.useFakeTimers();
    for (const result of [
      { accepted: false as const, code: 'BUSY' as const },
      'throw' as const,
    ]) {
      const f = fixture({ automaticDelayMs: 2_000 });
      const alice = f.addSocket(`alice-failure-${String(result)}`, 'alice');
      if (result === 'throw') f.acceptAutomatic.mockImplementation(() => { throw new Error('reservation failed'); });
      else f.acceptAutomatic.mockImplementation(() => result);
      f.manager.handleMessage(alice, 'alice', { type: 'SEND_INVITATION', playerId: 'bot' });
      const invitation = f.messages(alice, 'INVITATION')[0]!.invitation as MatchInvitation;
      await vi.advanceTimersByTimeAsync(2_000);

      expect(f.acceptAutomatic).toHaveBeenCalledTimes(1);
      expect(f.manager.size).toBe(0);
      expect(f.manager.hasPending('alice')).toBe(false);
      expect(f.manager.hasPending('bot')).toBe(false);
      expect(f.messages(alice, 'INVITATION_ERROR').at(-1)).toMatchObject({
        code: result === 'throw' ? 'UNAVAILABLE' : 'BUSY', invitationId: invitation.id,
      });
      expect(f.messages(alice, 'INVITATION_CLOSED').filter((message) => message.invitationId === invitation.id)).toHaveLength(1);
    }
  });

  it('keeps human recipients on the authenticated selected-socket path', () => {
    const f = fixture();
    const alice = f.addSocket('alice-human', 'alice');
    const bob = f.addSocket('bob-noauth', 'bob');
    f.authorized.delete(bob);

    f.manager.handleMessage(alice, 'alice', { type: 'SEND_INVITATION', playerId: 'bob' });
    expect(f.messages(alice, 'INVITATION_ERROR').at(-1)).toMatchObject({ code: 'UNAVAILABLE' });
    expect(f.manager.hasPending('alice')).toBe(false);
    expect(f.acceptAutomatic).not.toHaveBeenCalled();
    expect(f.accept).not.toHaveBeenCalled();
  });

  it('uses the selected authenticated socket if an automatic profile has a websocket', () => {
    const f = fixture({ automaticDelayMs: 2_000 });
    const alice = f.addSocket('alice-bot-human', 'alice');
    const botSocket = f.addSocket('bot-connected', 'bot');

    f.manager.handleMessage(alice, 'alice', { type: 'SEND_INVITATION', playerId: 'bot' });
    const invitation = f.messages(botSocket, 'INVITATION')[0]!.invitation as MatchInvitation;
    expect(f.messages(botSocket, 'INVITATION')[0]).toMatchObject({ direction: 'incoming' });
    expect(f.acceptAutomatic).not.toHaveBeenCalled();

    f.manager.handleMessage(botSocket, 'bot', {
      type: 'RESPOND_INVITATION', invitationId: invitation.id, accept: true,
    });
    expect(f.accept).toHaveBeenCalledTimes(1);
    expect(f.acceptAutomatic).not.toHaveBeenCalled();
  });

  it('does not enable automatic acceptance for delays outside two to five seconds', () => {
    const f = fixture({ automaticDelayMs: 1_999 });
    const alice = f.addSocket('alice-invalid-delay', 'alice');

    f.manager.handleMessage(alice, 'alice', { type: 'SEND_INVITATION', playerId: 'bot' });

    expect(f.messages(alice, 'INVITATION_ERROR').at(-1)).toMatchObject({ code: 'UNAVAILABLE' });
    expect(f.manager.hasPending('alice')).toBe(false);
    expect(f.manager.hasPending('bot')).toBe(false);
    expect(f.acceptAutomatic).not.toHaveBeenCalled();
  });
});
