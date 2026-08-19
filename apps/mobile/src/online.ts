import AsyncStorage from '@react-native-async-storage/async-storage';
import type { GameState, Move, Player } from '../../../packages/game-core/src';

export const PRODUCTION_WS_URL = 'wss://mongjin-api.onrender.com';
export const MATCHMAKING_TIMEOUT_MS = 15_000;

export interface PlayerProfile {
  playerId: string;
  name: string;
  wins: number;
  losses: number;
  winRate: number;
  rating: number;
  rank: number;
  totalPlayers: number;
}

export interface OpponentProfile {
  name: string;
  rating: number;
}

export type OnlineMatchReason = 'goal' | 'capture' | 'surround' | 'no-moves' | 'forfeit' | 'timeout';
type StoredIdentity = { playerId: string; token: string };

export type ServerMessage =
  | { type: 'IDENTITY'; playerId: string; token: string; profile: PlayerProfile }
  | { type: 'PROFILE'; profile: PlayerProfile }
  | { type: 'CREATED'; roomId: string; side: Player; state: GameState }
  | { type: 'JOINED'; roomId: string; side: Player; state: GameState }
  | { type: 'MATCH_FOUND'; roomId: string; side: Player; state: GameState; opponent: OpponentProfile }
  | { type: 'MATCH_RESULT'; winner: Player; reason: OnlineMatchReason; profile: PlayerProfile }
  | { type: 'QUEUE_LEFT' }
  | { type: 'STATE'; state: GameState }
  | { type: 'OPPONENT_LEFT' }
  | { type: 'ERROR'; message: string };

export type ClientMessage =
  | { type: 'HELLO'; playerId?: string; token?: string }
  | { type: 'GET_PROFILE' }
  | { type: 'UPDATE_PROFILE'; name: string }
  | { type: 'MATCHMAKE' }
  | { type: 'CANCEL_MATCHMAKING' }
  | { type: 'CREATE' }
  | { type: 'JOIN'; roomId: string }
  | { type: 'MOVE'; move: Move };

export interface OnlineCallbacks {
  onState: (state: GameState) => void;
  onJoined: (roomId: string, side: Player) => void;
  onMatchFound: (roomId: string, side: Player, opponent: OpponentProfile, state: GameState) => void;
  onMatchResult: (winner: Player, reason: OnlineMatchReason) => void;
  onProfile: (profile: PlayerProfile) => void;
  onOpponentLeft: () => void;
  onMatchmakingTimeout: () => void;
  onError: (message: string) => void;
  onStatus: (message: string) => void;
}

const IDENTITY_KEY = 'mongjin.online.identity.v2';

export class MobileOnlineClient {
  private ws: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private roomId: string | null = null;
  private side: Player | null = null;
  private queued = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;

  constructor(
    private readonly callbacks: OnlineCallbacks,
    private readonly url = process.env.EXPO_PUBLIC_WS_URL ?? PRODUCTION_WS_URL,
  ) {}

  get connected(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    const generation = this.generation;
    this.connecting = new Promise<void>((resolve, reject) => {
      let settled = false;
      this.callbacks.onStatus('서버 연결 중…');
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.close();
        reject(new Error('connect timeout'));
      }, 45_000);
      ws.onopen = async () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const raw = await AsyncStorage.getItem(IDENTITY_KEY).catch(() => null);
        const identity = raw ? JSON.parse(raw) as StoredIdentity : null;
        this.send({ type: 'HELLO', ...identity });
        this.callbacks.onStatus('서버에 연결됨');
        resolve();
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error('ws connect failed'));
      };
      ws.onclose = () => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          reject(new Error('ws closed before open'));
          return;
        }
        this.roomId = null;
        this.side = null;
        this.queued = false;
        this.clearTimer();
        this.callbacks.onStatus('연결 끊김');
      };
      ws.onmessage = (event) => {
        try { this.handle(JSON.parse(String(event.data)) as ServerMessage); }
        catch { this.callbacks.onError('서버 응답을 읽을 수 없습니다'); }
      };
    }).finally(() => { this.connecting = null; });

    try {
      await this.connecting;
    } catch (error) {
      this.ws = null;
      if (generation !== this.generation) throw error;
      throw error;
    }
  }

  disconnect(): void {
    this.generation += 1;
    this.clearTimer();
    this.ws?.close();
    this.ws = null;
    this.roomId = null;
    this.side = null;
    this.queued = false;
  }

  async getProfile(): Promise<void> { await this.connect(); this.send({ type: 'GET_PROFILE' }); }
  async updateProfile(name: string): Promise<void> { await this.connect(); this.send({ type: 'UPDATE_PROFILE', name }); }

  async startMatchmaking(): Promise<void> {
    await this.connect();
    this.clearTimer();
    this.queued = true;
    this.callbacks.onStatus('랜덤 상대를 찾는 중…');
    this.send({ type: 'MATCHMAKE' });
    this.timer = setTimeout(() => {
      if (!this.queued) return;
      this.cancelMatchmaking();
      this.callbacks.onMatchmakingTimeout();
    }, MATCHMAKING_TIMEOUT_MS);
  }

  cancelMatchmaking(): void {
    this.clearTimer();
    if (this.connected) this.send({ type: 'CANCEL_MATCHMAKING' });
    this.queued = false;
  }

  async createRoom(): Promise<void> { await this.connect(); this.send({ type: 'CREATE' }); }
  async joinRoom(roomId: string): Promise<void> { await this.connect(); this.send({ type: 'JOIN', roomId: roomId.trim().toUpperCase() }); }
  sendMove(move: Move): void { this.send({ type: 'MOVE', move }); }

  private send(message: ClientMessage): void {
    if (!this.connected) { this.callbacks.onError('서버에 연결되어 있지 않습니다'); return; }
    this.ws!.send(JSON.stringify(message));
  }

  private handle(message: ServerMessage): void {
    switch (message.type) {
      case 'IDENTITY':
        void AsyncStorage.setItem(IDENTITY_KEY, JSON.stringify({ playerId: message.playerId, token: message.token }));
        this.callbacks.onProfile(message.profile);
        break;
      case 'PROFILE': this.callbacks.onProfile(message.profile); break;
      case 'CREATED':
      case 'JOINED':
        this.clearTimer(); this.queued = false; this.roomId = message.roomId; this.side = message.side;
        this.callbacks.onJoined(message.roomId, message.side); this.callbacks.onState(message.state); break;
      case 'MATCH_FOUND':
        this.clearTimer(); this.queued = false; this.roomId = message.roomId; this.side = message.side;
        this.callbacks.onMatchFound(message.roomId, message.side, message.opponent, message.state); break;
      case 'MATCH_RESULT': this.callbacks.onProfile(message.profile); this.callbacks.onMatchResult(message.winner, message.reason); break;
      case 'QUEUE_LEFT': this.clearTimer(); this.queued = false; this.callbacks.onStatus('랜덤 매칭을 취소했어요'); break;
      case 'STATE': this.callbacks.onState(message.state); break;
      case 'OPPONENT_LEFT': this.callbacks.onOpponentLeft(); break;
      case 'ERROR': this.clearTimer(); this.queued = false; this.callbacks.onError(message.message); break;
    }
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
