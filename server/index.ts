import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { GameState, Move, Player } from '../src/core/types';
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState, legalMoves } from '../src/core/rules';
import { applyMove } from '../src/core/apply';
import { getResult, type WinReason } from '../src/core/result';
import {
  createProfileRepository,
  loadProfilesForMigration,
  type StoredProfile,
} from './profileRepository';
import { buildLeaderboard } from './leaderboard';

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? '0.0.0.0';
const PROFILE_DATA_FILE = process.env.MONGJIN_PROFILE_DATA_FILE ?? join(process.cwd(), 'data', 'profiles.json');
const config = { ...DEFAULT_CONFIG };

type MatchReason = WinReason | 'forfeit';

interface PublicProfile {
  playerId: string;
  name: string;
  wins: number;
  losses: number;
  winRate: number;
  rating: number;
  rank: number;
  totalPlayers: number;
}

interface Room {
  id: string;
  matchId: string;
  kind: 'friend' | 'random';
  state: GameState;
  black: WebSocket | null;
  white: WebSocket | null;
  blackPlayerId: string | null;
  whitePlayerId: string | null;
  finished: boolean;
}

interface ClientSession {
  playerId: string | null;
  roomId: string | null;
}

const rooms = new Map<string, Room>();
const sessions = new Map<WebSocket, ClientSession>();
const matchmakingQueue: WebSocket[] = [];
const profileRepository = await createProfileRepository(PROFILE_DATA_FILE);
let loadedProfiles = await profileRepository.loadProfiles();
if (profileRepository.kind === 'postgres' && loadedProfiles.length === 0) {
  try {
    const legacyProfiles = loadProfilesForMigration(PROFILE_DATA_FILE);
    const imported = await profileRepository.importProfiles(legacyProfiles);
    if (imported > 0) console.log(`[profiles] 기존 JSON 프로필 ${imported}명을 Postgres로 가져왔습니다`);
    loadedProfiles = await profileRepository.loadProfiles();
  } catch (error) {
    console.error('[profiles] 기존 JSON 프로필을 가져오지 못했습니다:', error);
  }
}
const profiles = new Map(loadedProfiles.map((profile) => [profile.playerId, profile]));

function makeId(bytes = 12): string {
  return randomBytes(bytes).toString('hex');
}

function makeRoomId(): string {
  return randomBytes(3).toString('hex').toUpperCase();
}

function defaultName(): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = `나그네${Math.floor(1000 + Math.random() * 9000)}`;
    if (![...profiles.values()].some((profile) => profile.name === candidate)) return candidate;
  }
  return `나그네${randomBytes(3).toString('hex')}`;
}

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 12) return null;
  if (/[<>\u0000-\u001f]/.test(name)) return null;
  return name;
}

function rankedProfiles(): StoredProfile[] {
  return [...profiles.values()].sort(
    (a, b) => b.rating - a.rating || b.wins - a.wins || a.losses - b.losses || a.createdAt.localeCompare(b.createdAt),
  );
}

function publicProfile(playerId: string): PublicProfile {
  const profile = profiles.get(playerId)!;
  const ranked = rankedProfiles();
  const games = profile.wins + profile.losses;
  return {
    playerId,
    name: profile.name,
    wins: profile.wins,
    losses: profile.losses,
    winRate: games === 0 ? 0 : Math.round((profile.wins / games) * 1000) / 10,
    rating: profile.rating,
    rank: ranked.findIndex((candidate) => candidate.playerId === playerId) + 1,
    totalPlayers: ranked.length,
  };
}

function opponentSummary(playerId: string) {
  const profile = profiles.get(playerId)!;
  return { name: profile.name, rating: profile.rating };
}

function send(ws: WebSocket, payload: unknown) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function broadcastRoom(room: Room, payload: unknown) {
  if (room.black) send(room.black, payload);
  if (room.white) send(room.white, payload);
}

function sendProfileToPlayer(playerId: string) {
  const profile = publicProfile(playerId);
  for (const [ws, session] of sessions) {
    if (session.playerId === playerId) send(ws, { type: 'PROFILE', profile });
  }
}

async function authenticate(ws: WebSocket, playerId?: string, token?: string) {
  let profile = playerId ? profiles.get(playerId) : undefined;
  if (!profile || !token || profile.token !== token) {
    const now = new Date().toISOString();
    profile = {
      playerId: makeId(),
      token: makeId(24),
      name: defaultName(),
      wins: 0,
      losses: 0,
      rating: 1200,
      createdAt: now,
      updatedAt: now,
    };
    await profileRepository.saveProfile(profile);
    profiles.set(profile.playerId, profile);
  }
  sessions.get(ws)!.playerId = profile.playerId;
  send(ws, {
    type: 'IDENTITY',
    playerId: profile.playerId,
    token: profile.token,
    profile: publicProfile(profile.playerId),
  });
}

function requirePlayer(ws: WebSocket): string | null {
  const playerId = sessions.get(ws)?.playerId ?? null;
  if (!playerId) send(ws, { type: 'ERROR', message: '프로필 연결을 먼저 완료해 주세요' });
  return playerId;
}

function isValidMove(state: GameState, move: Move): boolean {
  return legalMoves(state, config).some((candidate) => JSON.stringify(candidate) === JSON.stringify(move));
}

function attachPlayer(room: Room, ws: WebSocket): Player | null {
  const playerId = sessions.get(ws)?.playerId ?? null;
  if (!room.black) {
    room.black = ws;
    room.blackPlayerId = playerId;
    return 'BLACK';
  }
  if (!room.white) {
    room.white = ws;
    room.whitePlayerId = playerId;
    return 'WHITE';
  }
  return null;
}

function removeFromQueue(ws: WebSocket) {
  let index = matchmakingQueue.indexOf(ws);
  while (index >= 0) {
    matchmakingQueue.splice(index, 1);
    index = matchmakingQueue.indexOf(ws);
  }
}

async function finishRandomMatch(room: Room, winner: Player, reason: MatchReason) {
  if (room.kind !== 'random' || room.finished) return;
  const winnerId = winner === 'BLACK' ? room.blackPlayerId : room.whitePlayerId;
  const loserId = winner === 'BLACK' ? room.whitePlayerId : room.blackPlayerId;
  if (!winnerId || !loserId) return;
  room.finished = true;
  try {
    const result = await profileRepository.recordMatch({
      matchId: room.matchId,
      roomId: room.id,
      winnerId,
      loserId,
      reason,
      completedAt: new Date().toISOString(),
    });
    if (result.recorded && result.winner && result.loser) {
      profiles.set(result.winner.playerId, result.winner);
      profiles.set(result.loser.playerId, result.loser);
    }
    if (room.black) send(room.black, { type: 'MATCH_RESULT', winner, reason, profile: publicProfile(room.blackPlayerId!) });
    if (room.white) send(room.white, { type: 'MATCH_RESULT', winner, reason, profile: publicProfile(room.whitePlayerId!) });
    sendProfileToPlayer(winnerId);
    sendProfileToPlayer(loserId);
  } catch (error) {
    console.error('[profiles] 경기 결과 저장에 실패했습니다:', error);
    broadcastRoom(room, { type: 'ERROR', message: '경기 결과를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요' });
  }
}

function startRandomMatch(first: WebSocket, second: WebSocket) {
  const firstId = sessions.get(first)?.playerId;
  const secondId = sessions.get(second)?.playerId;
  if (!firstId || !secondId) return;
  const id = makeRoomId();
  const firstIsBlack = Math.random() < 0.5;
  const room: Room = {
    id,
    matchId: makeId(16),
    kind: 'random',
    state: initialState(config),
    black: firstIsBlack ? first : second,
    white: firstIsBlack ? second : first,
    blackPlayerId: firstIsBlack ? firstId : secondId,
    whitePlayerId: firstIsBlack ? secondId : firstId,
    finished: false,
  };
  rooms.set(id, room);
  sessions.get(first)!.roomId = id;
  sessions.get(second)!.roomId = id;
  send(first, {
    type: 'MATCH_FOUND',
    roomId: id,
    side: firstIsBlack ? 'BLACK' : 'WHITE',
    state: room.state,
    opponent: opponentSummary(secondId),
  });
  send(second, {
    type: 'MATCH_FOUND',
    roomId: id,
    side: firstIsBlack ? 'WHITE' : 'BLACK',
    state: room.state,
    opponent: opponentSummary(firstId),
  });
}

function findOpponent(ws: WebSocket): WebSocket | null {
  const ownId = sessions.get(ws)?.playerId;
  while (matchmakingQueue.length) {
    const candidate = matchmakingQueue.shift()!;
    const candidateSession = sessions.get(candidate);
    if (
      candidate !== ws &&
      candidate.readyState === candidate.OPEN &&
      candidateSession?.playerId &&
      candidateSession.playerId !== ownId &&
      !candidateSession.roomId
    ) return candidate;
  }
  return null;
}

function detachPlayer(ws: WebSocket) {
  removeFromQueue(ws);
  const session = sessions.get(ws);
  const room = session?.roomId ? rooms.get(session.roomId) : undefined;
  if (room) {
    const side: Player | null = room.black === ws ? 'BLACK' : room.white === ws ? 'WHITE' : null;
    if (side === 'BLACK') room.black = null;
    if (side === 'WHITE') room.white = null;
    const other = room.black ?? room.white;
    if (other) {
      let completedByForfeit = false;
      if (room.kind === 'random' && !room.finished && room.state.history.length > 0 && side) {
        void finishRandomMatch(room, side === 'BLACK' ? 'WHITE' : 'BLACK', 'forfeit');
        completedByForfeit = true;
      }
      if (!completedByForfeit && !room.finished) send(other, { type: 'OPPONENT_LEFT' });
      const otherSession = sessions.get(other);
      if (otherSession) otherSession.roomId = null;
    }
    rooms.delete(room.id);
  }
  sessions.delete(ws);
}

function setCorsHeaders(res: import('node:http').ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res: import('node:http').ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

const httpServer = createServer((req, res) => {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      rooms: rooms.size,
      queued: matchmakingQueue.length,
      players: profiles.size,
      registeredProfiles: profiles.size,
      activeSessions: sessions.size,
      profileStore: profileRepository.kind,
    });
    return;
  }
  if (url.pathname === '/leaderboard' && req.method === 'GET') {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 100) || 100));
    const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0);
    sendJson(res, 200, {
      totalPlayers: profiles.size,
      entries: buildLeaderboard(profiles.values(), limit, offset),
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('몽진 온라인 서버 — WebSocket');
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  sessions.set(ws, { playerId: null, roomId: null });

  ws.on('message', (raw) => {
    void (async () => {
    let msg: { type: string; playerId?: string; token?: string; name?: string; roomId?: string; move?: Move };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      send(ws, { type: 'ERROR', message: '잘못된 메시지 형식입니다' });
      return;
    }

    if (msg.type === 'HELLO') {
      await authenticate(ws, msg.playerId, msg.token);
      return;
    }

    const playerId = requirePlayer(ws);
    if (!playerId) return;

    if (msg.type === 'GET_PROFILE') {
      send(ws, { type: 'PROFILE', profile: publicProfile(playerId) });
      return;
    }

    if (msg.type === 'UPDATE_PROFILE') {
      const name = cleanName(msg.name);
      if (!name) {
        send(ws, { type: 'ERROR', message: '닉네임은 2~12자로 입력해 주세요' });
        return;
      }
      const duplicate = [...profiles.values()].some((profile) => profile.playerId !== playerId && profile.name === name);
      if (duplicate) {
        send(ws, { type: 'ERROR', message: '이미 사용 중인 닉네임입니다' });
        return;
      }
      const profile = {
        ...profiles.get(playerId)!,
        name,
        updatedAt: new Date().toISOString(),
      };
      await profileRepository.saveProfile(profile);
      profiles.set(playerId, profile);
      send(ws, { type: 'PROFILE', profile: publicProfile(playerId) });
      return;
    }

    if (msg.type === 'MATCHMAKE') {
      const session = sessions.get(ws)!;
      if (session.roomId) {
        send(ws, { type: 'ERROR', message: '이미 대국에 참가 중입니다' });
        return;
      }
      removeFromQueue(ws);
      const opponent = findOpponent(ws);
      if (opponent) startRandomMatch(opponent, ws);
      else {
        matchmakingQueue.push(ws);
        send(ws, { type: 'PROFILE', profile: publicProfile(playerId) });
      }
      return;
    }

    if (msg.type === 'CANCEL_MATCHMAKING') {
      removeFromQueue(ws);
      send(ws, { type: 'QUEUE_LEFT' });
      return;
    }

    if (msg.type === 'CREATE') {
      const id = makeRoomId();
      const room: Room = {
        id,
        matchId: makeId(16),
        kind: 'friend',
        state: initialState(config),
        black: null,
        white: null,
        blackPlayerId: null,
        whitePlayerId: null,
        finished: false,
      };
      const side = attachPlayer(room, ws);
      rooms.set(id, room);
      sessions.get(ws)!.roomId = id;
      send(ws, { type: 'CREATED', roomId: id, side, state: room.state });
      return;
    }

    if (msg.type === 'JOIN') {
      const id = msg.roomId?.trim().toUpperCase();
      const room = id ? rooms.get(id) : undefined;
      if (!id) send(ws, { type: 'ERROR', message: '방 코드가 필요합니다' });
      else if (!room) send(ws, { type: 'ERROR', message: '방을 찾을 수 없습니다' });
      else if (room.kind !== 'friend') send(ws, { type: 'ERROR', message: '참가할 수 없는 방입니다' });
      else if (room.black === ws || room.white === ws) send(ws, { type: 'ERROR', message: '이미 이 방에 참가 중입니다' });
      else {
        const side = attachPlayer(room, ws);
        if (!side) send(ws, { type: 'ERROR', message: '방이 가득 찼습니다' });
        else {
          sessions.get(ws)!.roomId = id;
          send(ws, { type: 'JOINED', roomId: id, side, state: room.state });
          const other = side === 'BLACK' ? room.white : room.black;
          if (other) send(other, { type: 'STATE', state: room.state });
          if (room.black && room.white && room.blackPlayerId && room.whitePlayerId) {
            send(room.black, {
              type: 'MATCH_FOUND',
              roomId: id,
              side: 'BLACK',
              state: room.state,
              opponent: opponentSummary(room.whitePlayerId),
            });
            send(room.white, {
              type: 'MATCH_FOUND',
              roomId: id,
              side: 'WHITE',
              state: room.state,
              opponent: opponentSummary(room.blackPlayerId),
            });
          }
        }
      }
      return;
    }

    if (msg.type === 'RESIGN') {
      const roomId = sessions.get(ws)?.roomId;
      const room = roomId ? rooms.get(roomId) : undefined;
      const side: Player | null = room && room.black === ws ? 'BLACK' : room && room.white === ws ? 'WHITE' : null;
      if (!room || !side) send(ws, { type: 'ERROR', message: '방에 참가한 뒤 항복할 수 있습니다' });
      else if (room.kind === 'random' && !room.finished) await finishRandomMatch(room, side === 'BLACK' ? 'WHITE' : 'BLACK', 'forfeit');
      return;
    }

    if (msg.type === 'MOVE') {
      const roomId = sessions.get(ws)?.roomId;
      const room = roomId ? rooms.get(roomId) : undefined;
      if (!roomId || !msg.move) send(ws, { type: 'ERROR', message: '방에 참가한 뒤 수를 둘 수 있습니다' });
      else if (!room) send(ws, { type: 'ERROR', message: '방이 존재하지 않습니다' });
      else {
        const side: Player | null = room.black === ws ? 'BLACK' : room.white === ws ? 'WHITE' : null;
        if (!side) send(ws, { type: 'ERROR', message: '이 방의 플레이어가 아닙니다' });
        else if (room.state.turn !== side) send(ws, { type: 'ERROR', message: '내 차례가 아닙니다' });
        else if (getResult(room.state, config)) send(ws, { type: 'ERROR', message: '게임이 이미 끝났습니다' });
        else if (!isValidMove(room.state, msg.move)) send(ws, { type: 'ERROR', message: '불법 수입니다' });
        else {
          room.state = applyMove(room.state, msg.move);
          broadcastRoom(room, { type: 'STATE', state: room.state });
          const result = getResult(room.state, config);
          if (result) await finishRandomMatch(room, result.winner, result.reason);
        }
      }
      return;
    }

    send(ws, { type: 'ERROR', message: '알 수 없는 요청입니다' });
    })().catch((error) => {
      console.error('[server] 메시지 처리 실패:', error);
      send(ws, { type: 'ERROR', message: '서버에서 요청을 처리하지 못했습니다' });
    });
  });

  ws.on('close', () => detachPlayer(ws));
});

httpServer.listen(PORT, HOST, () => {
  console.log(`몽진 온라인 서버 — ws://${HOST}:${PORT}`);
  console.log(`프로필 저장소 — ${profileRepository.kind === 'postgres' ? 'Postgres' : PROFILE_DATA_FILE}`);
});
