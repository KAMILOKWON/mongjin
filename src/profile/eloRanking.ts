/**
 * Competition rank based only on Elo. Players with the same rating share the
 * same rank; records and account age never act as tie-breakers.
 */
export function calculateEloRank(rating: number, allRatings: Iterable<number>): number {
  let rank = 1;
  for (const candidateRating of allRatings) {
    if (candidateRating > rating) rank += 1;
  }
  return rank;
}
