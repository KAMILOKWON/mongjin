import { create } from 'zustand';
import type { GameResult, Move, Player } from '../../../packages/game-core/src';
import type { AiDifficulty, HumanColorChoice, GhostTape } from '../../../packages/game-data/src';
import { GameSession, type PlayMode, type SessionResult, type SessionSnapshot } from './game/engine';
import { MobileProfileStore } from './storage';
import {
  MobileOnlineClient,
  type OnlineMatchReason,
  type OpponentProfile,
  type PlayerProfile,
} from './online';

export type AppRoute = 'home' | 'setup' | 'match' | 'game' | 'tutorial' | 'profile' | 'friend';

interface AppStore {
  route: AppRoute;
  profileName: string;
  profile: ReturnType<MobileProfileStore['profile']>;
  onlineProfile: PlayerProfile | null;
  session: GameSession | null;
  snapshot: SessionSnapshot | null;
  matchStatus: string;
  matchFoundName: string | null;
  friendRoomId: string | null;
  friendStatus: string;
  toast: string | null;
  hydrate: () => Promise<void>;
  openProfile: () => void;
  openAISetup: () => void;
  openLocal: () => void;
  openTutorial: () => void;
  openFriend: () => void;
  openAI: (difficulty: AiDifficulty, color: HumanColorChoice) => void;
  openGhost: (tape: GhostTape) => void;
  startQuickMatch: () => Promise<void>;
  cancelMatch: () => void;
  createFriendRoom: () => Promise<void>;
  joinFriendRoom: (code: string) => Promise<void>;
  cancelFriend: () => void;
  leaveGame: () => Promise<void>;
  saveName: (name: string) => Promise<void>;
  showToast: (message: string) => void;
  updateSnapshot: () => void;
}

const profileStore = new MobileProfileStore();
let online!: MobileOnlineClient;
let matchGeneration = 0;
let friendPending: 'create' | 'join' | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function playerLabel(player: Player): string { return player === 'BLACK' ? '흑' : '백'; }

function makeSession(mode: PlayMode, color: HumanColorChoice, set: (value: Partial<AppStore>) => void, get: () => AppStore): GameSession {
  const session = new GameSession(mode, color);
  session.onOnlineMove = (move: Move) => online.sendMove(move);
  session.onOnlineResign = () => online.sendResign();
  session.subscribe(() => set({ snapshot: session.getSnapshot() }));
  set({ session, snapshot: session.getSnapshot(), route: mode.kind === 'tutorial' ? 'tutorial' : 'game' });
  session.start();
  return session;
}

export const useAppStore = create<AppStore>((set, get) => {
  online = new MobileOnlineClient({
    onState: (state) => get().session?.applyServerState(state),
    onJoined: (roomId, side) => {
      get().session?.bindOnlineSide(side);
      if (friendPending) {
        set({
          friendRoomId: friendPending === 'create' ? roomId : null,
          friendStatus: friendPending === 'create' ? '상대가 입장하면 대국이 시작됩니다' : '상대를 기다리는 중',
        });
        return;
      }
      set({ matchStatus: `${playerLabel(side)} · 상대를 기다리는 중` });
    },
    onMatchFound: (_roomId, side, opponent, state) => {
      const matchKind = friendPending ? 'friend' : 'random';
      friendPending = null;
      set({ matchFoundName: opponent.name, matchStatus: `${opponent.name} 님과 매칭됐어요 · ${playerLabel(side)}`, friendRoomId: null, friendStatus: '' });
      const session = makeSession({ kind: 'online', opponentName: opponent.name, opponentRating: opponent.rating, isBot: false, matchKind }, 'BLACK', set, get);
      session.bindOnlineSide(side);
      session.applyServerState(state);
    },
    onMatchResult: (winner, reason) => get().session?.applyServerResult(winner, reason as SessionResult['reason']),
    onProfile: async (remoteProfile) => {
      const onlineProfile = await profileStore.mergeOnlineProfile(remoteProfile);
      let localProfile = profileStore.profile();

      // Migrate an existing server nickname into the local source of truth on
      // the first fixed-version launch. Afterwards the local name survives
      // server restarts and is pushed to a replacement server identity.
      if (localProfile.name === '나그네') {
        await profileStore.updateName(remoteProfile.name);
        localProfile = profileStore.profile();
      }

      set({ profile: localProfile, onlineProfile, profileName: localProfile.name });
      if (online.connected && localProfile.name !== remoteProfile.name) {
        await online.updateProfile(localProfile.name);
      }
    },
    onOpponentLeft: () => {
      get().showToast('상대가 연결을 끊었습니다');
      void get().leaveGame();
    },
    onMatchmakingTimeout: () => {
      online.disconnect();
      const tape = profileStore.pickChallenge();
      if (!tape) { set({ route: 'home', matchStatus: '', toast: '대국할 상대를 찾지 못했어요' }); return; }
      set({ matchFoundName: tape.ownerName, matchStatus: `${tape.ownerName} 님과 대국해요 · ${playerLabel(tape.side === 'BLACK' ? 'WHITE' : 'BLACK')}` });
      const generation = matchGeneration;
      setTimeout(() => { if (generation === matchGeneration) get().openGhost(tape); }, 500);
    },
    onError: (message) => {
      // 대국이 이미 끝난 뒤 오는 서버 오류(예: 구버전 서버가 RESIGN을 알지 못하는 경우)는 결과 화면을 방해하지 않는다
      if (get().snapshot?.result) return;
      if (friendPending && !get().friendRoomId) {
        friendPending = null;
        set({ friendStatus: '', toast: message });
        return;
      }
      set({ toast: message });
    },
    onStatus: (message) => set({ matchStatus: message }),
  });

  return {
    route: 'home',
    profileName: '나그네',
    profile: profileStore.profile(),
    onlineProfile: null,
    session: null,
    snapshot: null,
    matchStatus: '',
    matchFoundName: null,
    friendRoomId: null,
    friendStatus: '',
    toast: null,
    hydrate: async () => {
      await profileStore.hydrate();
      set({
        profile: profileStore.profile(),
        profileName: profileStore.profile().name,
        onlineProfile: profileStore.onlineProfile(),
      });
      void online.getProfile().catch(() => undefined);
    },
    openProfile: () => set({ route: 'profile' }),
    openAISetup: () => set({ route: 'setup' }),
    openLocal: () => makeSession({ kind: 'local' }, 'BLACK', set, get),
    openTutorial: () => makeSession({ kind: 'tutorial' }, 'BLACK', set, get),
    openFriend: () => set({ route: 'friend', friendRoomId: null, friendStatus: '' }),
    openAI: (difficulty, color) => makeSession({ kind: 'ai', difficulty }, color, set, get),
    openGhost: (tape) => makeSession({ kind: 'ghost', tape }, 'BLACK', set, get),
    startQuickMatch: async () => {
      matchGeneration += 1;
      set({ route: 'match', matchFoundName: null, matchStatus: '상대를 찾는 중…' });
      const generation = matchGeneration;
      try {
        await online.connect();
        if (generation !== matchGeneration) return;
        await online.startMatchmaking();
      } catch {
        online.disconnect();
        const tape = profileStore.pickChallenge();
        if (generation !== matchGeneration || !tape) { set({ route: 'home', toast: '대국할 상대를 찾지 못했어요' }); return; }
        set({ matchFoundName: tape.ownerName, matchStatus: `${tape.ownerName} 님과 대국해요` });
        setTimeout(() => { if (generation === matchGeneration) get().openGhost(tape); }, 500);
      }
    },
    cancelMatch: () => {
      matchGeneration += 1;
      online.cancelMatchmaking(); online.disconnect();
      set({ route: 'home', matchStatus: '', matchFoundName: null });
    },
    createFriendRoom: async () => {
      friendPending = 'create';
      set({ friendRoomId: null, friendStatus: '서버 연결 중…' });
      try {
        await online.createRoom();
      } catch {
        friendPending = null;
        online.disconnect();
        set({ friendStatus: '', toast: '서버에 연결하지 못했어요' });
      }
    },
    joinFriendRoom: async (code) => {
      const roomId = code.trim().toUpperCase();
      if (roomId.length !== 6) { set({ toast: '6자리 입장코드를 입력해 주세요' }); return; }
      friendPending = 'join';
      set({ friendRoomId: null, friendStatus: '입장하는 중…' });
      try {
        await online.joinRoom(roomId);
      } catch {
        friendPending = null;
        online.disconnect();
        set({ friendStatus: '', toast: '서버에 연결하지 못했어요' });
      }
    },
    cancelFriend: () => {
      friendPending = null;
      online.disconnect();
      set({ route: 'home', friendRoomId: null, friendStatus: '' });
    },
    leaveGame: async () => {
      const { session, snapshot } = get();
      if (session && snapshot?.result && snapshot.mode.kind === 'ghost') {
        const tape = session.makeGhostFromResult(profileStore.profile().name, profileStore.profile().rating);
        try {
          await profileStore.recordMatch(snapshot.result.winner === snapshot.humanSide, snapshot.mode.tape.ownerRating, tape);
          set({ profile: profileStore.profile() });
        } catch {
          get().showToast('전적을 기기에 저장하지 못했습니다');
        }
      }
      if (snapshot?.mode.kind === 'online') online.disconnect();
      friendPending = null;
      set({ route: 'home', session: null, snapshot: null, matchStatus: '', matchFoundName: null, friendRoomId: null, friendStatus: '' });
    },
    saveName: async (name) => {
      const trimmed = name.trim();
      if (trimmed.length < 2 || trimmed.length > 12) { get().showToast('닉네임은 2~12자로 적어 주세요'); return; }
      try {
        await profileStore.updateName(trimmed);
      } catch {
        get().showToast('닉네임을 기기에 저장하지 못했습니다');
        return;
      }
      set({ profile: profileStore.profile(), profileName: trimmed });
      if (online.connected) void online.updateProfile(trimmed);
      get().showToast('닉네임을 저장했어요');
    },
    showToast: (message) => {
      if (toastTimer) clearTimeout(toastTimer);
      set({ toast: message });
      toastTimer = setTimeout(() => set({ toast: null }), 2200);
    },
    updateSnapshot: () => set((state) => state.session ? { snapshot: state.session.getSnapshot() } : {}),
  };
});

export interface VisibleProfile {
  name: string;
  rating: number;
  wins: number;
  losses: number;
  winRate: number;
}

// 온라인 전적(서버)과 로컬 전적(고스트 대국)은 서로 disjoint하게 기록되므로
// 표시값은 두 소스를 병합한다. Elo는 둘 다 1200에서 시작하므로 델타를 합산한다.
export function selectVisibleProfile(local: ReturnType<MobileProfileStore['profile']>, online: PlayerProfile | null): VisibleProfile {
  const wins = local.wins + (online?.wins ?? 0);
  const losses = local.losses + (online?.losses ?? 0);
  const games = wins + losses;
  return {
    name: local.name,
    rating: local.rating + (online?.rating ?? 1200) - 1200,
    wins,
    losses,
    winRate: games ? Math.round((wins / games) * 100) : 0,
  };
}

export function resultCopy(result: SessionResult, snapshot: SessionSnapshot): string {
  const quick = snapshot.mode.kind === 'ghost' || snapshot.mode.kind === 'online';
  const won = quick && result.winner === snapshot.humanSide;
  switch (result.reason) {
    case 'forfeit': return won ? '상대가 항복했습니다' : '항복했습니다';
    case 'timeout': return won ? '상대가 시간 안에 두지 못했습니다' : '1분 안에 두지 못했습니다';
    case 'goal': return quick ? (won ? '왕이 목적지에 도착했습니다' : '상대 왕이 목적지에 도착했습니다') : '왕이 목적지에 도착했습니다';
    case 'capture': return quick ? (won ? '상대 왕을 잡았습니다' : '왕이 잡혔습니다') : '왕을 잡아 이겼습니다';
    case 'surround': return quick ? (won ? '상대 왕을 포위했습니다' : '왕이 포위되었습니다') : '왕을 포위해 이겼습니다';
    case 'no-moves': return quick ? (won ? '상대가 둘 수 없었습니다' : '둘 수 있는 수가 없었습니다') : '둘 수 있는 수가 없었습니다';
  }
}
