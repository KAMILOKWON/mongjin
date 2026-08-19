import { BUILT_IN_GHOSTS } from './seeds';
import { withEphemeralGhostNickname } from './nickname';
import type { GhostCatalog, GhostPlayerCard, GhostTape } from './types';

const STORAGE_KEY = 'mongjin.ghosts.v1';
const LAST_QUICK_MATCH_NAME_KEY = 'mongjin.ghosts.last-quick-name.v1';

const defaultProfile = (): GhostPlayerCard => ({
  name: '나그네',
  rating: 1200,
  wins: 0,
  losses: 0,
  defenseGhostID: null,
});

function cloneCatalog(value: GhostCatalog): GhostCatalog {
  return JSON.parse(JSON.stringify(value)) as GhostCatalog;
}

export class GhostStore {
  private catalog: GhostCatalog;
  private lastQuickMatchName: string | null = null;

  constructor(private storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage) {
    this.lastQuickMatchName = this.storage?.getItem(LAST_QUICK_MATCH_NAME_KEY) ?? null;
    this.catalog = this.load() ?? {
      profile: defaultProfile(),
      tapes: BUILT_IN_GHOSTS.map((tape) => ({ ...tape, moves: tape.moves.map((move) => ({ ...move })) })),
    };
    if (this.catalog.tapes.length === 0) this.catalog.tapes = BUILT_IN_GHOSTS;
    this.persist();
  }

  snapshot(): GhostCatalog {
    return cloneCatalog(this.catalog);
  }

  profile(): GhostPlayerCard {
    return { ...this.catalog.profile };
  }

  allTapes(): GhostTape[] {
    return [...this.catalog.tapes].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  add(tape: GhostTape, makeDefense = false): GhostTape {
    this.catalog.tapes = this.catalog.tapes.filter((item) => item.id !== tape.id);
    this.catalog.tapes.push(tape);
    if (makeDefense) this.catalog.profile.defenseGhostID = tape.id;
    this.persist();
    return tape;
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
    this.persist();
  }

  pickChallenge(rating = this.catalog.profile.rating): GhostTape | null {
    const tapes = this.allTapes();
    return tapes.sort((a, b) => Math.abs(a.ownerRating - rating) - Math.abs(b.ownerRating - rating))[0] ?? null;
  }

  pickQuickMatchChallenge(rating = this.catalog.profile.rating): GhostTape | null {
    const tape = this.pickChallenge(rating);
    if (!tape) return null;
    const challenge = withEphemeralGhostNickname(tape, {
      previousName: this.lastQuickMatchName,
      playerName: this.catalog.profile.name,
    });
    this.lastQuickMatchName = challenge.ownerName;
    try { this.storage?.setItem(LAST_QUICK_MATCH_NAME_KEY, challenge.ownerName); } catch { /* session fallback */ }
    return challenge;
  }

  private load(): GhostCatalog | null {
    if (!this.storage) return null;
    try {
      const parsed = JSON.parse(this.storage.getItem(STORAGE_KEY) ?? 'null') as Partial<GhostCatalog> | null;
      if (!parsed?.profile || !Array.isArray(parsed.tapes)) return null;
      return {
        profile: { ...defaultProfile(), ...parsed.profile },
        tapes: parsed.tapes as GhostTape[],
      };
    } catch {
      return null;
    }
  }

  private persist(): void {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.catalog));
    } catch {
      // 저장소가 없는 WebView에서도 번들 고스트로 대국은 계속 가능하다.
    }
  }
}
