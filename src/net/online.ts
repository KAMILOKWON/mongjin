import type { GameState, Move, Player } from '../core/types';
import { resolveWsUrl } from './wsUrl';

export type OnlineSide = Player;

export type ServerMessage =
  | { type: 'CREATED'; roomId: string; side: OnlineSide; state: GameState }
  | { type: 'JOINED'; roomId: string; side: OnlineSide; state: GameState }
  | { type: 'STATE'; state: GameState }
  | { type: 'OPPONENT_LEFT' }
  | { type: 'ERROR'; message: string };

export type ClientMessage =
  | { type: 'CREATE' }
  | { type: 'JOIN'; roomId: string }
  | { type: 'MOVE'; move: Move };

export interface OnlineCallbacks {
  onState: (state: GameState) => void;
  onJoined: (roomId: string, side: OnlineSide) => void;
  onOpponentLeft: () => void;
  onError: (message: string) => void;
  onStatus: (message: string) => void;
}

const CONNECT_TIMEOUT_MS = 45_000;
const CONNECT_RETRIES = 3;

export class OnlineClient {
  private ws: WebSocket | null = null;
  private roomId: string | null = null;
  private side: OnlineSide | null = null;

  constructor(
    private callbacks: OnlineCallbacks,
    private url = resolveWsUrl(),
  ) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get currentRoomId(): string | null {
    return this.roomId;
  }

  get mySide(): OnlineSide | null {
    return this.side;
  }

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();

    let lastError: Error | null = null;
    const attempt = (n: number): Promise<void> =>
      new Promise((resolve, reject) => {
        if (n > 1) {
          this.callbacks.onStatus(`서버 연결 재시도 (${n}/${CONNECT_RETRIES})…`);
        } else {
          this.callbacks.onStatus('서버 연결 중…');
        }

        const ws = new WebSocket(this.url);
        this.ws = ws;
        let settled = false;

        const timer = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          ws.close();
          reject(new Error('connect timeout'));
        }, CONNECT_TIMEOUT_MS);

        ws.onopen = () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          this.callbacks.onStatus('서버에 연결됨');
          resolve();
        };

        ws.onerror = () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          reject(new Error('ws connect failed'));
        };

        ws.onclose = () => {
          if (!settled) {
            settled = true;
            window.clearTimeout(timer);
            reject(new Error('ws closed before open'));
          } else {
            this.roomId = null;
            this.side = null;
            this.callbacks.onStatus('연결 끊김');
          }
        };

        ws.onmessage = (ev) => this.handleMessage(JSON.parse(String(ev.data)) as ServerMessage);
      });

    const run = async (): Promise<void> => {
      for (let i = 1; i <= CONNECT_RETRIES; i++) {
        try {
          await attempt(i);
          return;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error('connect failed');
          this.ws = null;
          if (i < CONNECT_RETRIES) {
            await new Promise((r) => window.setTimeout(r, 1500 * i));
          }
        }
      }
      this.callbacks.onError('온라인 서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.');
      throw lastError ?? new Error('connect failed');
    };

    return run();
  }

  disconnect() {
    this.ws?.close();
    this.ws = null;
    this.roomId = null;
    this.side = null;
  }

  async createRoom() {
    await this.connect();
    this.send({ type: 'CREATE' });
  }

  async joinRoom(roomId: string) {
    await this.connect();
    this.send({ type: 'JOIN', roomId: roomId.trim().toUpperCase() });
  }

  sendMove(move: Move) {
    this.send({ type: 'MOVE', move });
  }

  private send(msg: ClientMessage) {
    if (!this.connected) {
      this.callbacks.onError('서버에 연결되어 있지 않습니다');
      return;
    }
    this.ws!.send(JSON.stringify(msg));
  }

  private handleMessage(msg: ServerMessage) {
    switch (msg.type) {
      case 'CREATED':
      case 'JOINED':
        this.roomId = msg.roomId;
        this.side = msg.side;
        this.callbacks.onJoined(msg.roomId, msg.side);
        this.callbacks.onState(msg.state);
        this.callbacks.onStatus(
          msg.type === 'CREATED'
            ? `입장코드 ${msg.roomId} — ${msg.side === 'BLACK' ? '흑' : '백'} (상대 대기 중)`
            : `입장코드 ${msg.roomId} — ${msg.side === 'BLACK' ? '흑' : '백'}`,
        );
        break;
      case 'STATE':
        this.callbacks.onState(msg.state);
        break;
      case 'OPPONENT_LEFT':
        this.callbacks.onOpponentLeft();
        break;
      case 'ERROR':
        this.callbacks.onError(msg.message);
        break;
    }
  }
}
