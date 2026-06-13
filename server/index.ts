import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { GameState, Move } from '../src/core/types';
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState, legalMoves } from '../src/core/rules';
import { applyMove } from '../src/core/apply';
import { getResult } from '../src/core/result';

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? '0.0.0.0';
const config = { ...DEFAULT_CONFIG };

interface Room {
  id: string;
  state: GameState;
  black: WebSocket | null;
  white: WebSocket | null;
}

const rooms = new Map<string, Room>();

function makeRoomId(): string {
  return randomBytes(3).toString('hex').toUpperCase();
}

function send(ws: WebSocket, payload: unknown) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function broadcastRoom(room: Room, payload: unknown) {
  if (room.black) send(room.black, payload);
  if (room.white) send(room.white, payload);
}

function isValidMove(state: GameState, move: Move): boolean {
  const moves = legalMoves(state, config);
  return moves.some((m) => JSON.stringify(m) === JSON.stringify(move));
}

function attachPlayer(room: Room, ws: WebSocket): 'BLACK' | 'WHITE' | null {
  if (!room.black) {
    room.black = ws;
    return 'BLACK';
  }
  if (!room.white) {
    room.white = ws;
    return 'WHITE';
  }
  return null;
}

function detachPlayer(ws: WebSocket) {
  for (const room of rooms.values()) {
    let changed = false;
    if (room.black === ws) {
      room.black = null;
      changed = true;
    }
    if (room.white === ws) {
      room.white = null;
      changed = true;
    }
    if (changed) {
      const other = room.black ?? room.white;
      if (other) send(other, { type: 'OPPONENT_LEFT' });
      if (!room.black && !room.white) rooms.delete(room.id);
    }
  }
}

const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('몽진 온라인 서버 — WebSocket');
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  let boundRoomId: string | null = null;

  ws.on('message', (raw) => {
    let msg: { type: string; roomId?: string; move?: Move };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      send(ws, { type: 'ERROR', message: '잘못된 메시지 형식입니다' });
      return;
    }

    if (msg.type === 'CREATE') {
      const id = makeRoomId();
      const room: Room = { id, state: initialState(config), black: null, white: null };
      const side = attachPlayer(room, ws);
      if (!side) {
        send(ws, { type: 'ERROR', message: '방 생성에 실패했습니다' });
        return;
      }
      rooms.set(id, room);
      boundRoomId = id;
      send(ws, { type: 'CREATED', roomId: id, side, state: room.state });
      return;
    }

    if (msg.type === 'JOIN') {
      const id = msg.roomId?.trim().toUpperCase();
      if (!id) {
        send(ws, { type: 'ERROR', message: '방 코드가 필요합니다' });
        return;
      }
      const room = rooms.get(id);
      if (!room) {
        send(ws, { type: 'ERROR', message: '방을 찾을 수 없습니다' });
        return;
      }
      if (room.black === ws || room.white === ws) {
        send(ws, { type: 'ERROR', message: '이미 이 방에 참가 중입니다' });
        return;
      }
      const side = attachPlayer(room, ws);
      if (!side) {
        send(ws, { type: 'ERROR', message: '방이 가득 찼습니다' });
        return;
      }
      boundRoomId = id;
      send(ws, { type: 'JOINED', roomId: id, side, state: room.state });
      const other = side === 'BLACK' ? room.white : room.black;
      if (other) send(other, { type: 'STATE', state: room.state });
      return;
    }

    if (msg.type === 'MOVE') {
      if (!boundRoomId || !msg.move) {
        send(ws, { type: 'ERROR', message: '방에 참가한 뒤 수를 둘 수 있습니다' });
        return;
      }
      const room = rooms.get(boundRoomId);
      if (!room) {
        send(ws, { type: 'ERROR', message: '방이 존재하지 않습니다' });
        return;
      }
      const side =
        room.black === ws ? 'BLACK' : room.white === ws ? 'WHITE' : null;
      if (!side) {
        send(ws, { type: 'ERROR', message: '이 방의 플레이어가 아닙니다' });
        return;
      }
      if (room.state.turn !== side) {
        send(ws, { type: 'ERROR', message: '내 차례가 아닙니다' });
        return;
      }
      if (getResult(room.state, config)) {
        send(ws, { type: 'ERROR', message: '게임이 이미 끝났습니다' });
        return;
      }
      if (!isValidMove(room.state, msg.move)) {
        send(ws, { type: 'ERROR', message: '불법 수입니다' });
        return;
      }
      room.state = applyMove(room.state, msg.move);
      broadcastRoom(room, { type: 'STATE', state: room.state });
      return;
    }

    send(ws, { type: 'ERROR', message: '알 수 없는 요청입니다' });
  });

  ws.on('close', () => detachPlayer(ws));
});

httpServer.listen(PORT, HOST, () => {
  console.log(`몽진 온라인 서버 — ws://${HOST}:${PORT}`);
});
