import { randomBytes } from 'node:crypto';
import type { ProfileRepository, StoredProfile } from './profileRepository';

export const RANKED_BOTS = [
  { id: 'ranked-bot-may', name: '연세대MAY', rating: 1000, personality: 'guardian' },
  { id: 'ranked-bot-cinnamon', name: '씹다버린계피', rating: 1100, personality: 'wanderer' },
  { id: 'ranked-bot-furnace', name: '용광로불주먹', rating: 1200, personality: 'runner' },
  { id: 'ranked-bot-peers', name: '동년배들몽진한다', rating: 1300, personality: 'guardian' },
  { id: 'ranked-bot-uzumaki', name: 'うずまき', rating: 1400, personality: 'runner' },
  { id: 'ranked-bot-faker', name: 'faker', rating: 1500, personality: 'tactician' },
  { id: 'ranked-bot-astra', name: 'Astra', rating: 1600, personality: 'tactician' },
] as const;
export const isRankedBotId = (id: string) => RANKED_BOTS.some((bot) => bot.id === id);

export async function ensureRankedBots(repository: ProfileRepository): Promise<StoredProfile[]> {
  const profiles = await repository.loadProfiles();
  const now = new Date().toISOString();
  for (const bot of RANKED_BOTS) {
    if (profiles.some((p) => p.playerId !== bot.id && p.name === bot.name)) {
      throw new Error(`고정 봇 이름이 기존 프로필과 겹칩니다: ${bot.name}`);
    }
  }
  await repository.importProfiles(RANKED_BOTS.map((bot) => ({
    playerId: bot.id, name: bot.name, token: randomBytes(32).toString('hex'),
    rating: bot.rating, wins: 0, losses: 0, createdAt: now, updatedAt: now,
  })));
  return repository.loadProfiles();
}

export function selectRankedBot(profiles: Iterable<StoredProfile>, rating: number, previousName?: string, random: () => number = Math.random): StoredProfile {
  const candidates = [...profiles].filter((p) => isRankedBotId(p.playerId) && p.name !== previousName)
    .sort((a, b) => Math.abs(a.rating - rating) - Math.abs(b.rating - rating) || a.playerId.localeCompare(b.playerId))
    .slice(0, 3);
  if (!candidates.length) throw new Error('고정 봇 프로필이 없습니다');
  const value = random();
  return candidates[Math.floor((Number.isFinite(value) ? Math.max(0, Math.min(0.999999, value)) : 0) * candidates.length)]!;
}
