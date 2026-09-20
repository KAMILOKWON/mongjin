import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { initialState } from '../src/core/rules';
import { applyMove } from '../src/core/apply';
import { buildHumanStyleBook, humanStylePreference, type HumanStyleSample } from './humanStyle';

const args = process.argv.slice(2);
const allowed = new Set(['--input', '--out', '--train-games']);
const options = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  const key = args[i]!, value = args[i + 1];
  if (!allowed.has(key) || !value || options.has(key)) throw new Error('Use --input JSONL --out JSON --train-games N');
  options.set(key, value);
}
const input = options.get('--input'), output = options.get('--out');
const trainingGames = Number(options.get('--train-games'));
if (!input || !output || !Number.isInteger(trainingGames) || trainingGames < 1) {
  throw new Error('Input, output and a positive training game count are required');
}
const raw = readFileSync(input, 'utf8');
const samples: HumanStyleSample[] = raw.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
// Validate every game and cross-split duplicates before producing an artifact.
buildHumanStyleBook(samples);
samples.sort((a, b) => Date.parse(a.record.endedAt!) - Date.parse(b.record.endedAt!)
  || a.record.matchId.localeCompare(b.record.matchId));
if (samples.some((sample) => !Number.isFinite(Date.parse(sample.record.endedAt!)))) throw new Error('Invalid game date');
if (trainingGames >= samples.length) throw new Error('Keep at least one complete game for evaluation');
const training = samples.slice(0, trainingGames), evaluation = samples.slice(trainingGames);
const book = buildHumanStyleBook(training);
let evaluationMoves = 0, coveredMoves = 0, openingMoves = 0, coveredOpeningMoves = 0;
for (const { record, eligibleSide } of evaluation) {
  let state = initialState(record.config);
  for (const move of record.moves) {
    if (state.turn === eligibleSide) {
      const covered = Boolean(humanStylePreference(book, state, record.config, eligibleSide));
      evaluationMoves++; coveredMoves += Number(covered);
      if (state.history.length < 12) { openingMoves++; coveredOpeningMoves += Number(covered); }
    }
    state = applyMove(state, move);
  }
}
const serialized = JSON.stringify(book, null, 2) + '\n';
const manifest = {
  schemaVersion: 1,
  rulesVersion: book.rulesVersion,
  inputSha256: createHash('sha256').update(raw).digest('hex'),
  bookSha256: createHash('sha256').update(serialized).digest('hex'),
  trainingGames, trainingMoves: book.moves,
  trainingSides: { BLACK: training.filter((s) => s.eligibleSide === 'BLACK').length,
    WHITE: training.filter((s) => s.eligibleSide === 'WHITE').length },
  positions: Object.keys(book.positions).length,
  evaluationGames: evaluation.length, evaluationMoves, coveredMoves, openingMoves, coveredOpeningMoves,
};
writeFileSync(output, serialized, { flag: 'wx' });
writeFileSync(output + '.manifest.json', JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(manifest, null, 2));
