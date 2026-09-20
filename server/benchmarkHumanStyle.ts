import { writeFileSync } from 'node:fs';
import { DEFAULT_CONFIG } from '../src/core/config';
import { applyMove } from '../src/core/apply';
import { getResult } from '../src/core/result';
import { initialState, legalMoves, opponent } from '../src/core/rules';
import { moveKey } from '../src/bot/moveKey';
import type { Player } from '../src/core/types';
import { RANKED_BOTS } from './rankedBots';
import { chooseOfficialBotMove, createRankedBot } from './officialBot';

const [output] = process.argv.slice(2);
if (!output) throw new Error('Usage: tsx benchmarkHumanStyle.ts REPORT.json');
function random(seed: number) {
  return () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 2 ** 32; };
}
function bot(id: string, side: Player, seed: number) {
  const definition = RANKED_BOTS.find((entry) => entry.id === id)!;
  const instance = createRankedBot({ playerId: id, name: definition.name, rating: definition.rating,
    token: 'local-benchmark', wins: 0, losses: 0, createdAt: '', updatedAt: '' }, random(seed));
  instance.side = side;
  // Equal bounded search: a smoke comparison, not an estimate of production Elo.
  instance.search = { ...instance.search, maxNodes: 1000, maxDepth: 3, maxMs: 5000 };
  return instance;
}
const games = [];
for (const [index, id] of ['ranked-bot-faker', 'ranked-bot-astra', 'ranked-bot-guide'].entries()) {
  for (const side of ['BLACK', 'WHITE'] as const) {
    const subject = bot('ranked-bot-first-place', side, 73 + index);
    const other = bot(id, opponent(side), 303 + index);
    let state = initialState(DEFAULT_CONFIG);
    let maxMoveMs = 0;
    for (let ply = 0; ply < 200 && !getResult(state, DEFAULT_CONFIG); ply++) {
      const started = performance.now();
      const move = chooseOfficialBotMove(state.turn === side ? subject : other, state, DEFAULT_CONFIG);
      maxMoveMs = Math.max(maxMoveMs, performance.now() - started);
      if (!move || !legalMoves(state, DEFAULT_CONFIG).some((candidate) => moveKey(candidate) === moveKey(move))) {
        throw new Error('Illegal benchmark move');
      }
      state = applyMove(state, move);
    }
    const result = getResult(state, DEFAULT_CONFIG);
    const game = { opponent: other.name, subjectSide: side, plies: state.history.length,
      outcome: result ? result.winner === side ? 'win' : 'loss' : 'capped', reason: result?.reason, maxMoveMs };
    games.push(game);
    console.log(JSON.stringify(game));
  }
}
const report = { schemaVersion: 1, budget: { maxNodes: 1000, maxDepth: 3, maxMs: 5000, maxPlies: 200 },
  note: 'Local smoke tournament at identical reduced node budgets. No production records or Elo are changed.', games };
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
if (games.some((game) => game.outcome === 'capped')) process.exitCode = 1;
