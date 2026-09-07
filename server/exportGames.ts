import { dirname, join, resolve } from 'node:path';
import { open } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createGameRecordStore, trainingRecord } from './gameRecords';

const { values } = parseArgs({ options: {
  'min-elo': { type: 'string', default: '1500' },
  both: { type: 'boolean', default: false },
  'include-bots': { type: 'boolean', default: false },
  'include-forfeits': { type: 'boolean', default: false },
  out: { type: 'string' },
} });
const minElo = Number(values['min-elo']);
if (!Number.isSafeInteger(minElo) || minElo < 0) throw new Error('--min-elo must be a nonnegative integer');
if (!values.out) throw new Error('--out is required (JSONL output; existing files are never overwritten)');
const profileFile = process.env.MONGJIN_PROFILE_DATA_FILE ?? join(process.cwd(), 'data', 'profiles.json');
const store = await createGameRecordStore(join(dirname(profileFile), 'game-records'));
let output;
let count = 0;
let invalid = 0;
try {
  output = await open(resolve(values.out), 'wx', 0o600);
  for await (const record of store.records()) {
    let exported;
    try {
      exported = trainingRecord(record, {
        minElo, both: values.both, includeBots: values['include-bots'], includeForfeits: values['include-forfeits'],
      });
    } catch {
      invalid++;
      console.error(`Skipped invalid record: ${record.matchId}`);
      continue;
    }
    if (!exported) continue;
    await output.write(`${JSON.stringify(exported)}\n`);
    count++;
  }
  console.error(`Exported ${count} games; rejected ${invalid} invalid records.`);
  if (invalid) process.exitCode = 2;
} finally {
  await output?.close();
  await store.close();
}
