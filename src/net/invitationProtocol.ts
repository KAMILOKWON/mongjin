/** Capability-gated so older clients never become unreachable invitation targets. */
export const INVITATION_FEATURE = 'profile-invites' as const;
export const INVITATION_TTL_MS = 30_000;
export const PRESENCE_REFRESH_MS = 5_000;

export type PlayerPresence = 'offline' | 'idle' | 'matching' | 'playing';
export type ClientPresence = 'idle' | 'playing' | 'background';

export interface InvitationPlayer {
  playerId: string;
  name: string;
  rating: number;
}

export interface MatchInvitation {
  id: string;
  from: InvitationPlayer;
  to: InvitationPlayer;
  expiresAt: number;
}

export type InvitationCloseReason = 'accepted' | 'declined' | 'cancelled' | 'expired' | 'unavailable';
export type InvitationErrorCode = 'SELF_INVITE' | 'UNAVAILABLE' | 'BUSY' | 'PENDING' | 'NOT_FOUND' | 'INVALID_REQUEST' | 'SAVE_FAILED';

export type InvitationClientMessage =
  | { type: 'UPDATE_PRESENCE'; state: ClientPresence }
  | { type: 'SET_ONLINE_VISIBILITY'; showOnline: boolean }
  | { type: 'SEND_INVITATION'; playerId: string }
  | { type: 'RESPOND_INVITATION'; invitationId: string; accept: boolean }
  | { type: 'CANCEL_INVITATION'; invitationId: string };

export type InvitationServerMessage =
  | { type: 'INVITATION'; invitation: MatchInvitation; direction: 'incoming' | 'outgoing' }
  | { type: 'INVITATION_CLOSED'; invitationId: string; reason: InvitationCloseReason }
  | { type: 'INVITATION_ERROR'; code: InvitationErrorCode; invitationId?: string }
  | { type: 'ONLINE_VISIBILITY'; showOnline: boolean };

export function canInvitePresence(presence: PlayerPresence | undefined): boolean {
  return presence === 'idle' || presence === 'matching';
}

export function isInvitationMessageType(type: unknown): boolean {
  return typeof type === 'string' && [
    'UPDATE_PRESENCE', 'SET_ONLINE_VISIBILITY', 'SEND_INVITATION',
    'RESPOND_INVITATION', 'CANCEL_INVITATION',
  ].includes(type);
}
