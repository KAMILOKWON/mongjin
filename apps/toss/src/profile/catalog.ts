import {
  BUILT_IN_GHOSTS,
  withEphemeralGhostNickname,
  type GhostCatalog,
  type GhostPlayerCard,
  type GhostTape,
} from '../../../../packages/game-data/src';
import type { PlayerProfile } from '../net/online';

export interface RemoteProfileProgress {
  playerId: string;
  name: string;
  wins: number;
  losses: number;
  rating: number;
  rank: number;
  totalPlayers: number;
  legacyMigrationComplete?: boolean;
}

export interface StoredOnlineProgress {
  playerId: string;
  name: string;
  carriedWins: number;
  carriedLosses: number;
  carriedRatingDelta: number;
  currentWins: number;
  currentLosses: number;
  currentRating: number;
  rank: number;
  totalPlayers: number;
  legacyMigrationComplete?: boolean;
}

const CATALOG_KEY = 'mongjin.toss.catalog.v1';
const LAST_QUICK_MATCH_NAME_KEY = 'mongjin.ait.last-quick-name.v1';

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function validRating(value: number): number {
  return Number.isFinite(value) ? Math.max(100, Math.round(value)) : 1200;
}

/** 서버 identity가 바뀌어도 기기에서 보이는 전적이 끊기지 않도록 구간을 누적한다 */
export function mergeOnlineProgress(
  previous: StoredOnlineProgress | null,
  remote: RemoteProfileProgress,
): StoredOnlineProgress {
  const currentWins = nonNegativeInteger(remote.wins);
  const currentLosses = nonNegativeInteger(remote.losses);
  const currentRating = validRating(remote.rating);

  // 승계가 끝난 뒤에는 서버 스냅샷만 공식 기록으로 유지한다.
  if (remote.legacyMigrationComplete) {
    return {
      playerId: remote.playerId,
      name: remote.name,
      carriedWins: 0,
      carriedLosses: 0,
      carriedRatingDelta: 0,
      currentWins,
      currentLosses,
      currentRating,
      rank: nonNegativeInteger(remote.rank),
      totalPlayers: nonNegativeInteger(remote.totalPlayers),
      legacyMigrationComplete: true,
    };
  }

  if (!previous) {
    return {
      playerId: remote.playerId,
      name: remote.name,
      carriedWins: 0,
      carriedLosses: 0,
      carriedRatingDelta: 0,
      currentWins,
      currentLosses,
      currentRating,
      rank: nonNegativeInteger(remote.rank),
      totalPlayers: nonNegativeInteger(remote.totalPlayers),
      legacyMigrationComplete: remote.legacyMigrationComplete,
    };
  }

  if (previous.playerId === remote.playerId) {
    return {
      ...previous,
      name: remote.name,
      currentWins: Math.max(previous.currentWins, currentWins),
      currentLosses: Math.max(previous.currentLosses, currentLosses),
      currentRating,
      rank: nonNegativeInteger(remote.rank),
      totalPlayers: nonNegativeInteger(remote.totalPlayers),
      legacyMigrationComplete: remote.legacyMigrationComplete,
    };
  }

  return {
    playerId: remote.playerId,
    name: remote.name,
    carriedWins: previous.carriedWins + previous.currentWins,
    carriedLosses: previous.carriedLosses + previous.currentLosses,
    carriedRatingDelta: previous.carriedRatingDelta + previous.currentRating - 1200,
    currentWins,
    currentLosses,
    currentRating,
    rank: nonNegativeInteger(remote.rank),
    totalPlayers: nonNegativeInteger(remote.totalPlayers),
    legacyMigrationComplete: remote.legacyMigrationComplete,
  };
}

export function onlineProgressSnapshot(progress: StoredOnlineProgress): RemoteProfileProgress {
  const wins = progress.carriedWins + progress.currentWins;
  const losses = progress.carriedLosses + progress.currentLosses;
  return {
    playerId: progress.playerId,
    name: progress.name,
    wins,
    losses,
    rating: Math.max(100, 1200 + progress.carriedRatingDelta + progress.currentRating - 1200),
    rank: progress.rank,
    totalPlayers: progress.totalPlayers,
    legacyMigrationComplete: progress.legacyMigrationComplete,
  };
}

interface StoredCatalog extends GhostCatalog {
  onlineProgress?: StoredOnlineProgress;
}

const defaultProfile = (): GhostPlayerCard => ({
  name: '나그네',
  rating: 1200,
  wins: 0,
  losses: 0,
  defenseGhostID: null,
});

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 저장소를 쓸 수 없는 환경에서는 메모리 상태로만 유지한다 */
  }
}

/** 오프라인에서도 승·패·Elo와 고스트 테이프가 쌓이는 기기 로컬 카탈로그 */
export class TossProfileStore {
  private lastQuickMatchName: string | null = null;
  private catalog: StoredCatalog = {
    profile: defaultProfile(),
    tapes: clone(BUILT_IN_GHOSTS),
  };

  hydrate(): void {
    const raw = readStorage(CATALOG_KEY);
    this.lastQuickMatchName = readStorage(LAST_QUICK_MATCH_NAME_KEY);

    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<StoredCatalog>;
        if (parsed?.profile && Array.isArray(parsed.tapes)) {
          this.catalog = {
            profile: { ...defaultProfile(), ...parsed.profile },
            tapes: parsed.tapes as GhostTape[],
            onlineProgress: parsed.onlineProgress,
          };
        }
      } catch {
        /* 손상된 값은 기본값을 유지하고 덮어쓰지 않는다 */
      }
    }

    if (this.catalog.tapes.length === 0) this.catalog.tapes = clone(BUILT_IN_GHOSTS);
    if (!raw) writeStorage(CATALOG_KEY, JSON.stringify(this.catalog));
  }

  snapshot(): GhostCatalog {
    return clone(this.catalog);
  }

  profile(): GhostPlayerCard {
    return { ...this.catalog.profile };
  }

  onlineProfile(): PlayerProfile | null {
    if (!this.catalog.onlineProgress) return null;
    const snap = onlineProgressSnapshot(this.catalog.onlineProgress);
    const games = snap.wins + snap.losses;
    return {
      ...snap,
      winRate: games ? Math.round((snap.wins / games) * 1000) / 10 : 0,
    };
  }

  mergeOnlineProfile(profile: PlayerProfile): PlayerProfile {
    this.catalog.onlineProgress = mergeOnlineProgress(this.catalog.onlineProgress ?? null, profile);
    writeStorage(CATALOG_KEY, JSON.stringify(this.catalog));
    return this.onlineProfile()!;
  }

  updateName(name: string): void {
    this.catalog.profile.name = name;
    writeStorage(CATALOG_KEY, JSON.stringify(this.catalog));
  }

  allTapes(): GhostTape[] {
    return [...this.catalog.tapes].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  pickChallenge(): GhostTape | null {
    const rating = this.catalog.profile.rating;
    const tape = this.allTapes().sort(
      (a, b) => Math.abs(a.ownerRating - rating) - Math.abs(b.ownerRating - rating),
    )[0];
    if (!tape) return null;
    const challenge = withEphemeralGhostNickname(tape, {
      previousName: this.lastQuickMatchName,
      playerName: this.catalog.profile.name,
    });
    this.lastQuickMatchName = challenge.ownerName;
    writeStorage(LAST_QUICK_MATCH_NAME_KEY, challenge.ownerName);
    return challenge;
  }

  recordMatch(won: boolean, opponentRating: number, tape: GhostTape | null): void {
    if (won) this.catalog.profile.wins += 1;
    else this.catalog.profile.losses += 1;
    const expected = 1 / (1 + 10 ** ((opponentRating - this.catalog.profile.rating) / 400));
    this.catalog.profile.rating = Math.max(
      100,
      Math.round(this.catalog.profile.rating + 24 * ((won ? 1 : 0) - expected)),
    );
    if (tape) {
      this.catalog.tapes = this.catalog.tapes.filter((item) => item.id !== tape.id);
      this.catalog.tapes.push(tape);
      this.catalog.profile.defenseGhostID = tape.id;
    }
    writeStorage(CATALOG_KEY, JSON.stringify(this.catalog));
  }
}
