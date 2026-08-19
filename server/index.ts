import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { GameState, Move, Player } from '../src/core/types';
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState, legalMoves } from '../src/core/rules';
import { applyMove } from '../src/core/apply';
import { getResult, type WinReason } from '../src/core/result';

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? '0.0.0.0';
const PROFILE_DATA_FILE = process.env.MONGJIN_PROFILE_DATA_FILE ?? join(process.cwd(), 'data', 'profiles.json');
const config = { ...DEFAULT_CONFIG };

type MatchReason = WinReason | 'forfeit';

interface StoredProfile {
  playerId: string;
  token: string;
  name: string;
  wins: number;
  losses: number;
  rating: number;
  createdAt: string;
  updatedAt: string;
}

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
const profiles = loadProfiles();

function loadProfiles(): Map<string, StoredProfile> {
  try {
    if (!existsSync(PROFILE_DATA_FILE)) return new Map();
    const parsed = JSON.parse(readFileSync(PROFILE_DATA_FILE, 'utf8')) as StoredProfile[];
    return new Map(parsed.map((profile) => [profile.playerId, profile]));
  } catch (error) {
    console.error('[profiles] 저장 파일을 읽지 못했습니다:', error);
    return new Map();
  }
}

function saveProfiles() {
  try {
    mkdirSync(dirname(PROFILE_DATA_FILE), { recursive: true });
    const tempFile = `${PROFILE_DATA_FILE}.tmp`;
    writeFileSync(tempFile, JSON.stringify([...profiles.values()], null, 2), 'utf8');
    renameSync(tempFile, PROFILE_DATA_FILE);
  } catch (error) {
    console.error('[profiles] 전적 저장에 실패했습니다:', error);
  }
}

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

function authenticate(ws: WebSocket, playerId?: string, token?: string) {
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
    profiles.set(profile.playerId, profile);
    saveProfiles();
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

function expectedScore(rating: number, opponentRating: number): number {
  return 1 / (1 + 10 ** ((opponentRating - rating) / 400));
}

function recordResult(winnerId: string, loserId: string) {
  const winner = profiles.get(winnerId);
  const loser = profiles.get(loserId);
  if (!winner || !loser) return;
  const k = 24;
  const winnerExpected = expectedScore(winner.rating, loser.rating);
  const loserExpected = expectedScore(loser.rating, winner.rating);
  winner.wins += 1;
  loser.losses += 1;
  winner.rating = Math.round(winner.rating + k * (1 - winnerExpected));
  loser.rating = Math.max(100, Math.round(loser.rating + k * (0 - loserExpected)));
  winner.updatedAt = new Date().toISOString();
  loser.updatedAt = winner.updatedAt;
  saveProfiles();
}

function finishRandomMatch(room: Room, winner: Player, reason: MatchReason) {
  if (room.kind !== 'random' || room.finished) return;
  const winnerId = winner === 'BLACK' ? room.blackPlayerId : room.whitePlayerId;
  const loserId = winner === 'BLACK' ? room.whitePlayerId : room.blackPlayerId;
  if (!winnerId || !loserId) return;
  room.finished = true;
  recordResult(winnerId, loserId);
  if (room.black) send(room.black, { type: 'MATCH_RESULT', winner, reason, profile: publicProfile(room.blackPlayerId!) });
  if (room.white) send(room.white, { type: 'MATCH_RESULT', winner, reason, profile: publicProfile(room.whitePlayerId!) });
  sendProfileToPlayer(winnerId);
  sendProfileToPlayer(loserId);
}

function startRandomMatch(first: WebSocket, second: WebSocket) {
  const firstId = sessions.get(first)?.playerId;
  const secondId = sessions.get(second)?.playerId;
  if (!firstId || !secondId) return;
  const id = makeRoomId();
  const firstIsBlack = Math.random() < 0.5;
  const room: Room = {
    id,
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
        finishRandomMatch(room, side === 'BLACK' ? 'WHITE' : 'BLACK', 'forfeit');
        completedByForfeit = true;
      }
      if (!completedByForfeit) send(other, { type: 'OPPONENT_LEFT' });
      const otherSession = sessions.get(other);
      if (otherSession) otherSession.roomId = null;
    }
    rooms.delete(room.id);
  }
  sessions.delete(ws);
}

const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, queued: matchmakingQueue.length, players: profiles.size }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('몽진 온라인 서버 — WebSocket');
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  sessions.set(ws, { playerId: null, roomId: null });

  ws.on('message', (raw) => {
    let msg: { type: string; playerId?: string; token?: string; name?: string; roomId?: string; move?: Move };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      send(ws, { type: 'ERROR', message: '잘못된 메시지 형식입니다' });
      return;
    }

    if (msg.type === 'HELLO') {
      authenticate(ws, msg.playerId, msg.token);
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
      const profile = profiles.get(playerId)!;
      profile.name = name;
      profile.updatedAt = new Date().toISOString();
      saveProfiles();
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
          if (result) finishRandomMatch(room, result.winner, result.reason);
        }
      }
      return;
    }

    send(ws, { type: 'ERROR', message: '알 수 없는 요청입니다' });
  });

  ws.on('close', () => detachPlayer(ws));
});

httpServer.listen(PORT, HOST, () => {
  console.log(`몽진 온라인 서버 — ws://${HOST}:${PORT}`);
  console.log(`프로필 저장 경로 — ${PROFILE_DATA_FILE}`);
});
