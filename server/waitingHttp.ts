import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TournamentPublicStatus } from '../src/net/tournamentProtocol';
import type { TournamentBackgroundStatus } from './tournamentBackground';
import { communityReply, HttpError, readCommunityJson } from './communityHttp';
import { parseWaitingDestination, type WaitingNotifications } from './waitingNotifications';

interface WaitingRegistry {
  publicStatus(id?: string): TournamentPublicStatus;
  backgroundStatus(playerId: string, tournamentId: string): TournamentBackgroundStatus | null;
  cancelWaiting(playerId: string, tournamentId?: string): boolean | Promise<boolean>;
}
/** Authenticated recovery never attaches a socket or sends a readiness acknowledgement. */
export function createWaitingHandler(notifications: WaitingNotifications, registry: WaitingRegistry, authorize: (playerId: string, token: string) => boolean) {
  const paths = new Set(['/tournament/waiting-device', '/tournament/waiting-status', '/tournament/waiting-cancel']);
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const path = req.url?.split('?')[0] ?? '';
    if (!paths.has(path)) return false;
    try {
      if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
      const body = await readCommunityJson(req);
      const { playerId, token, tournamentId } = body;
      if (typeof playerId !== 'string' || typeof token !== 'string' || !authorize(playerId, token)) throw new HttpError(401, 'NOT_AUTHENTICATED');
      if (typeof tournamentId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(tournamentId)) throw new HttpError(400, 'INVALID_REQUEST');
      const status = registry.publicStatus(tournamentId);
      if (status.config?.id !== tournamentId) throw new HttpError(404, 'NOT_FOUND');
      if (path === '/tournament/waiting-device') {
        const destination = parseWaitingDestination(body.destination);
        if (!destination) throw new HttpError(400, 'INVALID_DESTINATION');
        communityReply(res, 200, await notifications.register(playerId, tournamentId, destination));
      } else if (path === '/tournament/waiting-cancel') {
        const cancelled = await registry.cancelWaiting(playerId, tournamentId);
        communityReply(res, 200, { cancelled: cancelled === true });
      } else {
        communityReply(res, 200, { snapshot: registry.backgroundStatus(playerId, tournamentId), status });
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : 'INTERNAL_ERROR';
      const status = error instanceof HttpError ? error.status : code === 'DESTINATION_OWNED' ? 409 : code === 'INVALID_DESTINATION' ? 400 : 500;
      communityReply(res, status, { error: status === 500 ? 'INTERNAL_ERROR' : code });
    }
    return true;
  };
}
