/**
 * 대회 전용 Elo. 모든 완료된 사람 대 사람 대국에 적용한다.
 * 결과는 정수로 반올림한 대칭(합이 0) 변화량이며, 경기 기록에 저장해 재시작 후 다시 계산하지 않는다.
 */
export interface TournamentEloSettings {
  k: number;
  scale: number;
}

export const DEFAULT_TOURNAMENT_ELO: TournamentEloSettings = { k: 32, scale: 400 };

/** rating 쪽의 기대 승률 */
export function expectedScore(rating: number, opponentRating: number, scale: number): number {
  return 1 / (1 + 10 ** ((opponentRating - rating) / scale));
}

/**
 * 승자가 얻고 패자가 잃는 점수. 낮은 점수의 상대에게 지면 더 많이 잃는다.
 * 반올림 후에도 승자 +d, 패자 -d 이므로 합은 항상 0이다.
 */
export function eloDelta(winnerRating: number, loserRating: number, settings: TournamentEloSettings): number {
  return Math.round(settings.k * (1 - expectedScore(winnerRating, loserRating, settings.scale)));
}

export interface RankingEntrant {
  id: string;
  points: number;
  wins: number;
  games: number;
}

/** 두 참가자 사이에서 완료된 점수 반영 대국 한 판 */
export interface HeadToHeadResult {
  winnerId: string;
  loserId: string;
}

/**
 * 공식 순위. 최소 경기 수 미만은 null.
 * 점수 → 승률 → (동점 그룹 전원이 서로 한 판 이상 둔 경우에만) 그룹 내 직접 대결 순이다.
 * 동점 그룹 단위로 한 번에 비교하므로 비교 순서에 따라 결과가 달라지지 않는다. 같으면 공동 순위(1, 1, 3).
 */
export function rankEntrants(
  entrants: readonly RankingEntrant[],
  results: readonly HeadToHeadResult[],
  minimumRankedMatches: number,
): Map<string, number | null> {
  const ranks = new Map<string, number | null>();
  const qualified: RankingEntrant[] = [];
  for (const entrant of entrants) {
    if (entrant.games >= minimumRankedMatches && entrant.games > 0) qualified.push(entrant);
    else ranks.set(entrant.id, null);
  }
  // 승률은 나눗셈 없이 교차 곱으로 비교한다.
  const byScore = (a: RankingEntrant, b: RankingEntrant) =>
    b.points - a.points || b.wins * a.games - a.wins * b.games;
  qualified.sort(byScore);

  let position = 0;
  let index = 0;
  while (index < qualified.length) {
    let end = index + 1;
    while (end < qualified.length && byScore(qualified[index]!, qualified[end]!) === 0) end += 1;
    const group = qualified.slice(index, end);
    for (const bucket of splitByHeadToHead(group, results)) {
      for (const entrant of bucket) ranks.set(entrant.id, position + 1);
      position += bucket.length;
    }
    index = end;
  }
  return ranks;
}

function splitByHeadToHead(group: RankingEntrant[], results: readonly HeadToHeadResult[]): RankingEntrant[][] {
  if (group.length < 2) return [group];
  const members = new Set(group.map((entrant) => entrant.id));
  const net = new Map<string, number>(group.map((entrant) => [entrant.id, 0]));
  const played = new Set<string>();
  for (const result of results) {
    if (!members.has(result.winnerId) || !members.has(result.loserId) || result.winnerId === result.loserId) continue;
    net.set(result.winnerId, net.get(result.winnerId)! + 1);
    net.set(result.loserId, net.get(result.loserId)! - 1);
    played.add(pairKey(result.winnerId, result.loserId));
  }
  // 일부 대진만 치른 그룹은 억지로 비교하지 않는다.
  for (let i = 0; i < group.length; i += 1) {
    for (let j = i + 1; j < group.length; j += 1) {
      if (!played.has(pairKey(group[i]!.id, group[j]!.id))) return [group];
    }
  }
  const sorted = [...group].sort((a, b) => net.get(b.id)! - net.get(a.id)!);
  const buckets: RankingEntrant[][] = [];
  for (const entrant of sorted) {
    const last = buckets.at(-1);
    if (last && net.get(last[0]!.id) === net.get(entrant.id)) last.push(entrant);
    else buckets.push([entrant]);
  }
  return buckets;
}

function pairKey(a: string, b: string): string {
  return a < b ? a + '\u0000' + b : b + '\u0000' + a;
}
