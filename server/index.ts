import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { GameState, Move, Player } from '../src/core/types';
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState, legalMoves, opponent } from '../src/core/rules';
import { applyMove } from '../src/core/apply';
import { getResult, type WinReason } from '../src/core/result';
import { calculateEloRank } from '../src/profile/eloRanking';
import { isTossLoginConfigured, loginWithToss, verifyCallbackBasicAuth, TossApiError } from './tossAuth';
import {
  createProfileRepository,
  loadProfilesForMigration,
  type MatchPlatform,
  type RecordedMatchEvent,
  type StoredProfile,
} from './profileRepository';
import { buildLeaderboard } from './leaderboard';
import { validateLegacyProfileClaim } from './legacyProfileMigration';
import {
  chooseOfficialBotMove,
  createRankedBot,
  officialBotMoveDelayMs,
  type OfficialBot,
} from './officialBot';
import { ensureRankedBots, selectRankedBot, isRankedBotId } from './rankedBots';
import { inferMatchPlatform } from './matchAnalytics';
import { hasPlayerTakenTurn } from './matchLifecycle';
import { createGameRecordStore, GameRecorder, RECORD_RULES_VERSION, type GameRecord } from './gameRecords';
import { backfillFirstMoves } from './firstMove';
import type { TournamentClient } from './tournament';
import { TournamentRegistry } from './tournamentRegistry';
import { CommunityService } from './community';
import { createCommunityStore } from './communityStore';
import { createCommunityHandler } from './communityHttp';
import { NotificationDelivery } from './notificationDelivery';
import { WaitingNotifications, parseWaitingDestination } from './waitingNotifications';
import { createWaitingHandler } from './waitingHttp';
import { TournamentTelemetry } from './tournamentTelemetry';
import { createTournamentAdminHandler } from './tournamentAdminHttp';
import { TournamentScheduler } from './tournamentScheduler';
import { createMandakoHandler } from './mandako';
import { PRACTICE_BOT_VERSION } from './practiceBot';
import { createLazyFeedbackHandler } from './feedback';
import { createFeedbackStore } from './feedbackStore';
import { isTournamentMessageType, TOURNAMENT_PRACTICE_MOVE_PATH, TOURNAMENT_STATUS_PATH } from '../src/net/tournamentProtocol';

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? '0.0.0.0';
const PROFILE_DATA_FILE = process.env.MONGJIN_PROFILE_DATA_FILE ?? join(process.cwd(), 'data', 'profiles.json');
const config = { ...DEFAULT_CONFIG };

type MatchReason = WinReason | 'forfeit' | 'timeout';

function envMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** 연결이 끊긴 이용자의 자리를 이 시간 동안 유지한다. 돌아오지 않으면 기권으로 끝낸다. */
const RECONNECT_GRACE_MS = envMs(process.env.MONGJIN_RECONNECT_GRACE_MS, 60_000);
/** 빠른 대전(사람·봇)의 한 수 제한 시간. 서버가 재고 서버가 판정한다. */
const MOVE_TIME_MS = envMs(process.env.MONGJIN_MOVE_TIME_MS, 60_000);
/** 재접속했을 때 이미 끝난 대국의 결과를 알려 주기 위해 보관하는 시간 */
const RECENT_RESULT_TTL_MS = 10 * 60_000;
/** 클라이언트가 HELLO로 알리는 기능. 구버전 클라이언트는 아무것도 보내지 않는다. */
type ClientFeature = 'resume' | 'server-clock';

interface PublicProfile {
  playerId: string;
  name: string;
  wins: number;
  losses: number;
  winRate: number;
  rating: number;
  rank: number;
  totalPlayers: number;
  legacyMigrationComplete: boolean;
  hasPlayedMove: boolean;
}

interface Room {
  id: string;
  matchId: string;
  kind: 'friend' | 'random' | 'bot';
  state: GameState;
  black: WebSocket | null;
  white: WebSocket | null;
  blackPlayerId: string | null;
  whitePlayerId: string | null;
  blackPlatform: MatchPlatform;
  whitePlatform: MatchPlatform;
  bot?: OfficialBot;
  finished: boolean;
  pendingMove?: boolean;
  gameRecord?: GameRecord;
  /** 연결이 끊겨 재접속을 기다리는 진영별 타이머 */
  graceTimers?: Partial<Record<Player, ReturnType<typeof setTimeout>>>;
  /** 현재 차례의 서버 기준 마감 시각(ms). 시계가 없는 차례면 null */
  moveDeadline?: number | null;
  moveTimer?: ReturnType<typeof setTimeout>;
}

interface ClientSession {
  playerId: string | null;
  credentialToken: string | null;
  roomId: string | null;
  platform: MatchPlatform;
  features: Set<ClientFeature>;
  lang?: string;
}

/** 끝난 친구 대전의 재대결 신청. 두 사람이 모두 원하면 흑백을 바꿔 새 판을 연다. */
interface RematchOffer {
  roomId: string;
  sockets: Record<Player, WebSocket>;
  playerIds: Record<Player, string>;
  requested: Set<Player>;
  timer: ReturnType<typeof setTimeout>;
}

interface RecentResult {
  roomId: string;
  winner: Player;
  reason: MatchReason;
  at: number;
}

const rooms = new Map<string, Room>();
const sessions = new Map<WebSocket, ClientSession>();
const matchmakingQueue: WebSocket[] = [];
const pendingBotMatches = new Map<WebSocket, symbol>();
const recentResults = new Map<string, RecentResult>();
const rematchOffers = new Map<string, RematchOffer>();
const REMATCH_OFFER_TTL_MS = 2 * 60_000;
// 중도 이탈을 포함한 시작 기록은 프로세스 안에서만 유지한다. 재시작 후에는 완료 기록으로 다시 채운다.
const recentBotIdsByPlayer = new Map<string, string[]>();
const RECENT_BOT_LIMIT = 5;
const RECENT_BOT_QUERY_TIMEOUT_MS = 500;
const profileRepository = await createProfileRepository(PROFILE_DATA_FILE);
const gameRecordStore = await createGameRecordStore(join(dirname(PROFILE_DATA_FILE), 'game-records'));
const handleFeedback = createLazyFeedbackHandler({ createStore: createFeedbackStore });
const gameRecorder = new GameRecorder(gameRecordStore, (error) => console.error('[records] 기보 저장 실패:', error));
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
loadedProfiles = await ensureRankedBots(profileRepository);
const backfilledFirstMoves = await backfillFirstMoves(profileRepository, gameRecordStore);
if (backfilledFirstMoves) loadedProfiles = await profileRepository.loadProfiles();
console.log(`[profiles] 첫 착수 기록 ${backfilledFirstMoves}명 복원`);
const profiles = new Map(loadedProfiles.map((profile) => [profile.playerId, profile]));

const community = new CommunityService(await createCommunityStore(
  process.env.MONGJIN_COMMUNITY_DATA_FILE ?? join(dirname(PROFILE_DATA_FILE), 'community.json'),
));
const waitingNotifications = new WaitingNotifications(community.store);
await waitingNotifications.recover();
const tournament = new TournamentRegistry(community, join(dirname(PROFILE_DATA_FILE), 'tournaments'), isPlayerInNormalPlay, process.env, {
  canBackgroundWait: (playerId, tournamentId, destination) => {
    const parsed = parseWaitingDestination(destination);
    return parsed ? waitingNotifications.canBackgroundWait(playerId, tournamentId, parsed) : false;
  },
  onBackgroundChange: change => waitingNotifications.update(change),
});
await tournament.initialize();
const authorizeCommunity = (playerId: string, token: string): boolean => {
  const profile = profiles.get(playerId);
  return Boolean(profile && !profile.unlinkedAt && !isRankedBotId(playerId) && profile.token === token);
};
const handleCommunity = createCommunityHandler(community, authorizeCommunity);
const handleWaiting = createWaitingHandler(waitingNotifications, tournament, authorizeCommunity);
const telemetry = new TournamentTelemetry(community);
const tournamentScheduler = new TournamentScheduler(community, tournament, telemetry,
  async () => (await profileRepository.firstMoveHistory()).events);
await tournamentScheduler.initialize();
const handleTournamentAdmin = createTournamentAdminHandler(
  tournament, community, telemetry, authorizeCommunity,
  async () => (await profileRepository.firstMoveHistory()).events,
  tournamentScheduler,
);
const notificationDelivery = new NotificationDelivery(community, id => {
  const profile = profiles.get(id);
  return profile?.unlinkedAt ? undefined : profile?.tossUserKey;
});
const tournamentClients = new WeakMap<WebSocket, TournamentClient>();
const loopbackSockets = new WeakSet<WebSocket>();
const handleMandako = createMandakoHandler({
  authorize: (playerId: string, token: string) => {
    const profile = profiles.get(playerId);
    return Boolean(profile && !isRankedBotId(profile.playerId) && !profile.unlinkedAt &&
      profile.token === token && tournament.canPractice(profile.playerId));
  },
  beforePractice: (playerId, practiceId, moves) => community.beforePractice(playerId, practiceId, moves),
  savePracticeMove: (playerId, practiceId, moves, move) => community.savePracticeMove(
    playerId, practiceId, moves, move, PRACTICE_BOT_VERSION,
  ),
});

function tournamentClientFor(ws: WebSocket): TournamentClient {
  let client = tournamentClients.get(ws);
  if (!client) {
    client = { send: message => send(ws, message) };
    tournamentClients.set(ws, client);
  }
  return client;
}

function isPlayerInNormalPlay(playerId: string): boolean {
  for (const [socket, session] of sessions) {
    if (session.playerId !== playerId) continue;
    if (session.roomId || matchmakingQueue.includes(socket) || pendingBotMatches.has(socket)) return true;
  }
  // A seat held for reconnect must remain exclusive until its grace period ends.
  for (const room of rooms.values()) {
    if (!room.finished && (room.blackPlayerId === playerId || room.whitePlayerId === playerId)) return true;
  }
  return false;
}

function rememberProfile(profile: StoredProfile) {
  profiles.set(profile.playerId, { ...profile,
    hasPlayedMove: Boolean(profile.hasPlayedMove || profiles.get(profile.playerId)?.hasPlayedMove) });
}

async function markFirstMove(playerId: string) {
  if (profiles.get(playerId)?.hasPlayedMove) return;
  await profileRepository.markFirstMove(playerId);
  profiles.set(playerId, { ...profiles.get(playerId)!, hasPlayedMove: true });
  sendProfileToPlayer(playerId);
}

function makeId(bytes = 12): string {
  return randomBytes(bytes).toString('hex');
}

function makeRoomId(): string {
  return randomBytes(3).toString('hex').toUpperCase();
}

/** 새 프로필의 기본 닉네임 접두어. HELLO가 언어를 알리지 않은 구버전 클라이언트는 한국어다. */
const DEFAULT_NAME_PREFIX: Record<string, string> = { ko: '나그네', en: 'Wanderer', ja: '旅人', zh: '旅人', 'zh-Hant': '旅人' };

function defaultName(lang?: string): string {
  const prefix = (lang && DEFAULT_NAME_PREFIX[lang]) || DEFAULT_NAME_PREFIX.ko;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = `${prefix}${Math.floor(1000 + Math.random() * 9000)}`;
    if (![...profiles.values()].some((profile) => profile.name === candidate)) return candidate;
  }
  return `${prefix}${randomBytes(3).toString('hex')}`;
}

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 12) return null;
  if (/[<>\u0000-\u001f]/.test(name)) return null;
  return name;
}

function publicProfile(playerId: string): PublicProfile {
  const profile = profiles.get(playerId)!;
  const games = profile.wins + profile.losses;
  return {
    playerId,
    name: profile.name,
    wins: profile.wins,
    losses: profile.losses,
    winRate: games === 0 ? 0 : Math.round((profile.wins / games) * 1000) / 10,
    rating: profile.rating,
    rank: calculateEloRank(profile.rating, [...profiles.values()].map((candidate) => candidate.rating)),
    // Kept in the wire format for compatibility with already-released clients.
    // Current clients never display the population count.
    totalPlayers: profiles.size,
    legacyMigrationComplete: Boolean(profile.legacyMigratedAt),
    hasPlayedMove: Boolean(profile.hasPlayedMove),
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

function supports(ws: WebSocket, feature: ClientFeature): boolean {
  return sessions.get(ws)?.features.has(feature) ?? false;
}

/** 구버전 클라이언트는 서버 시간패 문구가 없으므로 기권으로 보여 준다. 기록은 그대로 timeout이다. */
function sendMatchResult(ws: WebSocket, winner: Player, reason: MatchReason, playerId: string) {
  const wireReason = reason === 'timeout' && !supports(ws, 'server-clock') ? 'forfeit' : reason;
  send(ws, { type: 'MATCH_RESULT', winner, reason: wireReason, profile: publicProfile(playerId) });
}

function turnTimeLeftMs(room: Room): number | null {
  return room.moveDeadline ? Math.max(0, room.moveDeadline - Date.now()) : null;
}

function broadcastState(room: Room) {
  broadcastRoom(room, { type: 'STATE', state: room.state, turnTimeLeftMs: turnTimeLeftMs(room) });
}

function rememberResult(room: Room, winner: Player, reason: MatchReason) {
  const now = Date.now();
  for (const [id, entry] of recentResults) if (now - entry.at > RECENT_RESULT_TTL_MS) recentResults.delete(id);
  for (const playerId of [room.blackPlayerId, room.whitePlayerId]) {
    if (playerId) recentResults.set(playerId, { roomId: room.id, winner, reason, at: now });
  }
}

function clearRoomTimers(room: Room) {
  if (room.moveTimer) clearTimeout(room.moveTimer);
  room.moveTimer = undefined;
  room.moveDeadline = null;
  for (const timer of Object.values(room.graceTimers ?? {})) clearTimeout(timer);
  room.graceTimers = {};
}

function sendProfileToPlayer(playerId: string) {
  const profile = publicProfile(playerId);
  for (const [ws, session] of sessions) {
    if (session.playerId === playerId) send(ws, { type: 'PROFILE', profile });
  }
}

async function authenticate(ws: WebSocket, playerId?: string, token?: string) {
  const prior = sessions.get(ws);
  if (!prior) return;
  if (prior.playerId && (playerId !== prior.playerId || token !== prior.credentialToken)) {
    send(ws, { type: 'ERROR', message: '계정을 바꾸려면 다시 연결해 주세요' });
    return;
  }
  let profile = playerId && !isRankedBotId(playerId) ? profiles.get(playerId) : undefined;
  if (profile && token && profile.token === token && profile.unlinkedAt) {
    // 토스 연결이 해제된 프로필. 재로그인 전까지 세션을 만들지 않는다.
    send(ws, { type: 'UNLINKED', message: '토스 연결이 해제되어 다시 로그인해야 해요' });
    return;
  }
  if (!profile || !token || profile.token !== token) {
    const now = new Date().toISOString();
    profile = {
      playerId: makeId(),
      token: makeId(24),
      name: defaultName(sessions.get(ws)?.lang),
      wins: 0,
      losses: 0,
      rating: 1200,
      createdAt: now,
      updatedAt: now,
    };
    const saved = await profileRepository.saveProfileMetadata(profile);
    rememberProfile(saved);
  }
  const session = sessions.get(ws)!;
  session.playerId = profile.playerId;
  session.credentialToken = profile.token;
  if (profile.tossUserKey !== undefined) session.platform = 'toss';
  telemetry.connect(ws, profile.playerId, session.platform);
  send(ws, {
    type: 'IDENTITY',
    playerId: profile.playerId,
    token: profile.token,
    profile: publicProfile(profile.playerId),
  });
}

function requirePlayer(ws: WebSocket): string | null {
  const session = sessions.get(ws);
  const profile = session?.playerId ? profiles.get(session.playerId) : undefined;
  if (!session?.playerId || !profile || profile.unlinkedAt || profile.token !== session.credentialToken) {
    send(ws, { type: 'ERROR', message: '프로필 연결을 먼저 완료해 주세요' });
    return null;
  }
  return session.playerId;
}

function isValidMove(state: GameState, move: Move): boolean {
  return legalMoves(state, config).some((candidate) => JSON.stringify(candidate) === JSON.stringify(move));
}

function attachPlayer(room: Room, ws: WebSocket): Player | null {
  const playerId = sessions.get(ws)?.playerId ?? null;
  if (!room.black) {
    room.black = ws;
    room.blackPlayerId = playerId;
    room.blackPlatform = sessions.get(ws)?.platform ?? 'unknown';
    return 'BLACK';
  }
  if (!room.white) {
    room.white = ws;
    room.whitePlayerId = playerId;
    room.whitePlatform = sessions.get(ws)?.platform ?? 'unknown';
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

function recordMatchEvent(event: RecordedMatchEvent) {
  void profileRepository.recordMatchEvent(event).catch((error) => {
    console.error('[analytics] 대국 이벤트 저장에 실패했습니다:', error);
  });
}

function startGameRecord(room: Room) {
  if (room.gameRecord) return;
  const participant = (side: Player) => {
    if (room.bot?.side === side) return { kind: 'bot' as const, rating: room.bot.rating };
    const id = side === 'BLACK' ? room.blackPlayerId : room.whitePlayerId;
    return { kind: 'human' as const, rating: id ? profiles.get(id)?.rating ?? null : null };
  };
  room.gameRecord = {
    schemaVersion: 1, rulesVersion: RECORD_RULES_VERSION, matchId: room.matchId,
    kind: room.kind, startedAt: new Date().toISOString(), status: 'playing',
    players: { BLACK: participant('BLACK'), WHITE: participant('WHITE') },
    config: { ...config }, moves: [], revision: 0,
  };
  void gameRecorder.save(room.gameRecord);
}

function saveGameRecord(room: Room, ending?: { winner?: Player; reason: string }) {
  const record = room.gameRecord;
  if (!record || record.status !== 'playing') return Promise.resolve();
  record.moves = room.state.history;
  record.revision++;
  if (ending) {
    record.status = ending.winner ? 'completed' : 'abandoned';
    record.winner = ending.winner;
    record.reason = ending.reason;
    record.endedAt = new Date().toISOString();
  }
  return gameRecorder.save(record);
}

function recordMatchStarted(room: Room) {
  startGameRecord(room);
  if (room.kind === 'friend') return;
  const occurredAt = new Date().toISOString();
  const opponentKind = room.kind === 'bot' ? 'bot' : 'human';
  const players = room.kind === 'bot'
    ? room.bot?.side === 'BLACK'
      ? [{ playerId: room.whitePlayerId, platform: room.whitePlatform }]
      : [{ playerId: room.blackPlayerId, platform: room.blackPlatform }]
    : [
        { playerId: room.blackPlayerId, platform: room.blackPlatform },
        { playerId: room.whitePlayerId, platform: room.whitePlatform },
      ];
  for (const player of players) {
    if (!player?.playerId) continue;
    recordMatchEvent({
      matchId: room.matchId,
      roomId: room.id,
      playerId: player.playerId,
      matchKind: room.kind,
      opponentKind,
      event: 'started',
      platform: player.platform,
      plyCount: 0,
      occurredAt,
    });
  }
}

function recordMatchCompleted(room: Room, winner: Player, reason: string, occurredAt: string) {
  if (room.kind === 'friend') return;
  const opponentKind = room.kind === 'bot' ? 'bot' : 'human';
  const players = room.kind === 'bot'
    ? room.bot?.side === 'BLACK'
      ? [{ side: 'WHITE' as const, playerId: room.whitePlayerId, platform: room.whitePlatform }]
      : [{ side: 'BLACK' as const, playerId: room.blackPlayerId, platform: room.blackPlatform }]
    : [
        { side: 'BLACK' as const, playerId: room.blackPlayerId, platform: room.blackPlatform },
        { side: 'WHITE' as const, playerId: room.whitePlayerId, platform: room.whitePlatform },
      ];
  for (const player of players) {
    if (!player?.playerId) continue;
    recordMatchEvent({
      matchId: room.matchId,
      roomId: room.id,
      playerId: player.playerId,
      matchKind: room.kind,
      opponentKind,
      event: 'completed',
      platform: player.platform,
      plyCount: room.state.history.length,
      outcome: player.side === winner ? 'win' : 'loss',
      reason,
      occurredAt,
    });
  }
}

function recordMatchAbandoned(room: Room, side: Player, reason: string) {
  if (room.kind === 'friend') return;
  const playerId = side === 'BLACK' ? room.blackPlayerId : room.whitePlayerId;
  if (!playerId) return;
  recordMatchEvent({
    matchId: room.matchId,
    roomId: room.id,
    playerId,
    matchKind: room.kind,
    opponentKind: room.kind === 'bot' ? 'bot' : 'human',
    event: 'abandoned',
    platform: side === 'BLACK' ? room.blackPlatform : room.whitePlatform,
    plyCount: room.state.history.length,
    reason,
    occurredAt: new Date().toISOString(),
  });
}

function releaseFinishedRoom(room: Room) {
  clearRoomTimers(room);
  for (const socket of [room.black, room.white]) {
    if (!socket) continue;
    const session = sessions.get(socket);
    if (session?.roomId === room.id) session.roomId = null;
  }
  if (rooms.get(room.id) === room) rooms.delete(room.id);
}

async function finishRandomMatch(
  room: Room,
  winner: Player,
  reason: MatchReason,
  analyticsReason: string = reason,
) {
  if (room.kind !== 'random' || room.finished) return;
  const winnerId = winner === 'BLACK' ? room.blackPlayerId : room.whitePlayerId;
  const loserId = winner === 'BLACK' ? room.whitePlayerId : room.blackPlayerId;
  if (!winnerId || !loserId) return;
  room.finished = true;
  clearRoomTimers(room);
  rememberResult(room, winner, reason);
  const completedAt = new Date().toISOString();
  const recordSaved = saveGameRecord(room, { winner, reason: analyticsReason });
  try {
    const result = await profileRepository.recordMatch({
      matchId: room.matchId,
      roomId: room.id,
      winnerId,
      loserId,
      reason,
      completedAt,
    });
    if (result.recorded && result.winner && result.loser) {
      rememberProfile(result.winner);
      rememberProfile(result.loser);
    }
    if (room.black) sendMatchResult(room.black, winner, reason, room.blackPlayerId!);
    if (room.white) sendMatchResult(room.white, winner, reason, room.whitePlayerId!);
    sendProfileToPlayer(winnerId);
    sendProfileToPlayer(loserId);
  } catch (error) {
    console.error('[profiles] 경기 결과 저장에 실패했습니다:', error);
    broadcastRoom(room, { type: 'ERROR', message: '경기 결과를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요' });
  } finally {
    recordMatchCompleted(room, winner, analyticsReason, completedAt);
    releaseFinishedRoom(room);
    await recordSaved;
  }
}

async function finishBotMatch(
  room: Room,
  winner: Player,
  reason: MatchReason,
  analyticsReason: string = reason,
) {
  if (room.kind !== 'bot' || room.finished || !room.bot) return;
  const playerSide = opponent(room.bot.side);
  const playerId = playerSide === 'BLACK' ? room.blackPlayerId : room.whitePlayerId;
  const currentSocket = () => playerSide === 'BLACK' ? room.black : room.white;
  if (!playerId) return;
  room.finished = true;
  clearRoomTimers(room);
  rememberResult(room, winner, reason);
  const completedAt = new Date().toISOString();
  const recordSaved = saveGameRecord(room, { winner, reason: analyticsReason });
  try {
    const result = await profileRepository.recordBotMatch({
      matchId: room.matchId,
      roomId: room.id,
      playerId,
      playerWon: winner === playerSide,
      botPlayerId: room.bot.playerId,
      learningGame: { moves: room.state.history, config, side: room.bot.side, winner, reason: analyticsReason },
      botName: room.bot.name,
      botRating: room.bot.rating,
      botSearchRating: room.bot.searchRating,
      difficultyBand: room.bot.difficultyBand,
      reason,
      completedAt,
    });
    if (result.recorded && result.player) rememberProfile(result.player);
    if (result.recorded && result.bot) rememberProfile(result.bot);
    const playerSocket = currentSocket();
    if (playerSocket) sendMatchResult(playerSocket, winner, reason, playerId);
    sendProfileToPlayer(playerId);
  } catch (error) {
    console.error('[profiles] 공식 봇 경기 결과 저장에 실패했습니다:', error);
    const playerSocket = currentSocket();
    if (playerSocket) {
      send(playerSocket, { type: 'ERROR', message: '경기 결과를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요' });
    }
  } finally {
    recordMatchCompleted(room, winner, analyticsReason, completedAt);
    releaseFinishedRoom(room);
    await recordSaved;
  }
}

/** Friend games share the normal result UI without changing ranked records. */
async function finishFriendMatch(room: Room, winner: Player, reason: MatchReason, recordReason: string = reason) {
  if (room.kind !== 'friend' || room.finished || !room.blackPlayerId || !room.whitePlayerId) return;
  room.finished = true;
  clearRoomTimers(room);
  rememberResult(room, winner, reason);
  const saved = saveGameRecord(room, { winner, reason: recordReason });
  if (room.black) sendMatchResult(room.black, winner, reason, room.blackPlayerId);
  if (room.white) sendMatchResult(room.white, winner, reason, room.whitePlayerId);
  if (room.black && room.white) openRematchOffer(room, room.black, room.white);
  releaseFinishedRoom(room);
  await saved;
}

function openRematchOffer(room: Room, black: WebSocket, white: WebSocket) {
  const offer: RematchOffer = {
    roomId: room.id,
    sockets: { BLACK: black, WHITE: white },
    playerIds: { BLACK: room.blackPlayerId!, WHITE: room.whitePlayerId! },
    requested: new Set(),
    timer: setTimeout(() => rematchOffers.delete(room.id), REMATCH_OFFER_TTL_MS),
  };
  rematchOffers.set(room.id, offer);
}

/** 한쪽이 나가거나 다른 대국을 시작하면 남은 사람에게 재대결이 불가능하다고 알린다. */
function cancelRematchOffers(ws: WebSocket) {
  for (const [roomId, offer] of rematchOffers) {
    const side = offer.sockets.BLACK === ws ? 'BLACK' : offer.sockets.WHITE === ws ? 'WHITE' : null;
    if (!side) continue;
    clearTimeout(offer.timer);
    rematchOffers.delete(roomId);
    send(offer.sockets[opponent(side)], { type: 'REMATCH_UNAVAILABLE', roomId });
  }
}

function requestRematch(ws: WebSocket, roomId: string) {
  const offer = rematchOffers.get(roomId);
  const side = offer ? (offer.sockets.BLACK === ws ? 'BLACK' : offer.sockets.WHITE === ws ? 'WHITE' : null) : null;
  const other = offer && side ? offer.sockets[opponent(side)] : null;
  if (!offer || !side || !other || other.readyState !== other.OPEN || sessions.get(other)?.roomId || sessions.get(ws)?.roomId) {
    if (offer) { clearTimeout(offer.timer); rematchOffers.delete(roomId); }
    send(ws, { type: 'REMATCH_UNAVAILABLE', roomId });
    return;
  }
  offer.requested.add(side);
  if (offer.requested.size < 2) {
    send(other, { type: 'REMATCH_REQUESTED', roomId });
    return;
  }
  clearTimeout(offer.timer);
  rematchOffers.delete(roomId);
  // 재대결은 흑백을 바꿔 새 방에서 시작한다.
  const black = offer.sockets.WHITE;
  const white = offer.sockets.BLACK;
  const id = makeRoomId();
  const room: Room = {
    id,
    matchId: makeId(16),
    kind: 'friend',
    state: initialState(config),
    black,
    white,
    blackPlayerId: offer.playerIds.WHITE,
    whitePlayerId: offer.playerIds.BLACK,
    blackPlatform: sessions.get(black)?.platform ?? 'unknown',
    whitePlatform: sessions.get(white)?.platform ?? 'unknown',
    finished: false,
  };
  rooms.set(id, room);
  sessions.get(black)!.roomId = id;
  sessions.get(white)!.roomId = id;
  startGameRecord(room);
  send(black, { type: 'MATCH_FOUND', roomId: id, side: 'BLACK', matchKind: 'friend', state: room.state, opponent: opponentSummary(room.whitePlayerId!) });
  send(white, { type: 'MATCH_FOUND', roomId: id, side: 'WHITE', matchKind: 'friend', state: room.state, opponent: opponentSummary(room.blackPlayerId!) });
}

async function finishRoom(room: Room, winner: Player, reason: MatchReason, analyticsReason: string = reason) {
  if (room.kind === 'random') await finishRandomMatch(room, winner, reason, analyticsReason);
  else if (room.kind === 'bot') await finishBotMatch(room, winner, reason, analyticsReason);
  else await finishFriendMatch(room, winner, reason, analyticsReason);
}

/** 사람이 둘 차례일 때만 시계를 건다. 친구 대전은 기존처럼 시간 제한이 없다. */
function clockedSide(room: Room): Player | null {
  if (room.finished || room.kind === 'friend') return null;
  if (room.bot && room.state.turn === room.bot.side) return null;
  return room.state.turn;
}

function startMoveClock(room: Room) {
  if (room.moveTimer) clearTimeout(room.moveTimer);
  room.moveTimer = undefined;
  room.moveDeadline = null;
  const side = clockedSide(room);
  if (!side) return;
  const ply = room.state.history.length;
  room.moveDeadline = Date.now() + MOVE_TIME_MS;
  room.moveTimer = setTimeout(() => {
    if (rooms.get(room.id) !== room || room.finished) return;
    if (room.state.turn !== side || room.state.history.length !== ply || room.pendingMove) return;
    void finishRoom(room, opponent(side), 'timeout', 'timeout');
  }, MOVE_TIME_MS);
}

function isLiveGame(room: Room): boolean {
  if (room.finished) return false;
  if (room.kind === 'friend') return Boolean(room.blackPlayerId && room.whitePlayerId);
  return true;
}

/** 자리를 떠난 쪽을 최종 이탈로 처리한다. 재접속 대기가 끝났거나 이용자가 다른 대국을 시작한 경우다. */
function abandonSeat(room: Room, side: Player) {
  const timer = room.graceTimers?.[side];
  if (timer) clearTimeout(timer);
  if (room.graceTimers) delete room.graceTimers[side];
  if (room.finished || rooms.get(room.id) !== room) return;
  if (room.kind !== 'friend') recordMatchAbandoned(room, side, 'disconnect');
  if (room.kind === 'random') {
    // MATCH_FOUND starts the game; a first move is not required to forfeit.
    void finishRandomMatch(room, opponent(side), 'forfeit', 'disconnect');
  } else if (room.kind === 'friend' && room.blackPlayerId && room.whitePlayerId) {
    void finishFriendMatch(room, opponent(side), 'forfeit', 'disconnect');
  } else if (room.bot && hasPlayerTakenTurn(room.state.history.length, side)) {
    void finishBotMatch(room, room.bot.side, 'forfeit', 'disconnect');
  } else {
    // An untouched solo bot game has no human opponent awaiting a result.
    room.finished = true;
    void saveGameRecord(room, { reason: 'disconnect' });
    releaseFinishedRoom(room);
  }
}

function startGrace(room: Room, side: Player) {
  room.graceTimers ??= {};
  const previous = room.graceTimers[side];
  if (previous) clearTimeout(previous);
  room.graceTimers[side] = setTimeout(() => abandonSeat(room, side), RECONNECT_GRACE_MS);
}

/** 재접속을 기다리는 자리를 가진 이용자가 새 대국을 시작하면 이전 대국은 바로 이탈로 끝낸다. */
function abandonWaitingSeats(playerId: string) {
  for (const room of [...rooms.values()]) {
    if (room.finished) continue;
    for (const side of ['BLACK', 'WHITE'] as const) {
      const seatId = side === 'BLACK' ? room.blackPlayerId : room.whitePlayerId;
      const socket = side === 'BLACK' ? room.black : room.white;
      if (seatId === playerId && !socket && room.graceTimers?.[side]) abandonSeat(room, side);
    }
  }
}

function findResumableRoom(playerId: string, roomId?: string): { room: Room; side: Player } | null {
  const candidates = roomId ? [rooms.get(roomId)].filter((room): room is Room => Boolean(room)) : [...rooms.values()];
  for (const room of candidates) {
    if (!isLiveGame(room)) continue;
    if (room.blackPlayerId === playerId) return { room, side: 'BLACK' };
    if (room.whitePlayerId === playerId) return { room, side: 'WHITE' };
  }
  return null;
}

function opponentFor(room: Room, side: Player) {
  if (room.bot) return { name: room.bot.name, rating: room.bot.rating, isBot: true };
  const opponentId = side === 'BLACK' ? room.whitePlayerId : room.blackPlayerId;
  return opponentId ? opponentSummary(opponentId) : null;
}

function resumeSeat(ws: WebSocket, playerId: string, roomId?: string) {
  const session = sessions.get(ws)!;
  const found = findResumableRoom(playerId, roomId);
  if (!found || (session.roomId && session.roomId !== found.room.id)) {
    const recent = recentResults.get(playerId);
    const fresh = recent && Date.now() - recent.at <= RECENT_RESULT_TTL_MS && (!roomId || recent.roomId === roomId);
    send(ws, {
      type: 'RESUME_FAILED',
      roomId: roomId ?? null,
      result: fresh ? { roomId: recent.roomId, winner: recent.winner, reason: recent.reason } : null,
      profile: publicProfile(playerId),
    });
    return;
  }
  const { room, side } = found;
  const previous = side === 'BLACK' ? room.black : room.white;
  if (previous && previous !== ws) {
    // 앱이 잠든 사이 서버가 아직 끊김을 모르는 예전 소켓. 새 연결이 자리를 넘겨받는다.
    const previousSession = sessions.get(previous);
    if (previousSession?.roomId === room.id) previousSession.roomId = null;
    previous.terminate();
  }
  const timer = room.graceTimers?.[side];
  if (timer) clearTimeout(timer);
  if (room.graceTimers) delete room.graceTimers[side];
  pendingBotMatches.delete(ws);
  removeFromQueue(ws);
  if (side === 'BLACK') room.black = ws;
  else room.white = ws;
  session.roomId = room.id;
  send(ws, {
    type: 'RESUMED',
    roomId: room.id,
    side,
    // 봇 대국도 이용자에게는 빠른 대전으로 보인다.
    matchKind: room.kind === 'friend' ? 'friend' : 'random',
    state: room.state,
    opponent: opponentFor(room, side),
    turnTimeLeftMs: turnTimeLeftMs(room),
  });
  const other = side === 'BLACK' ? room.white : room.black;
  if (other) send(other, { type: 'OPPONENT_RECONNECTED', turnTimeLeftMs: turnTimeLeftMs(room) });
}

function scheduleBotMove(room: Room) {
  if (room.kind !== 'bot' || room.finished || !room.bot || room.bot.thinking || room.state.turn !== room.bot.side) return;
  room.bot.thinking = true;
  setTimeout(() => {
    void (async () => {
      if (rooms.get(room.id) !== room || room.finished || !room.bot) return;
      const terminal = getResult(room.state, config);
      if (terminal) {
        await finishBotMatch(room, terminal.winner, terminal.reason);
        return;
      }
      const move = chooseOfficialBotMove(room.bot, room.state, config);
      if (!move) {
        const result = getResult(room.state, config);
        if (result) await finishBotMatch(room, result.winner, result.reason);
        return;
      }
      room.state = applyMove(room.state, move);
      void saveGameRecord(room);
      const result = getResult(room.state, config);
      if (!result) startMoveClock(room);
      broadcastState(room);
      if (result) await finishBotMatch(room, result.winner, result.reason);
    })().catch((error) => {
      console.error('[bot] 공식 봇 수 처리에 실패했습니다:', error);
      // A failed opponent must produce a terminal result, never leave a live
      // board with no future move scheduled.
      if (rooms.get(room.id) === room && !room.finished && room.bot) {
        void finishBotMatch(room, opponent(room.bot.side), 'forfeit', 'bot_error');
      }
    }).finally(() => {
      if (room.bot) room.bot.thinking = false;
    });
  }, officialBotMoveDelayMs(room.bot));
}

async function startBotMatch(ws: WebSocket) {
  if (pendingBotMatches.has(ws)) return;
  const request = Symbol('bot-match');
  pendingBotMatches.set(ws, request);
  try {
    const initialPlayerId = sessions.get(ws)?.playerId;
    if (!initialPlayerId) return;
    if (!recentBotIdsByPlayer.has(initialPlayerId)) {
      let persistedRecent: string[] = [];
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        persistedRecent = await Promise.race([
          profileRepository.getRecentBotOpponents(initialPlayerId, RECENT_BOT_LIMIT),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('recent-opponents-timeout')), RECENT_BOT_QUERY_TIMEOUT_MS);
          }),
        ]);
      } catch {
        console.warn('[matchmaking] 최근 봇 상대 조회 실패; 메모리 기록으로 계속합니다');
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      // 같은 프로필의 다른 요청이 먼저 시작 기록을 추가했다면 그 캐시를 덮어쓰지 않는다.
      if (!recentBotIdsByPlayer.has(initialPlayerId)) {
        recentBotIdsByPlayer.set(initialPlayerId, persistedRecent.slice(0, RECENT_BOT_LIMIT));
      }
    }

    if (pendingBotMatches.get(ws) !== request) return;
    const session = sessions.get(ws);
    const profile = profiles.get(initialPlayerId);
    if (
      !session ||
      session.playerId !== initialPlayerId ||
      session.roomId ||
      matchmakingQueue.includes(ws) ||
      !profile ||
      ws.readyState !== ws.OPEN
    ) return;
    const id = makeRoomId();
    const recentBotIds = recentBotIdsByPlayer.get(initialPlayerId) ?? [];
    const botProfile = selectRankedBot(profiles.values(), profile.rating, { recentBotIds });
    const bot = createRankedBot(botProfile);
    recentBotIdsByPlayer.set(initialPlayerId, [botProfile.playerId, ...recentBotIds].slice(0, RECENT_BOT_LIMIT));
    const playerSide = opponent(bot.side);
    const room: Room = {
      id,
      matchId: makeId(16),
      kind: 'bot',
      state: initialState(config),
      black: playerSide === 'BLACK' ? ws : null,
      white: playerSide === 'WHITE' ? ws : null,
      blackPlayerId: playerSide === 'BLACK' ? initialPlayerId : null,
      whitePlayerId: playerSide === 'WHITE' ? initialPlayerId : null,
      blackPlatform: playerSide === 'BLACK' ? session.platform : 'unknown',
      whitePlatform: playerSide === 'WHITE' ? session.platform : 'unknown',
      bot,
      finished: false,
    };
    rooms.set(id, room);
    session.roomId = id;
    recordMatchStarted(room);
    startMoveClock(room);
    send(ws, {
      type: 'MATCH_FOUND',
      roomId: id,
      side: playerSide,
      matchKind: 'random',
      state: room.state,
      opponent: { name: bot.name, rating: bot.rating, isBot: true },
      turnTimeLeftMs: turnTimeLeftMs(room),
    });
    scheduleBotMove(room);
  } finally {
    if (pendingBotMatches.get(ws) === request) pendingBotMatches.delete(ws);
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
    blackPlatform: sessions.get(firstIsBlack ? first : second)?.platform ?? 'unknown',
    whitePlatform: sessions.get(firstIsBlack ? second : first)?.platform ?? 'unknown',
    finished: false,
  };
  rooms.set(id, room);
  sessions.get(first)!.roomId = id;
  sessions.get(second)!.roomId = id;
  recordMatchStarted(room);
  startMoveClock(room);
  send(first, {
    type: 'MATCH_FOUND',
    roomId: id,
    side: firstIsBlack ? 'BLACK' : 'WHITE',
    matchKind: 'random',
    state: room.state,
    opponent: opponentSummary(secondId),
    turnTimeLeftMs: turnTimeLeftMs(room),
  });
  send(second, {
    type: 'MATCH_FOUND',
    roomId: id,
    side: firstIsBlack ? 'WHITE' : 'BLACK',
    matchKind: 'random',
    state: room.state,
    opponent: opponentSummary(firstId),
    turnTimeLeftMs: turnTimeLeftMs(room),
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
  telemetry.disconnect(ws);
  const tournamentClient = tournamentClients.get(ws);
  if (tournamentClient) tournament.detach(tournamentClient);
  cancelRematchOffers(ws);
  pendingBotMatches.delete(ws);
  removeFromQueue(ws);
  const session = sessions.get(ws);
  const room = session?.roomId ? rooms.get(session.roomId) : undefined;
  if (room) {
    const side: Player | null = room.black === ws ? 'BLACK' : room.white === ws ? 'WHITE' : null;
    if (side && isLiveGame(room)) {
      // 모바일은 전화·알림·화면 잠금으로 연결이 자주 끊긴다. 바로 기권시키지 않고 자리를 남긴다.
      if (side === 'BLACK') room.black = null;
      else room.white = null;
      startGrace(room, side);
      const other = side === 'BLACK' ? room.white : room.black;
      if (other) send(other, { type: 'OPPONENT_DISCONNECTED', graceMs: RECONNECT_GRACE_MS });
    } else if (side && !room.finished) {
      // A host waiting alone in a friend room has no opponent awaiting a result.
      room.finished = true;
      void saveGameRecord(room, { reason: 'disconnect' });
      releaseFinishedRoom(room);
    }
    if (room.black === ws) room.black = null;
    if (room.white === ws) room.white = null;
    // Finishing functions retain the other player's session until MATCH_RESULT
    // is delivered and release the room once. Closing again cannot score twice.
  }
  sessions.delete(ws);
}

function parseTossUserKey(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function findProfileByTossUserKey(userKey: number): StoredProfile | undefined {
  for (const profile of profiles.values()) {
    if (profile.tossUserKey === userKey) return profile;
  }
  return undefined;
}

function sendLoggedOutToPlayer(playerId: string, message: string) {
  for (const [ws, session] of sessions) {
    if (session.playerId === playerId) send(ws, { type: 'LOGGED_OUT', message });
  }
}

function setCorsHeaders(res: import('node:http').ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function sendJson(res: import('node:http').ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

const JSON_BODY_LIMIT = 16 * 1024;

function readJsonBody(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > JSON_BODY_LIMIT) {
        reject(new Error('요청 본문이 너무 큽니다'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      } catch {
        reject(new Error('잘못된 JSON 본문입니다'));
      }
    });
    req.on('error', reject);
  });
}

/** 인가 코드를 토스 로그인 세션으로 교환하고 같은 토스 사용자면 항상 같은 프로필을 돌려준다 */
async function handleTossLogin(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
  if (!isTossLoginConfigured()) {
    sendJson(res, 503, { error: 'TOSS_LOGIN_NOT_CONFIGURED' });
    return;
  }
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: 'BAD_REQUEST', message: (error as Error).message });
    return;
  }
  const authorizationCode = typeof body.authorizationCode === 'string' ? body.authorizationCode : '';
  const referrer = typeof body.referrer === 'string' ? body.referrer : '';
  if (!authorizationCode || !referrer) {
    sendJson(res, 400, { error: 'BAD_REQUEST', message: 'authorizationCode와 referrer가 필요합니다' });
    return;
  }
  try {
    const login = await loginWithToss(authorizationCode, referrer);
    const now = new Date();
    const existing = findProfileByTossUserKey(login.userKey);
    let profile: StoredProfile;
    if (!existing) {
      profile = {
        playerId: makeId(),
        token: makeId(24),
        name: cleanName(login.name) ?? defaultName(),
        wins: 0,
        losses: 0,
        rating: 1200,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
    } else {
      profile = { ...existing };
      if (profile.unlinkedAt) {
        // 연결 해제 후 재로그인: 해제 표시를 지우고 토큰을 교체한다.
        delete profile.unlinkedAt;
        profile.token = makeId(24);
      }
    }
    profile.tossUserKey = login.userKey;
    profile.tossAccessToken = login.accessToken;
    profile.tossRefreshToken = login.refreshToken;
    profile.tossTokenExpiresAt = new Date(now.getTime() + login.expiresIn * 1000).toISOString();
    profile.updatedAt = now.toISOString();
    const saved = await profileRepository.saveProfileMetadata(profile);
    rememberProfile(saved);
    sendJson(res, 200, { playerId: profile.playerId, token: profile.token, profile: publicProfile(profile.playerId) });
  } catch (error) {
    const apiError = error as TossApiError;
    console.error('[toss] 로그인 실패:', apiError);
    sendJson(res, 502, {
      error: apiError.errorCode ?? 'TOSS_API_ERROR',
      message: apiError.message ?? '토스 로그인에 실패했습니다',
    });
  }
}

/** 토스 앱에서 로그인 연결을 해제했을 때 오는 콜백 (UNLINK / WITHDRAWAL_TERMS / WITHDRAWAL_TOSS) */
async function handleTossUnlinkCallback(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL) {
  if (!verifyCallbackBasicAuth(req.headers.authorization)) {
    sendJson(res, 401, { error: 'UNAUTHORIZED' });
    return;
  }
  let userKey: number | null = null;
  let referrer = '';
  if (req.method === 'GET') {
    userKey = parseTossUserKey(url.searchParams.get('userKey'));
    referrer = url.searchParams.get('referrer') ?? '';
  } else {
    try {
      const body = await readJsonBody(req);
      userKey = parseTossUserKey(body.userKey);
      referrer = typeof body.referrer === 'string' ? body.referrer : '';
    } catch {
      sendJson(res, 400, { error: 'BAD_REQUEST', message: '잘못된 JSON 본문입니다' });
      return;
    }
  }
  console.log(`[toss] 연결 해제 콜백 — userKey=${userKey ?? '없음'} referrer=${referrer || '없음'}`);
  if (userKey !== null && Number.isFinite(userKey)) {
    const existing = findProfileByTossUserKey(userKey);
    if (existing) {
      const profile = { ...existing };
      profile.unlinkedAt = new Date().toISOString();
      profile.token = makeId(24); // 기존 클라이언트 세션 무효화
      delete profile.tossAccessToken;
      delete profile.tossRefreshToken;
      delete profile.tossTokenExpiresAt;
      profile.updatedAt = profile.unlinkedAt;
      const saved = await profileRepository.saveProfileMetadata(profile);
      rememberProfile(saved);
      sendLoggedOutToPlayer(profile.playerId, '토스 연결이 해제되어 다시 로그인해야 해요');
    }
    // 알 수 없는 userKey도 멱등하게 200으로 응답한다.
  }
  sendJson(res, 200, { ok: true });
}

const httpServer = createServer(async (req, res) => {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (await handleCommunity(req, res)) return;
  if (await handleWaiting(req, res)) return;
  if (await handleTournamentAdmin(req, res)) return;
  if (url.pathname === '/feedback') {
    await handleFeedback(req, res);
    return;
  }
  if (url.pathname === TOURNAMENT_PRACTICE_MOVE_PATH) {
    try {
      if (await handleMandako(req, res)) return;
    } catch (error) {
      console.error('[tournament] 연습 요청 처리 실패:', error);
      if (!res.headersSent) sendJson(res, 500, { error: 'INTERNAL_ERROR' });
      else res.end();
      return;
    }
  }
  if (url.pathname === TOURNAMENT_STATUS_PATH && req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-store');
    sendJson(res, 200, tournament.publicStatus(url.searchParams.get('tournamentId') ?? undefined));
    return;
  }
  if (url.pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      rooms: rooms.size,
      queued: matchmakingQueue.length,
      players: profiles.size,
      registeredProfiles: profiles.size,
      activeSessions: sessions.size,
      profileStore: profileRepository.kind,
      officialBotMatches: true,
      botEngine: 'local-search-v1',
      jev: { acceptingMatches: false, reason: 'retired', replacement: 'local-search-v1' },
      gameRecords: { schemaVersion: 1, rulesVersion: RECORD_RULES_VERSION },
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
  if (url.pathname === '/auth/toss' && req.method === 'POST') {
    void handleTossLogin(req, res);
    return;
  }
  if (url.pathname === '/toss/unlink-callback' && (req.method === 'GET' || req.method === 'POST')) {
    void handleTossUnlinkCallback(req, res, url);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('몽진 온라인 서버 — WebSocket');
});

const wss = new WebSocketServer({ server: httpServer, maxPayload: 64 * 1024 });
const alive = new WeakSet<WebSocket>();
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.has(ws)) { ws.terminate(); continue; }
    alive.delete(ws);
    ws.ping();
  }
  telemetry.sample();
}, 30_000).unref();
const notificationTimer = setInterval(() => {
  void notificationDelivery.flush().catch(() => console.error('[notifications] 발송 작업 저장 실패'));
}, 30_000).unref();
const waitingNotificationTimer = setInterval(() => {
  void waitingNotifications.flush().catch(() => console.error('[waiting-notifications] 발송 작업 저장 실패'));
}, 5_000).unref();
tournamentScheduler.start();

wss.on('connection', (ws, request) => {
  alive.add(ws);
  ws.on('error', () => undefined);
  ws.on('pong', () => alive.add(ws));
  sessions.set(ws, {
    playerId: null,
    credentialToken: null,
    roomId: null,
    platform: inferMatchPlatform(request.headers.origin, request.headers['user-agent']),
    features: new Set(),
  });
  const remoteAddress = request.socket.remoteAddress ?? '';
  if (remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1') {
    loopbackSockets.add(ws);
  }

  ws.on('message', (raw) => {
    void (async () => {
    let msg: {
      type: string;
      playerId?: string;
      token?: string;
      name?: string;
      roomId?: string;
      move?: Move;
      legacyProfile?: unknown;
      features?: unknown;
      lang?: unknown;
    };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      send(ws, { type: 'ERROR', message: '잘못된 메시지 형식입니다' });
      return;
    }

    if (msg.type === 'HELLO') {
      const session = sessions.get(ws);
      if (session && Array.isArray(msg.features)) {
        for (const feature of msg.features) {
          if (feature === 'resume' || feature === 'server-clock') session.features.add(feature);
        }
      }
      if (session && typeof msg.lang === 'string' && msg.lang in DEFAULT_NAME_PREFIX) session.lang = msg.lang;
      await authenticate(ws, msg.playerId, msg.token);
      return;
    }

    if (isTournamentMessageType(msg.type)) {
      const session = sessions.get(ws);
      const tournamentPlayerId = session?.playerId ?? null;
      const profile = tournamentPlayerId ? profiles.get(tournamentPlayerId) : undefined;
      await tournament.handle(
        tournamentClientFor(ws),
        tournamentPlayerId && profile && !profile.unlinkedAt && !isRankedBotId(tournamentPlayerId) && session && session.credentialToken === profile.token
          ? { playerId: tournamentPlayerId, name: profile.name, platform: session.platform, loopback: loopbackSockets.has(ws) }
          : null,
        msg,
      );
      return;
    }

    const playerId = requirePlayer(ws);
    if (!playerId) return;

    if (msg.type === 'RESUME') {
      resumeSeat(ws, playerId, typeof msg.roomId === 'string' ? msg.roomId.trim().toUpperCase() : undefined);
      return;
    }

    if (msg.type === 'REMATCH') {
      requestRematch(ws, typeof msg.roomId === 'string' ? msg.roomId.trim().toUpperCase() : '');
      return;
    }

    if (msg.type === 'MATCHMAKE' || msg.type === 'MATCHMAKE_BOT' || msg.type === 'CREATE' || msg.type === 'JOIN') {
      if (tournament.isPlayerBusy(playerId)) {
        send(ws, { type: 'ERROR', message: '대회 경기를 마치거나 대기를 멈춘 뒤 이용해 주세요' });
        return;
      }
      abandonWaitingSeats(playerId);
      cancelRematchOffers(ws);
    }

    if (msg.type === 'GET_PROFILE') {
      send(ws, { type: 'PROFILE', profile: publicProfile(playerId) });
      return;
    }

    if (msg.type === 'FIRST_MOVE_PLAYED') {
      if (profiles.get(playerId)?.hasPlayedMove) send(ws, { type: 'PROFILE', profile: publicProfile(playerId) });
      else await markFirstMove(playerId);
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
      const saved = await profileRepository.saveProfileMetadata(profile);
      rememberProfile(saved);
      tournament.updateName(playerId, saved.name);
      send(ws, { type: 'PROFILE', profile: publicProfile(playerId) });
      return;
    }

    if (msg.type === 'MIGRATE_LEGACY_PROFILE') {
      try {
        const claim = validateLegacyProfileClaim(msg.legacyProfile);
        const duplicateName = [...profiles.values()].some(
          (profile) => profile.playerId !== playerId && profile.name === claim.name,
        );
        const result = await profileRepository.migrateLegacyProfile(playerId, {
          ...claim,
          name: duplicateName ? profiles.get(playerId)!.name : claim.name,
          migratedAt: new Date().toISOString(),
        });
        rememberProfile(result.profile);
        sendProfileToPlayer(playerId);
      } catch (error) {
        send(ws, {
          type: 'ERROR',
          message: error instanceof Error ? error.message : '기존 기기 Elo를 승계하지 못했습니다',
        });
      }
      return;
    }

    if (msg.type === 'MATCHMAKE') {
      const session = sessions.get(ws)!;
      if (session.roomId) {
        send(ws, { type: 'ERROR', message: '이미 대국에 참가 중입니다' });
        return;
      }
      pendingBotMatches.delete(ws);
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
      pendingBotMatches.delete(ws);
      removeFromQueue(ws);
      send(ws, { type: 'QUEUE_LEFT' });
      return;
    }

    if (msg.type === 'MATCHMAKE_BOT') {
      const session = sessions.get(ws)!;
      if (session.roomId) {
        send(ws, { type: 'ERROR', message: '이미 대국에 참가 중입니다' });
        return;
      }
      removeFromQueue(ws);
      await startBotMatch(ws);
      return;
    }

    if (msg.type === 'CREATE') {
      pendingBotMatches.delete(ws);
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
        blackPlatform: 'unknown',
        whitePlatform: 'unknown',
        finished: false,
      };
      const side = attachPlayer(room, ws);
      rooms.set(id, room);
      sessions.get(ws)!.roomId = id;
      send(ws, { type: 'CREATED', roomId: id, side, state: room.state });
      return;
    }

    if (msg.type === 'JOIN') {
      pendingBotMatches.delete(ws);
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
            startGameRecord(room);
            send(room.black, {
              type: 'MATCH_FOUND',
              roomId: id,
              side: 'BLACK',
              matchKind: 'friend',
              state: room.state,
              opponent: opponentSummary(room.whitePlayerId),
            });
            send(room.white, {
              type: 'MATCH_FOUND',
              roomId: id,
              side: 'WHITE',
              matchKind: 'friend',
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
      else if (room.kind === 'random' && !room.finished) await finishRandomMatch(room, opponent(side), 'forfeit', 'resign');
      else if (room.kind === 'bot' && !room.finished && room.bot) await finishBotMatch(room, room.bot.side, 'forfeit', 'resign');
      else if (room.kind === 'friend' && !room.finished) {
        if (room.blackPlayerId && room.whitePlayerId) await finishFriendMatch(room, opponent(side), 'forfeit', 'resign');
        else {
          // Cancelling an unfilled room has no winner, but must release the
          // host's session so a later matchmaking request can proceed.
          room.finished = true;
          releaseFinishedRoom(room);
          send(ws, { type: 'QUEUE_LEFT' });
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
        else if (room.pendingMove) send(ws, { type: 'ERROR', message: '이전 수를 처리 중입니다' });
        else if (room.state.turn !== side) send(ws, { type: 'ERROR', message: '내 차례가 아닙니다' });
        else if (room.finished || getResult(room.state, config)) send(ws, { type: 'ERROR', message: '게임이 이미 끝났습니다' });
        else if (room.kind === 'friend' && (!room.black || !room.white)) send(ws, { type: 'ERROR', message: '상대가 입장한 뒤 수를 둘 수 있습니다' });
        else if (!isValidMove(room.state, msg.move)) send(ws, { type: 'ERROR', message: '불법 수입니다' });
        else {
          room.pendingMove = true;
          try {
            room.state = applyMove(room.state, msg.move);
            try { await markFirstMove(playerId); }
            catch (error) { console.error('[profiles] 첫 착수 저장 실패:', error); }
            void saveGameRecord(room);
            const result = getResult(room.state, config);
            if (!result) startMoveClock(room);
            broadcastState(room);
            if (result) {
              if (room.kind === 'bot') await finishBotMatch(room, result.winner, result.reason);
              else if (room.kind === 'random') await finishRandomMatch(room, result.winner, result.reason);
              else await finishFriendMatch(room, result.winner, result.reason);
            } else if (room.kind === 'bot') {
              scheduleBotMove(room);
            }
          } finally {
            room.pendingMove = false;
          }
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

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
  clearInterval(notificationTimer);
  clearInterval(waitingNotificationTimer);
  httpServer.close();
  for (const ws of wss.clients) ws.close(1001, 'Server restarting');
  await tournamentScheduler.close();
  await tournament.shutdown();
  await waitingNotifications.close();
  await telemetry.close();
  await Promise.all([community.store.close(), gameRecordStore.close(), profileRepository.close()]);
  for (const ws of wss.clients) ws.terminate();
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  void shutdown().then(() => process.exit(0), () => process.exit(1));
});

httpServer.listen(PORT, HOST, () => {
  const address = httpServer.address();
  console.log(`몽진 온라인 서버 — ws://${HOST}:${typeof address === 'object' && address ? address.port : PORT}`);
  console.log(`프로필 저장소 — ${profileRepository.kind === 'postgres' ? 'Postgres' : PROFILE_DATA_FILE}`);
});
