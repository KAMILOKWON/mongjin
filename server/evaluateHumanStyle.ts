import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { chooseMove } from '../src/ai/ai';
import { applyMove } from '../src/core/apply';
import { initialState, legalMoves, opponent } from '../src/core/rules';
import { getResult } from '../src/core/result';
import { moveKey } from '../src/bot/moveKey';
import type { GameState, Move } from '../src/core/types';
import { buildHumanStyleBook, humanStylePositionKey, humanStylePreference, type HumanStyleSample } from './humanStyle';
import { FIRST_PLACE_STYLE } from './firstPlaceStyle';
import { openingMovePreference } from './openingStyle';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: tsx evaluateHumanStyle.ts PRIVATE_RECORDS.jsonl REPORT.json');
const raw = readFileSync(input, 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./bot-data/first-place.json.manifest.json', import.meta.url), 'utf8'));
if (createHash('sha256').update(raw).digest('hex') !== manifest.inputSha256) throw new Error('Input is not the frozen data split');
const bookBytes = readFileSync(new URL('./bot-data/first-place.json', import.meta.url));
if (createHash('sha256').update(bookBytes).digest('hex') !== manifest.bookSha256) throw new Error('Book checksum mismatch');
const samples: HumanStyleSample[] = raw.trim().split(/\r?\n/).map((line) => JSON.parse(line));
buildHumanStyleBook(samples);
samples.sort((a, b) => Date.parse(a.record.endedAt!) - Date.parse(b.record.endedAt!)
  || a.record.matchId.localeCompare(b.record.matchId));
type Position = { state: GameState; sample: HumanStyleSample; played: Move; known: boolean };
const unique = new Map<string, Position>();
for (const sample of samples.slice(manifest.trainingGames)) {
  let state = initialState(sample.record.config);
  for (const move of sample.record.moves) {
    if (state.turn === sample.eligibleSide) {
      const key = humanStylePositionKey(state, sample.record.config);
      if (!unique.has(key)) unique.set(key, { state, sample, played: move,
        known: Boolean(humanStylePreference(FIRST_PLACE_STYLE, state, sample.record.config, sample.eligibleSide)) });
    }
    state = applyMove(state, move);
  }
}
function evenly<T>(values: T[], count: number): T[] {
  return values.length <= count ? values : Array.from({ length: count }, (_, i) => values[Math.floor(i * values.length / count)]!);
}
const selected = [true, false].flatMap((known) => evenly([...unique.values()].filter((p) => p.known === known), 24));
function rng(seed: number) {
  return () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 2 ** 32; };
}
const stats = {
  positions: selected.length, knownPositions: selected.filter((p) => p.known).length,
  blackPositions: selected.filter((p) => p.state.turn === 'BLACK').length,
  comparisons: 0, changed: 0, baselineAgreement: 0, learnedAgreement: 0,
  baselineImmediateLosses: 0, learnedImmediateLosses: 0, missedImmediateWins: 0, illegal: 0,
  unknownChanged: 0, nodesChanged: 0,
};
const timings: number[] = [];
const evidence: Array<{ side: string; ply: number; baseline: string; learned: string; recorded: string }> = [];
for (const { state, sample, played, known } of selected) {
  const config = sample.record.config;
  const baselinePreference = state.history.length < 12
    ? (root: GameState, move: Move) => openingMovePreference(root, move, config, state.turn, 'runner', 1)
    : undefined;
  const learned = humanStylePreference(FIRST_PLACE_STYLE, state, config, state.turn) ?? baselinePreference;
  const legal = legalMoves(state, config);
  const winning = legal.some((move) => getResult(applyMove(state, move), config)?.winner === state.turn);
  const losesImmediately = (move: Move) => {
    const next = applyMove(state, move);
    if (getResult(next, config)) return getResult(next, config)!.winner !== state.turn;
    return legalMoves(next, config).some((reply) => getResult(applyMove(next, reply), config)?.winner === opponent(state.turn));
  };
  for (const seed of [71, 2026]) {
    const nodes: number[] = [];
    const pick = (preference: typeof learned) => chooseMove(state, config, {
      maxMs: 5000, maxDepth: 4, maxNodes: 4000, strategyLevel: 3, elite: true,
      choiceWindow: 12, planStrength: 1.45 * 1.18, botSide: state.turn, rng: rng(seed),
      movePreference: preference,
      onSearchComplete: (result) => { nodes.push(result.nodes); timings.push(result.elapsedMs); },
    })!;
    const baseline = pick(baselinePreference), actual = pick(learned);
    const changed = moveKey(baseline) !== moveKey(actual);
    stats.comparisons++; stats.changed += Number(changed);
    stats.baselineAgreement += Number(moveKey(baseline) === moveKey(played));
    stats.learnedAgreement += Number(moveKey(actual) === moveKey(played));
    stats.baselineImmediateLosses += Number(losesImmediately(baseline));
    stats.learnedImmediateLosses += Number(losesImmediately(actual));
    stats.missedImmediateWins += Number(winning && getResult(applyMove(state, actual), config)?.winner !== state.turn);
    stats.illegal += Number(!legal.some((move) => moveKey(move) === moveKey(actual)));
    stats.unknownChanged += Number(!known && changed);
    stats.nodesChanged += Number(nodes[0] !== nodes[1]);
    if (changed) evidence.push({ side: state.turn, ply: state.history.length + 1,
      baseline: moveKey(baseline), learned: moveKey(actual), recorded: moveKey(played) });
  }
}
timings.sort((a, b) => a - b);
const report = { schemaVersion: 1, bookSha256: manifest.bookSha256,
  budget: { maxMs: 5000, maxDepth: 4, maxNodes: 4000, seeds: [71, 2026] },
  note: 'Controlled node-budget comparison on up to 24 known and 24 unknown distinct held-out positions; not a production latency or strength estimate.',
  ...stats, timingMs: { median: timings[Math.floor(timings.length / 2)], maximum: timings.at(-1) }, evidence };
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
if (stats.illegal || stats.missedImmediateWins || stats.unknownChanged || stats.nodesChanged
  || stats.learnedImmediateLosses > stats.baselineImmediateLosses) process.exitCode = 1;
