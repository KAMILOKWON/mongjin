import AsyncStorage from '@react-native-async-storage/async-storage';
import type { GhostCatalog, GhostPlayerCard, GhostTape } from '../../../packages/game-data/src';
import { BUILT_IN_GHOSTS, withEphemeralGhostNickname } from '../../../packages/game-data/src';

const STORAGE_KEY = 'mongjin.mobile.catalog.v2';
const LAST_QUICK_MATCH_NAME_KEY = 'mongjin.mobile.last-quick-name.v1';

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
  private catalog: GhostCatalog = {
    profile: defaultProfile(),
    tapes: clone(BUILT_IN_GHOSTS),
  };

  async hydrate(): Promise<void> {
    try {
      const [raw, lastQuickMatchName] = await Promise.all([
        AsyncStorage.getItem(STORAGE_KEY),
        AsyncStorage.getItem(LAST_QUICK_MATCH_NAME_KEY),
      ]);
      this.lastQuickMatchName = lastQuickMatchName;
      const parsed = raw ? JSON.parse(raw) as Partial<GhostCatalog> : null;
      if (parsed?.profile && Array.isArray(parsed.tapes)) {
        this.catalog = {
          profile: { ...defaultProfile(), ...parsed.profile },
          tapes: parsed.tapes as GhostTape[],
        };
      }
    } catch {
      this.catalog = { profile: defaultProfile(), tapes: clone(BUILT_IN_GHOSTS) };
    }
    if (this.catalog.tapes.length === 0) this.catalog.tapes = clone(BUILT_IN_GHOSTS);
    await this.persist();
  }

  snapshot(): GhostCatalog {
    return clone(this.catalog);
  }

  profile(): GhostPlayerCard {
    return { ...this.catalog.profile };
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
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(this.catalog));
    } catch {
      // 기기 저장소가 잠시 unavailable 해도 현재 대국은 계속한다.
    }
  }
}
