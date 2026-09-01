import AsyncStorage from '@react-native-async-storage/async-storage';
import type { GhostCatalog, GhostPlayerCard, GhostTape } from '../../../packages/game-data/src';
import { BUILT_IN_GHOSTS, withEphemeralGhostNickname } from '../../../packages/game-data/src';
import type { PlayerProfile } from './online';
import {
  mergeOnlineProgress,
  onlineProgressSnapshot,
  type StoredOnlineProgress,
} from './profilePersistence';

const STORAGE_KEY = 'mongjin.mobile.catalog.v2';
const LAST_QUICK_MATCH_NAME_KEY = 'mongjin.mobile.last-quick-name.v1';

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

export class MobileProfileStore {
  private lastQuickMatchName: string | null = null;
  private catalog: StoredCatalog = {
    profile: defaultProfile(),
    tapes: clone(BUILT_IN_GHOSTS),
  };

  async hydrate(): Promise<void> {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    this.lastQuickMatchName = await AsyncStorage.getItem(LAST_QUICK_MATCH_NAME_KEY).catch(() => null);

    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StoredCatalog>;
      if (!parsed?.profile || !Array.isArray(parsed.tapes)) {
        throw new Error('Invalid stored mobile profile');
      }
      this.catalog = {
        profile: { ...defaultProfile(), ...parsed.profile },
        tapes: parsed.tapes as GhostTape[],
        onlineProgress: parsed.onlineProgress,
      };
    }

    if (this.catalog.tapes.length === 0) this.catalog.tapes = clone(BUILT_IN_GHOSTS);
    // Create the initial value, but never overwrite an unreadable existing
    // value with defaults merely because hydration failed.
    if (!raw) await this.persist();
  }

  snapshot(): GhostCatalog {
    return clone(this.catalog);
  }

  profile(): GhostPlayerCard {
    return { ...this.catalog.profile };
  }

  onlineProfile(): PlayerProfile | null {
    if (!this.catalog.onlineProgress) return null;
    const snapshot = onlineProgressSnapshot(this.catalog.onlineProgress);
    const games = snapshot.wins + snapshot.losses;
    return {
      ...snapshot,
      winRate: games ? Math.round((snapshot.wins / games) * 1000) / 10 : 0,
    };
  }

  async mergeOnlineProfile(profile: PlayerProfile): Promise<PlayerProfile> {
    this.catalog.onlineProgress = mergeOnlineProgress(this.catalog.onlineProgress ?? null, profile);
    await this.persist();
    return this.onlineProfile()!;
  }

  async updateName(name: string): Promise<void> {
    this.catalog.profile.name = name;
    await this.persist();
  }

  allTapes(): GhostTape[] {
    return [...this.catalog.tapes].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  pickChallenge(): GhostTape | null {
    const rating = this.catalog.profile.rating;
    const tape = this.allTapes().sort((a, b) => Math.abs(a.ownerRating - rating) - Math.abs(b.ownerRating - rating))[0];
    if (!tape) return null;
    const challenge = withEphemeralGhostNickname(tape, {
      previousName: this.lastQuickMatchName,
      playerName: this.catalog.profile.name,
    });
    this.lastQuickMatchName = challenge.ownerName;
    void AsyncStorage.setItem(LAST_QUICK_MATCH_NAME_KEY, challenge.ownerName).catch(() => undefined);
    return challenge;
  }

  async recordMatch(won: boolean, opponentRating: number, tape: GhostTape | null): Promise<void> {
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
    await this.persist();
  }

  private async persist(): Promise<void> {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(this.catalog));
  }
}
