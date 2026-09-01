import type { GameState, Move, Player } from '../../../../packages/game-core/src';
import { resolveWsUrl } from './wsUrl';

export type OnlineSide = Player;

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
  /** 서버가 Elo 기반으로 매칭한 AI 상대이면 true */
  isBot?: boolean;
}

export type OnlineMatchReason = 'goal' | 'capture' | 'surround' | 'no-moves' | 'forfeit';

type StoredIdentity = { playerId: string; token: string; source?: 'toss' };

export type ServerMessage =
  | { type: 'IDENTITY'; playerId: string; token: string; profile: PlayerProfile }
  | { type: 'PROFILE'; profile: PlayerProfile }
  | { type: 'CREATED'; roomId: string; side: OnlineSide; state: GameState }
  | { type: 'JOINED'; roomId: string; side: OnlineSide; state: GameState }
  | {
      type: 'MATCH_FOUND';
      roomId: string;
      side: OnlineSide;
      state: GameState;
      opponent: OpponentProfile;
    }
  | {
      type: 'MATCH_RESULT';
      winner: OnlineSide;
      reason: OnlineMatchReason;
      profile: PlayerProfile;
    }
  | { type: 'QUEUE_LEFT' }
  | { type: 'STATE'; state: GameState }
  | { type: 'OPPONENT_LEFT' }
  | { type: 'LOGGED_OUT'; message?: string }
  | { type: 'UNLINKED'; message?: string }
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
  onJoined: (roomId: string, side: OnlineSide) => void;
  onMatchFound: (roomId: string, side: OnlineSide, opponent: OpponentProfile) => void;
  onMatchResult: (winner: OnlineSide, reason: OnlineMatchReason) => void;
  onProfile: (profile: PlayerProfile) => void;
  onOpponentLeft: () => void;
  onMatchmakingTimeout: () => void;
  onError: (message: string) => void;
  onStatus: (message: string) => void;
  /** 토스 연결 해제 등으로 서버가 세션을 무효화했을 때. identity는 이미 삭제된 상태다. */
  onLoggedOut?: (message: string) => void;
}

const CONNECT_TIMEOUT_MS = 45_000;
const CONNECT_RETRIES = 3;
export const MATCHMAKING_TIMEOUT_MS = 15_000;
const IDENTITY_STORAGE_KEY = 'mongjin.online.identity.v1';

function loadIdentity(): StoredIdentity | null {
  try {
    const value = JSON.parse(localStorage.getItem(IDENTITY_STORAGE_KEY) ?? 'null') as StoredIdentity | null;
    return value?.playerId && value?.token ? value : null;
  } catch {
    return null;
  }
}

export function saveIdentity(identity: StoredIdentity) {
  try {
    const existing = loadIdentity();
    const next: StoredIdentity = {
      playerId: identity.playerId,
      token: identity.token,
      source:
        identity.source ??
        (existing?.playerId === identity.playerId ? existing.source : undefined),
    };
    localStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 저장소를 쓸 수 없는 WebView에서도 현재 세션 플레이는 허용한다.
  }
}

/** 로컬에 저장된 온라인 identity가 있는지 */
export function hasIdentity(): boolean {
  return loadIdentity() !== null;
}

/** 앱인토스 미니앱에서 토스 로그인으로 발급된 세션인지 */
export function hasTossIdentity(): boolean {
  return loadIdentity()?.source === 'toss';
}

export function clearIdentity() {
  try {
    localStorage.removeItem(IDENTITY_STORAGE_KEY);
  } catch {
    // 저장소 접근 실패는 무시한다.
  }
}

export class OnlineClient {
  private ws: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private connectionVersion = 0;
  private roomId: string | null = null;
  private side: OnlineSide | null = null;
  private queued = false;
  private matchmakingTimer: number | null = null;

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

  get isQueued(): boolean {
    return this.queued;
  }

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;

    const version = this.connectionVersion;
    let lastError: Error | null = null;
    const attempt = (n: number): Promise<void> =>
      new Promise((resolve, reject) => {
        this.callbacks.onStatus(n > 1 ? `서버 연결 재시도 (${n}/${CONNECT_RETRIES})…` : '서버 연결 중…');
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
          const identity = loadIdentity();
          this.send({ type: 'HELLO', ...identity });
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
            const wasQueued = this.queued;
            this.roomId = null;
            this.side = null;
            this.queued = false;
            this.clearMatchmakingTimer();
            // 내부 연결 상태를 사용자에게 노출하지 않는다. 매칭 중 끊겼다면
            // 기다리게 두지 않고 기록된 상대와 즉시 자연스럽게 이어간다.
            this.callbacks.onStatus('');
            if (wasQueued) this.callbacks.onMatchmakingTimeout();
          }
        };

        ws.onmessage = (ev) => {
          try {
            this.handleMessage(JSON.parse(String(ev.data)) as ServerMessage);
          } catch {
            this.callbacks.onError('서버 응답을 읽을 수 없습니다');
          }
        };
      });

    const run = async (): Promise<void> => {
      for (let i = 1; i <= CONNECT_RETRIES; i++) {
        try {
          await attempt(i);
          return;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error('connect failed');
          this.ws = null;
          if (version !== this.connectionVersion) throw lastError;
          if (i < CONNECT_RETRIES) await new Promise((r) => window.setTimeout(r, 1500 * i));
        }
      }
      this.callbacks.onError('온라인 서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.');
      throw lastError ?? new Error('connect failed');
    };

    this.connecting = run().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  disconnect() {
    this.connectionVersion += 1;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
    this.roomId = null;
    this.side = null;
    this.queued = false;
    this.clearMatchmakingTimer();
  }

  async getProfile() {
    await this.connect();
    this.send({ type: 'GET_PROFILE' });
  }

  async updateProfile(name: string) {
    await this.connect();
    this.send({ type: 'UPDATE_PROFILE', name });
  }

  async migrateLegacyProfile(legacyProfile: LegacyProfileClaim) {
    await this.connect();
    this.send({ type: 'MIGRATE_LEGACY_PROFILE', legacyProfile });
  }

  async startMatchmaking() {
    await this.connect();
    this.clearMatchmakingTimer();
    this.queued = true;
    this.callbacks.onStatus('랜덤 상대를 찾는 중…');
    this.send({ type: 'MATCHMAKE' });
    this.matchmakingTimer = window.setTimeout(() => {
      if (!this.queued) return;
      this.cancelMatchmaking();
      this.callbacks.onMatchmakingTimeout();
    }, MATCHMAKING_TIMEOUT_MS);
  }

  async startBotMatch() {
    await this.connect();
    this.clearMatchmakingTimer();
    this.queued = false;
    this.callbacks.onStatus('상대를 연결하는 중…');
    this.send({ type: 'MATCHMAKE_BOT' });
  }

  cancelMatchmaking() {
    this.clearMatchmakingTimer();
    if (this.connected) this.send({ type: 'CANCEL_MATCHMAKING' });
    this.queued = false;
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

  /** 서버에 항복을 알려 상대에게 패배로 기록한다 */
  sendResign() {
    this.send({ type: 'RESIGN' });
  }

  private send(msg: ClientMessage) {
    if (!this.connected) {
      this.callbacks.onError('서버에 연결되어 있지 않습니다');
      return;
    }
    this.ws!.send(JSON.stringify(msg));
  }

  private clearMatchmakingTimer() {
    if (this.matchmakingTimer !== null) window.clearTimeout(this.matchmakingTimer);
    this.matchmakingTimer = null;
  }

  private handleMessage(msg: ServerMessage) {
    switch (msg.type) {
      case 'IDENTITY':
        saveIdentity({ playerId: msg.playerId, token: msg.token });
        this.callbacks.onProfile(msg.profile);
        break;
      case 'PROFILE':
        this.callbacks.onProfile(msg.profile);
        break;
      case 'CREATED':
      case 'JOINED':
        this.clearMatchmakingTimer();
        this.queued = false;
        this.roomId = msg.roomId;
        this.side = msg.side;
        this.callbacks.onJoined(msg.roomId, msg.side);
        this.callbacks.onState(msg.state);
        this.callbacks.onStatus(
          msg.type === 'CREATED'
            ? `입장코드 ${msg.roomId} · ${msg.side === 'BLACK' ? '흑' : '백'} (상대 대기 중)`
            : `입장코드 ${msg.roomId} · ${msg.side === 'BLACK' ? '흑' : '백'}`,
        );
        break;
      case 'MATCH_FOUND':
        this.clearMatchmakingTimer();
        this.queued = false;
        this.roomId = msg.roomId;
        this.side = msg.side;
        this.callbacks.onMatchFound(msg.roomId, msg.side, msg.opponent);
        this.callbacks.onState(msg.state);
        this.callbacks.onStatus(
          msg.opponent.isBot
            ? `${msg.opponent.name}와 대국해요 · ${msg.side === 'BLACK' ? '흑' : '백'}`
            : `${msg.opponent.name} 님과 매칭됐어요 · ${msg.side === 'BLACK' ? '흑' : '백'}`,
        );
        break;
      case 'MATCH_RESULT':
        this.callbacks.onProfile(msg.profile);
        this.callbacks.onMatchResult(msg.winner, msg.reason);
        break;
      case 'QUEUE_LEFT':
        this.clearMatchmakingTimer();
        this.queued = false;
        this.callbacks.onStatus('랜덤 매칭을 취소했어요');
        break;
      case 'STATE':
        this.callbacks.onState(msg.state);
        break;
      case 'OPPONENT_LEFT':
        this.callbacks.onOpponentLeft();
        break;
      case 'LOGGED_OUT':
      case 'UNLINKED': {
        this.clearMatchmakingTimer();
        clearIdentity();
        this.roomId = null;
        this.side = null;
        this.queued = false;
        const message =
          msg.message ??
          (msg.type === 'UNLINKED'
            ? '토스 연결이 해제되어 다시 로그인해야 해요'
            : '로그아웃되었어요');
        if (this.callbacks.onLoggedOut) this.callbacks.onLoggedOut(message);
        else this.callbacks.onError(message);
        break;
      }
      case 'ERROR':
        this.clearMatchmakingTimer();
        this.queued = false;
        this.callbacks.onError(msg.message);
        break;
    }
  }
}
