import { describe, expect, it } from 'vitest';
import { RANKED_BOTS } from './rankedBots';
import { RankedBotPresence } from './rankedBotPresence';

function fixture() {
  let time = 0;
  const playing = new Set<string>();
  const reserved = new Set<string>();
  const roster = new RankedBotPresence({
    isPlaying: id => playing.has(id), isReserved: id => reserved.has(id),
    now: () => time, random: () => 0.5,
  });
  const online = () => RANKED_BOTS.map(bot => bot.id).filter(id => roster.presence(id) !== 'offline');
  return { roster, playing, reserved, online, advance: () => { time += 20 * 60_000; } };
}

describe('ranked presence roster', () => {
  it('keeps four stable entries and rotates one idle entry per interval', () => {
    const f = fixture();
    const before = f.online();
    expect(before).toHaveLength(4);
    expect(f.online()).toEqual(before);
    expect(f.roster.presence('unknown')).toBe('offline');
    f.advance();
    const after = f.online();
    expect(after).toHaveLength(4);
    expect(after.filter(id => !before.includes(id))).toHaveLength(1);
  });

  it('pins pending and playing members, then allows rotation after they become idle', () => {
    const f = fixture();
    const before = f.online();
    f.playing.add(before[0]!);
    before.slice(1).forEach(id => f.reserved.add(id));
    f.advance();
    expect(f.online()).toEqual(before);
    expect(f.roster.presence(before[0]!)).toBe('playing');
    f.playing.clear();
    f.reserved.clear();
    f.advance();
    expect(f.online()).not.toEqual(before);
  });

  it('shows a quick-match participant as playing and offline again after its game', () => {
    const f = fixture();
    const off = RANKED_BOTS.find(bot => !f.online().includes(bot.id))!.id;
    f.playing.add(off);
    expect(f.roster.presence(off)).toBe('playing');
    f.playing.delete(off);
    expect(f.roster.presence(off)).toBe('offline');
  });

  it('eventually gives every resting profile a turn without growing the roster', () => {
    const f = fixture();
    const seen = new Set(f.online());
    for (let i = 0; i < 30; i++) {
      f.advance();
      const current = f.online();
      expect(current).toHaveLength(4);
      current.forEach(id => seen.add(id));
    }
    expect(seen.size).toBe(RANKED_BOTS.length);
  });
});
