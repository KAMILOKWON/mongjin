import type { GameRecordStore } from './gameRecords';
import type { FirstMoveHistory, ProfileRepository } from './profileRepository';

const playedResult = (reason: string | undefined) =>
  reason === 'goal' || reason === 'capture' || reason === 'surround' || reason === 'no-moves';

// Historical records omit account IDs. Only join a record to a profile through
// a stored result or a match event with the same match ID.
export async function backfillFirstMoves(
  profiles: ProfileRepository,
  records: GameRecordStore,
): Promise<number> {
  const history: FirstMoveHistory = await profiles.firstMoveHistory();
  const played = new Set<string>();
  const matches = new Map(history.matches.map((match) => [match.matchId, match]));
  const botMatches = new Map(history.botMatches.map((match) => [match.matchId, match]));
  const events = new Map<string, FirstMoveHistory['events']>();
  for (const event of history.events) {
    const group = events.get(event.matchId) ?? [];
    group.push(event);
    events.set(event.matchId, group);
    if (event.matchKind === 'random' && event.plyCount >= 2) played.add(event.playerId);
    if (event.matchKind === 'bot' && event.plyCount >= 2) played.add(event.playerId);
    if (event.event === 'completed' && event.outcome === 'win' && playedResult(event.reason)) {
      played.add(event.playerId);
    }
  }
  for (const match of history.matches) if (playedResult(match.reason)) played.add(match.winnerId);
  for (const match of history.botMatches) {
    if (match.playerWon && playedResult(match.reason)) played.add(match.playerId);
  }

  for await (const record of records.records()) {
    const plyCount = Array.isArray(record.moves) ? record.moves.length : 0;
    if (plyCount === 0) continue;
    const group = events.get(record.matchId) ?? [];
    if (record.kind === 'bot') {
      const humanSide = record.players?.BLACK?.kind === 'human' && record.players?.WHITE?.kind === 'bot'
        ? 'BLACK' : record.players?.WHITE?.kind === 'human' && record.players?.BLACK?.kind === 'bot'
          ? 'WHITE' : null;
      if (!humanSide || plyCount < (humanSide === 'BLACK' ? 1 : 2)) continue;
      const playerId = botMatches.get(record.matchId)?.playerId
        ?? group.find((event) => event.matchKind === 'bot')?.playerId;
      if (playerId) played.add(playerId);
    } else if (record.kind === 'random') {
      const match = matches.get(record.matchId);
      if (plyCount >= 2) {
        if (match) { played.add(match.winnerId); played.add(match.loserId); }
        for (const event of group) if (event.matchKind === 'random') played.add(event.playerId);
      } else if (record.winner && record.players?.BLACK?.kind === 'human') {
        // With one ply, BLACK moved. A recorded winner identifies the account's side.
        if (match) played.add(record.winner === 'BLACK' ? match.winnerId : match.loserId);
        for (const event of group) {
          if (event.matchKind === 'random' && event.outcome) {
            const side = event.outcome === 'win' ? record.winner : record.winner === 'BLACK' ? 'WHITE' : 'BLACK';
            if (side === 'BLACK') played.add(event.playerId);
          }
        }
      }
    }
  }
  return (await profiles.markFirstMoves([...played])).length;
}
