import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MatchInvitation, PlayerPresence } from '../src/net/invitationProtocol';
import { InvitationManager, type InvitationProfile } from './invitations';

interface TestSocket { id: string; playerId: string }
interface SentMessage { socket: TestSocket; message: Record<string, unknown> }

function fixture(options: { ttlMs?: number; now?: () => number } = {}) {
  const profiles = new Map<string, InvitationProfile>([
    ['alice', { playerId: 'alice', name: 'Alice', rating: 1300 }],
    ['bob', { playerId: 'bob', name: 'Bobby', rating: 1400 }],
    ['cara', { playerId: 'cara', name: 'Cara', rating: 1200 }],
    ['dave', { playerId: 'dave', name: 'Dave', rating: 1500 }],
  ]);
  const presence = new Map<string, PlayerPresence>([
    ['alice', 'idle'], ['bob', 'matching'], ['cara', 'idle'], ['dave', 'idle'],
  ]);
  const sockets = new Map<string, TestSocket[]>();
  const selected = new Map<string, TestSocket>();
  const authorized = new Set<TestSocket>();
  const sent: SentMessage[] = [];
  const accept = vi.fn((_invitation: MatchInvitation, _from: TestSocket, _to: TestSocket) => ({ accepted: true as const }));
  const manager = new InvitationManager<TestSocket>({
    getProfile: (id) => profiles.get(id),
    getPresence: (id) => presence.get(id) ?? 'offline',
    getSelectedSocket: (id) => selected.get(id),
    isAuthorizedSocket: (id, socket) => authorized.has(socket) && socket.playerId === id,
    getPlayerSockets: (id) => sockets.get(id) ?? [],
    send: (socket, message) => sent.push({ socket, message: message as Record<string, unknown> }),
    accept,
    ...options,
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
  return { manager, profiles, presence, sockets, selected, authorized, sent, accept, addSocket, messages };
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
});
