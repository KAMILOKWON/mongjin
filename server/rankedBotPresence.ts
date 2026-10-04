import type { PlayerPresence } from '../src/net/invitationProtocol';
import { RANKED_BOTS } from './rankedBots';

const ONLINE_COUNT = 4;
const ROTATION_MS = 20 * 60_000;

/** A small, stable roster. Reservations and games keep a member online through rotation. */
export class RankedBotPresence {
  private readonly ids: string[];
  private readonly online = new Set<string>();
  private nextRotation: number;

  constructor(private readonly options: {
    isPlaying: (id: string) => boolean;
    isReserved: (id: string) => boolean;
    now?: () => number;
    random?: () => number;
  }) {
    this.ids = RANKED_BOTS.map(bot => bot.id);
    // Shuffle once so a restart does not always favor the same four profiles.
    for (let i = this.ids.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [this.ids[i], this.ids[j]] = [this.ids[j]!, this.ids[i]!];
    }
    this.ids.slice(0, ONLINE_COUNT).forEach(id => this.online.add(id));
    this.nextRotation = this.now() + ROTATION_MS;
  }

  private now() { return (this.options.now ?? Date.now)(); }
  private random() {
    const value = (this.options.random ?? Math.random)();
    return Number.isFinite(value) ? Math.max(0, Math.min(0.999_999, value)) : 0;
  }

  refresh(): void {
    if (this.now() < this.nextRotation) return;
    const departing = [...this.online].find(id => !this.options.isPlaying(id) && !this.options.isReserved(id));
    const arriving = this.ids.find(id => !this.online.has(id) && !this.options.isPlaying(id) && !this.options.isReserved(id));
    if (departing && arriving) {
      this.online.delete(departing);
      this.online.add(arriving);
      // Round-robin the resting member to avoid repeatedly choosing one account.
      this.ids.splice(this.ids.indexOf(departing), 1);
      this.ids.push(departing);
    }
    this.nextRotation = this.now() + ROTATION_MS;
  }

  presence(id: string): PlayerPresence {
    if (!this.ids.includes(id)) return 'offline';
    this.refresh();
    if (this.options.isPlaying(id)) return 'playing';
    return this.online.has(id) ? 'idle' : 'offline';
  }
}
