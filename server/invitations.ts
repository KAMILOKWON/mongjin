import { randomBytes } from 'node:crypto';
import {
  INVITATION_TTL_MS,
  canInvitePresence,
  type InvitationCloseReason,
  type InvitationErrorCode,
  type InvitationPlayer,
  type MatchInvitation,
  type PlayerPresence,
} from '../src/net/invitationProtocol';

export interface InvitationProfile {
  playerId: string;
  name: string;
  rating: number;
  showOnline?: boolean;
}

export type InvitationAcceptResult =
  | { accepted: true }
  | { accepted: false; code: 'BUSY' | 'UNAVAILABLE' };

export interface InvitationManagerOptions<Socket extends object> {
  getProfile(playerId: string): InvitationProfile | undefined;
  getPresence(playerId: string): PlayerPresence;
  getSelectedSocket(playerId: string): Socket | undefined;
  isAuthorizedSocket(playerId: string, socket: Socket): boolean;
  getPlayerSockets(playerId: string): Socket[];
  send(socket: Socket, message: unknown): void;
  accept(invitation: MatchInvitation, fromSocket: Socket, toSocket: Socket): InvitationAcceptResult;
  getAutomaticAcceptDelayMs?(playerId: string): number | undefined;
  acceptAutomatic?(invitation: MatchInvitation, fromSocket: Socket): InvitationAcceptResult;
  now?: () => number;
  createId?: () => string;
  ttlMs?: number;
}

const MIN_AUTOMATIC_ACCEPT_DELAY_MS = 2_000;
const MAX_AUTOMATIC_ACCEPT_DELAY_MS = 5_000;

interface PendingInvitation<Socket extends object> {
  invitation: MatchInvitation;
  fromSocket: Socket;
  toSocket?: Socket;
  automatic: boolean;
  automaticAttempted?: boolean;
  automaticTimer?: ReturnType<typeof setTimeout>;
  timer: ReturnType<typeof setTimeout>;
}

export class InvitationManager<Socket extends object> {
  private readonly pending = new Map<string, PendingInvitation<Socket>>();
  private readonly pendingByPlayer = new Map<string, string>();
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly ttlMs: number;

  constructor(private readonly options: InvitationManagerOptions<Socket>) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => randomBytes(12).toString('hex'));
    this.ttlMs = options.ttlMs ?? INVITATION_TTL_MS;
  }

  handleMessage(socket: Socket, actorId: string, message: unknown): void {
    if (!this.options.isAuthorizedSocket(actorId, socket) || !this.isRecord(message)) {
      this.error(socket, 'INVALID_REQUEST');
      return;
    }
    if (message.type === 'SEND_INVITATION') {
      if (typeof message.playerId !== 'string' || !this.validIdentifier(message.playerId)) {
        this.error(socket, 'INVALID_REQUEST');
        return;
      }
      this.sendInvitation(socket, actorId, message.playerId);
      return;
    }
    if (message.type === 'RESPOND_INVITATION') {
      if (!this.validIdentifier(message.invitationId) || typeof message.accept !== 'boolean') {
        this.error(socket, 'INVALID_REQUEST');
        return;
      }
      this.respond(socket, actorId, message.invitationId, message.accept);
      return;
    }
    if (message.type === 'CANCEL_INVITATION') {
      if (!this.validIdentifier(message.invitationId)) {
        this.error(socket, 'INVALID_REQUEST');
        return;
      }
      this.cancel(socket, actorId, message.invitationId);
      return;
    }
    this.error(socket, 'INVALID_REQUEST');
  }

  /** Close invitations when a participant loses its foreground or changes account. */
  invalidatePlayer(playerId: string, reason: InvitationCloseReason = 'unavailable'): void {
    const invitationIds = new Set<string>();
    const id = this.pendingByPlayer.get(playerId);
    if (id) invitationIds.add(id);
    for (const [invitationId, pending] of this.pending) {
      if (pending.invitation.from.playerId === playerId || pending.invitation.to.playerId === playerId) {
        invitationIds.add(invitationId);
      }
    }
    for (const invitationId of invitationIds) this.close(invitationId, reason);
  }

  /** Hiding a profile makes it unavailable as a recipient but still permits outgoing invites. */
  invalidateIncoming(playerId: string, reason: InvitationCloseReason = 'unavailable'): void {
    for (const [id, pending] of this.pending) {
      if (pending.invitation.to.playerId === playerId) this.close(id, reason);
    }
  }

  invalidateSocket(socket: Socket, reason: InvitationCloseReason = 'unavailable'): void {
    for (const [id, pending] of this.pending) {
      if (pending.fromSocket === socket || pending.toSocket === socket) this.close(id, reason);
    }
  }

  /** Recheck live account, privacy, presence, and selected-socket state after server transitions. */
  revalidateAll(): void {
    for (const [id, pending] of this.pending) {
      if (pending.automatic) {
        const failure = this.automaticAcceptFailure(pending);
        if (failure) {
          this.close(id, failure === 'NOT_FOUND' ? 'expired' : 'unavailable', failure);
        }
        continue;
      }
      const { invitation, fromSocket, toSocket } = pending;
      const fromId = invitation.from.playerId;
      const toId = invitation.to.playerId;
      const fromProfile = this.options.getProfile(fromId);
      const toProfile = this.options.getProfile(toId);
      const fromPresence = this.options.getPresence(fromId);
      const toPresence = this.options.getPresence(toId);
      if (
        !fromProfile || !toProfile ||
        !toSocket ||
        !this.options.isAuthorizedSocket(fromId, fromSocket) ||
        !this.options.isAuthorizedSocket(toId, toSocket) ||
        toProfile.showOnline === false ||
        this.options.getSelectedSocket(toId) !== toSocket ||
        fromPresence === 'offline' || fromPresence === 'playing' ||
        !canInvitePresence(toPresence)
      ) this.close(id, 'unavailable');
    }
  }

  closeAll(reason: InvitationCloseReason = 'unavailable'): void {
    for (const id of [...this.pending.keys()]) this.close(id, reason);
  }

  get size(): number {
    return this.pending.size;
  }

  hasPending(playerId: string): boolean {
    return this.pendingByPlayer.has(playerId);
  }

  private sendInvitation(socket: Socket, fromId: string, toId: string): void {
    if (fromId === toId) return this.error(socket, 'SELF_INVITE');
    const fromProfile = this.options.getProfile(fromId);
    const toProfile = this.options.getProfile(toId);
    if (!fromProfile || !toProfile) return this.error(socket, 'UNAVAILABLE');
    if (toProfile.showOnline === false) return this.error(socket, 'UNAVAILABLE');
    if (this.pendingByPlayer.has(fromId) || this.pendingByPlayer.has(toId)) {
      return this.error(socket, 'PENDING');
    }
    const fromPresence = this.options.getPresence(fromId);
    if (fromPresence === 'playing') return this.error(socket, 'BUSY');
    if (fromPresence === 'offline' || !this.options.isAuthorizedSocket(fromId, socket)) {
      return this.error(socket, 'UNAVAILABLE');
    }
    const toPresence = this.options.getPresence(toId);
    if (toPresence === 'playing') return this.error(socket, 'BUSY');
    if (!canInvitePresence(toPresence)) return this.error(socket, 'UNAVAILABLE');

    const automaticDelayMs = this.automaticAcceptDelayMs(toId);
    const automatic = automaticDelayMs !== undefined && this.hasNoRecipientSocket(toId);
    const toSocket = automatic ? undefined : this.options.getSelectedSocket(toId);
    if (!automatic && (!toSocket || !this.options.isAuthorizedSocket(toId, toSocket))) {
      return this.error(socket, 'UNAVAILABLE');
    }

    const invitation: MatchInvitation = {
      id: this.createId(),
      from: this.publicPlayer(fromProfile),
      to: this.publicPlayer(toProfile),
      expiresAt: this.now() + this.ttlMs,
    };
    const timer = setTimeout(() => this.close(invitation.id, 'expired'), this.ttlMs);
    timer.unref?.();
    const pending: PendingInvitation<Socket> = { invitation, fromSocket: socket, toSocket, automatic, timer };
    this.pending.set(invitation.id, pending);
    this.pendingByPlayer.set(fromId, invitation.id);
    this.pendingByPlayer.set(toId, invitation.id);
    if (automatic) {
      this.sendToPlayer(fromId, { type: 'INVITATION', invitation, direction: 'outgoing' });
      if (this.pending.get(invitation.id) !== pending) return;
      const automaticTimer = setTimeout(
        () => this.acceptAutomatically(invitation.id),
        automaticDelayMs!,
      );
      automaticTimer.unref?.();
      pending.automaticTimer = automaticTimer;
      return;
    }
    this.options.send(toSocket!, { type: 'INVITATION', invitation, direction: 'incoming' });
    this.sendToPlayer(fromId, { type: 'INVITATION', invitation, direction: 'outgoing' });
  }

  private respond(socket: Socket, actorId: string, invitationId: string, accept: boolean): void {
    const pending = this.pending.get(invitationId);
    if (!pending) return this.error(socket, 'NOT_FOUND', invitationId);
    const { invitation, fromSocket } = pending;
    if (this.now() >= invitation.expiresAt) {
      this.close(invitationId, 'expired');
      this.error(socket, 'NOT_FOUND', invitationId);
      return;
    }
    const toSocket = pending.toSocket;
    if (pending.automatic || !toSocket || actorId !== invitation.to.playerId || socket !== toSocket) {
      this.error(socket, 'INVALID_REQUEST', invitationId);
      return;
    }
    if (!this.canStillAccept(pending)) {
      this.close(invitationId, 'unavailable');
      this.error(socket, 'UNAVAILABLE', invitationId);
      return;
    }
    if (!accept) {
      this.close(invitationId, 'declined');
      return;
    }
    let result: InvitationAcceptResult;
    try {
      result = this.options.accept(invitation, fromSocket, toSocket);
    } catch {
      result = { accepted: false, code: 'UNAVAILABLE' };
    }
    if (!result.accepted) {
      this.close(invitationId, 'unavailable');
      this.error(socket, result.code, invitationId);
      return;
    }
    this.close(invitationId, 'accepted');
  }

  private cancel(socket: Socket, actorId: string, invitationId: string): void {
    const pending = this.pending.get(invitationId);
    if (!pending) return this.error(socket, 'NOT_FOUND', invitationId);
    if (actorId !== pending.invitation.from.playerId || socket !== pending.fromSocket) {
      this.error(socket, 'INVALID_REQUEST', invitationId);
      return;
    }
    this.close(invitationId, 'cancelled');
  }

  private canStillAccept(pending: PendingInvitation<Socket>): boolean {
    const { invitation, fromSocket } = pending;
    const toSocket = pending.toSocket;
    if (!toSocket) return false;
    const fromId = invitation.from.playerId;
    const toId = invitation.to.playerId;
    const fromProfile = this.options.getProfile(fromId);
    const toProfile = this.options.getProfile(toId);
    return Boolean(
      fromProfile && toProfile && toProfile.showOnline !== false &&
      this.options.isAuthorizedSocket(fromId, fromSocket) &&
      this.options.isAuthorizedSocket(toId, toSocket) &&
      this.options.getSelectedSocket(toId) === toSocket &&
      this.options.getPresence(fromId) !== 'offline' &&
      this.options.getPresence(fromId) !== 'playing' &&
      canInvitePresence(this.options.getPresence(toId)),
    );
  }

  private automaticAcceptDelayMs(playerId: string): number | undefined {
    if (!this.options.getAutomaticAcceptDelayMs || !this.options.acceptAutomatic) return undefined;
    let delayMs: number | undefined;
    try {
      delayMs = this.options.getAutomaticAcceptDelayMs(playerId);
    } catch {
      return undefined;
    }
    return typeof delayMs === 'number' && Number.isFinite(delayMs) &&
      delayMs >= MIN_AUTOMATIC_ACCEPT_DELAY_MS && delayMs <= MAX_AUTOMATIC_ACCEPT_DELAY_MS
      ? delayMs
      : undefined;
  }

  private hasNoRecipientSocket(playerId: string): boolean {
    return this.options.getSelectedSocket(playerId) === undefined &&
      this.options.getPlayerSockets(playerId).length === 0;
  }

  private automaticAcceptFailure(pending: PendingInvitation<Socket>): InvitationErrorCode | undefined {
    const { invitation, fromSocket } = pending;
    const fromId = invitation.from.playerId;
    const toId = invitation.to.playerId;
    if (this.now() >= invitation.expiresAt) return 'NOT_FOUND';
    const fromProfile = this.options.getProfile(fromId);
    const toProfile = this.options.getProfile(toId);
    if (
      !fromProfile || !toProfile || toProfile.showOnline === false ||
      !this.options.isAuthorizedSocket(fromId, fromSocket) ||
      this.automaticAcceptDelayMs(toId) === undefined ||
      !this.hasNoRecipientSocket(toId)
    ) return 'UNAVAILABLE';
    const fromPresence = this.options.getPresence(fromId);
    const toPresence = this.options.getPresence(toId);
    if (fromPresence === 'playing' || toPresence === 'playing') return 'BUSY';
    if (fromPresence === 'offline' || !canInvitePresence(toPresence)) return 'UNAVAILABLE';
    return undefined;
  }

  private acceptAutomatically(invitationId: string): void {
    const pending = this.pending.get(invitationId);
    if (!pending?.automatic || pending.automaticAttempted) return;
    pending.automaticAttempted = true;
    if (pending.automaticTimer) {
      clearTimeout(pending.automaticTimer);
      pending.automaticTimer = undefined;
    }

    const failure = this.automaticAcceptFailure(pending);
    if (failure) {
      this.close(invitationId, failure === 'NOT_FOUND' ? 'expired' : 'unavailable', failure);
      return;
    }

    let result: InvitationAcceptResult;
    try {
      result = this.options.acceptAutomatic!(pending.invitation, pending.fromSocket);
    } catch {
      result = { accepted: false, code: 'UNAVAILABLE' };
    }
    if (!result.accepted) {
      this.close(invitationId, 'unavailable', result.code);
      return;
    }
    this.close(invitationId, 'accepted');
  }

  private close(
    invitationId: string,
    reason: InvitationCloseReason,
    errorCode?: InvitationErrorCode,
  ): void {
    const pending = this.pending.get(invitationId);
    if (!pending) return;
    this.pending.delete(invitationId);
    clearTimeout(pending.timer);
    if (pending.automaticTimer) clearTimeout(pending.automaticTimer);
    const { invitation } = pending;
    for (const playerId of [invitation.from.playerId, invitation.to.playerId]) {
      if (this.pendingByPlayer.get(playerId) === invitationId) this.pendingByPlayer.delete(playerId);
      for (const socket of this.options.getPlayerSockets(playerId)) {
        const socketReason = reason === 'accepted' && socket !== pending.fromSocket && socket !== pending.toSocket
          ? 'unavailable'
          : reason;
        this.options.send(socket, { type: 'INVITATION_CLOSED', invitationId, reason: socketReason });
      }
    }
    if (pending.automatic && (errorCode || reason === 'unavailable')) {
      this.error(pending.fromSocket, errorCode ?? 'UNAVAILABLE', invitationId);
    }
  }

  private sendToPlayer(playerId: string, message: unknown): void {
    for (const socket of this.options.getPlayerSockets(playerId)) this.options.send(socket, message);
  }

  private error(socket: Socket, code: InvitationErrorCode, invitationId?: string): void {
    this.options.send(socket, { type: 'INVITATION_ERROR', code, ...(invitationId ? { invitationId } : {}) });
  }

  private publicPlayer(profile: InvitationProfile): InvitationPlayer {
    return { playerId: profile.playerId, name: profile.name, rating: profile.rating };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private validIdentifier(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u0020]/.test(value);
  }
}
