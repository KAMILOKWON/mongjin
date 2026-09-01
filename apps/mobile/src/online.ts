import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import type { GameState, Move, Player } from '../../../packages/game-core/src';
import { dict, getI18nLang } from './i18n';

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
  legacyMigrationComplete?: boolean;
}

export interface LegacyProfileClaim {
  name: string;
  wins: number;
  losses: number;
  rating: number;
}

export interface OpponentProfile {
  name: string;
  rating: number;
  isBot?: boolean;
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
  | { type: 'MIGRATE_LEGACY_PROFILE'; legacyProfile: LegacyProfileClaim }
  | { type: 'MATCHMAKE' }
  | { type: 'MATCHMAKE_BOT' }
  | { type: 'CANCEL_MATCHMAKING' }
  | { type: 'CREATE' }
  | { type: 'JOIN'; roomId: string }
  | { type: 'MOVE'; move: Move }
  | { type: 'RESIGN' };

export interface OnlineCallbacks {
  onState: (state: GameState) => void;
  onJoined: (roomId: string, side: Player) => void;
  onMatchFound: (roomId: string, side: Player, opponent: OpponentProfile, state: GameState) => void;
  onMatchResult: (winner: Player, reason: OnlineMatchReason) => void;
  onProfile: (profile: PlayerProfile) => void | Promise<void>;
  onOpponentLeft: () => void;
  onMatchmakingTimeout: () => void;
  onError: (message: string) => void;
  onStatus: (message: string) => void;
}

const LEGACY_IDENTITY_KEY = 'mongjin.online.identity.v2';
const IDENTITY_KEY = 'mongjin.online.identity.v3';

function parseIdentity(raw: string | null): StoredIdentity | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredIdentity>;
    if (typeof parsed.playerId !== 'string' || !parsed.playerId || typeof parsed.token !== 'string' || !parsed.token) return null;
    return { playerId: parsed.playerId, token: parsed.token };
  } catch {
    return null;
  }
}

async function loadIdentity(): Promise<StoredIdentity | null> {
  const secure = parseIdentity(await SecureStore.getItemAsync(IDENTITY_KEY).catch(() => null));
  if (secure) return secure;

  const legacy = parseIdentity(await AsyncStorage.getItem(LEGACY_IDENTITY_KEY).catch(() => null));
  if (legacy) await persistIdentity(legacy);
  return legacy;
}

async function persistIdentity(identity: StoredIdentity): Promise<void> {
  const value = JSON.stringify(identity);
  const writes = await Promise.allSettled([
    SecureStore.setItemAsync(IDENTITY_KEY, value),
    AsyncStorage.setItem(LEGACY_IDENTITY_KEY, value),
  ]);
  if (writes.every((result) => result.status === 'rejected')) {
    throw new Error('identity persistence failed');
  }
}

export class MobileOnlineClient {
  private ws: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private roomId: string | null = null;
  private side: Player | null = null;
  private queued = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private messageQueue: Promise<void> = Promise.resolve();

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
      this.callbacks.onStatus(dict(getI18nLang()).connecting);
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
        try {
          const identity = await loadIdentity();
          this.send({ type: 'HELLO', ...(identity ?? {}) });
          this.callbacks.onStatus(dict(getI18nLang()).connectedStatus);
          resolve();
        } catch (error) {
          ws.close();
          reject(error);
        }
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
        this.callbacks.onStatus(dict(getI18nLang()).disconnected);
      };
      ws.onmessage = (event) => {
        this.messageQueue = this.messageQueue
          .then(async () => {
            const message = JSON.parse(String(event.data)) as ServerMessage;
            await this.handle(message);
          })
          .catch(() => { this.callbacks.onError(dict(getI18nLang()).parseFailed); });
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
  async migrateLegacyProfile(legacyProfile: LegacyProfileClaim): Promise<void> {
    await this.connect();
    this.send({ type: 'MIGRATE_LEGACY_PROFILE', legacyProfile });
  }

  async startMatchmaking(): Promise<void> {
    await this.connect();
    this.clearTimer();
    this.queued = true;
    this.callbacks.onStatus(dict(getI18nLang()).searching);
    this.send({ type: 'MATCHMAKE' });
    this.timer = setTimeout(() => {
      if (!this.queued) return;
      this.cancelMatchmaking();
      this.callbacks.onMatchmakingTimeout();
    }, MATCHMAKING_TIMEOUT_MS);
  }

  async startBotMatch(): Promise<void> {
    await this.connect();
    this.clearTimer();
    this.queued = false;
    this.callbacks.onStatus(dict(getI18nLang()).connecting);
    this.send({ type: 'MATCHMAKE_BOT' });
  }

  cancelMatchmaking(): void {
    this.clearTimer();
    if (this.connected) this.send({ type: 'CANCEL_MATCHMAKING' });
    this.queued = false;
  }

  async createRoom(): Promise<void> { await this.connect(); this.send({ type: 'CREATE' }); }
  async joinRoom(roomId: string): Promise<void> { await this.connect(); this.send({ type: 'JOIN', roomId: roomId.trim().toUpperCase() }); }
  sendMove(move: Move): void { this.send({ type: 'MOVE', move }); }
  sendResign(): void { this.send({ type: 'RESIGN' }); }

  private send(message: ClientMessage): void {
    if (!this.connected) { this.callbacks.onError(dict(getI18nLang()).notConnected); return; }
    this.ws!.send(JSON.stringify(message));
  }

  private async handle(message: ServerMessage): Promise<void> {
    switch (message.type) {
      case 'IDENTITY':
        try {
          await persistIdentity({ playerId: message.playerId, token: message.token });
        } catch {
          this.callbacks.onError(dict(getI18nLang()).idSaveFailed);
        }
        await this.callbacks.onProfile(message.profile);
        break;
      case 'PROFILE': await this.callbacks.onProfile(message.profile); break;
      case 'CREATED':
      case 'JOINED':
        this.clearTimer(); this.queued = false; this.roomId = message.roomId; this.side = message.side;
        this.callbacks.onJoined(message.roomId, message.side); this.callbacks.onState(message.state); break;
      case 'MATCH_FOUND':
        this.clearTimer(); this.queued = false; this.roomId = message.roomId; this.side = message.side;
        this.callbacks.onMatchFound(message.roomId, message.side, message.opponent, message.state); break;
      case 'MATCH_RESULT': await this.callbacks.onProfile(message.profile); this.callbacks.onMatchResult(message.winner, message.reason); break;
      case 'QUEUE_LEFT': this.clearTimer(); this.queued = false; this.callbacks.onStatus(dict(getI18nLang()).queueCancelled); break;
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
