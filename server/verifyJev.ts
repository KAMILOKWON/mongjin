import { createReadStream } from 'node:fs';
import { lstat, open, readFile, stat, unlink } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState } from '../src/core/rules';
import {
  JEV_ANALYSIS_VERSION,
  JEV_EXTENSION_POLICY_VERSION,
  JEV_SEARCH_VERSION,
} from './jevAnalysis';
import {
  evaluateJev,
  JEV_MODEL,
  type EvaluateJevOptions,
  type EvaluateJevResult,
} from './jevGateway';
import { JEV_EXPIRES_AT } from './jevExperiment';
import { chooseParallelJevMove, ParallelTurnError, type ParallelTurnTrace } from './jevParallel';
import { JEV_PARALLEL_POLICY } from './jevPolicy';
import { createJevRecordStore } from './jevRecords';
import { verifyJevTrace } from './jevReplay';

const MAX_REPLAY_BYTES = 64 * 1024 * 1024;
const MAX_REPLAY_RECORDS = 10_000;
const MAX_REPLAY_LINE_BYTES = 16 * 1024 * 1024;

export const mockEvaluateJev: typeof evaluateJev = async (
  options: EvaluateJevOptions,
): Promise<EvaluateJevResult> => {
  const answers: EvaluateJevResult['answers'] = {};
  let roleIndex = 0;
  for (const [id, question] of Object.entries(options.questions)) {
    if (question.type === 'boolean') {
      answers[id] = { type: 'boolean', probability: 0.5 };
      continue;
    }
    const candidates = Object.keys(question.criteria).filter((choice) => choice !== 'none');
    if (candidates.length === 0) throw new Error('Mock choice question has no candidate');
    const choice = id === 'move'
      ? candidates.at(-1)!
      : candidates[roleIndex++ % Math.min(2, candidates.length)]!;
    answers[id] = {
      type: 'choice',
      choice,
      probabilities: Object.fromEntries(Object.keys(question.criteria).map((key) => [key, Number(key === choice)])),
    };
  }
  const response = {
    model: JEV_MODEL,
    answers,
    usage: { inputTokens: 0, outputTokens: 0 },
    providerMetadata: { gateway: { cost: '0' } },
  };
  options.onResponse?.(response);
  return {
    model: JEV_MODEL,
    answers,
    request: { model: JEV_MODEL, state: options.state, questions: options.questions },
    response,
    elapsedMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
  };
};

interface JevVerificationManifest {
  format: 'mongjin-jev-verification-manifest-1';
  createdAt: string;
  mode: 'mock' | 'live';
  traceCount: 1;
  model: typeof JEV_MODEL;
  policy: typeof JEV_PARALLEL_POLICY;
  versions: {
    analysis: typeof JEV_ANALYSIS_VERSION;
    search: typeof JEV_SEARCH_VERSION;
    extension: typeof JEV_EXTENSION_POLICY_VERSION;
    protocol: typeof JEV_PARALLEL_POLICY.protocolVersion;
  };
}

async function writeTurnOutput(
  outputPath: string,
  trace: ParallelTurnTrace,
  manifest: JevVerificationManifest,
): Promise<void> {
  const tracePath = resolve(outputPath);
  const manifestPath = `${tracePath}.manifest.json`;
  let traceFile: Awaited<ReturnType<typeof open>> | undefined;
  let manifestFile: Awaited<ReturnType<typeof open>> | undefined;
  let traceCreated = false;
  let manifestCreated = false;
  let complete = false;
  try {
    traceFile = await open(tracePath, 'wx', 0o600);
    traceCreated = true;
    manifestFile = await open(manifestPath, 'wx', 0o600);
    manifestCreated = true;
    await traceFile.writeFile(`${JSON.stringify(trace)}\n`, 'utf8');
    await manifestFile.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    complete = true;
  } finally {
    await Promise.allSettled([traceFile?.close(), manifestFile?.close()]);
    if (!complete) {
      if (traceCreated) await unlink(tracePath).catch(() => {});
      if (manifestCreated) await unlink(manifestPath).catch(() => {});
    }
  }
}

async function requireMissing(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Output already exists');
}

async function preflightTurnOutput(outputPath: string): Promise<void> {
  const tracePath = resolve(outputPath);
  await requireMissing(tracePath);
  await requireMissing(`${tracePath}.manifest.json`);
}

async function verifyJsonl(path: string): Promise<number> {
  const inputPath = resolve(path);
  const metadata = await stat(inputPath);
  if (!metadata.isFile() || metadata.size > MAX_REPLAY_BYTES) {
    throw new Error('Replay input is not a bounded regular file');
  }
  const lines = createInterface({ input: createReadStream(inputPath), crlfDelay: Infinity });
  let count = 0;
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > MAX_REPLAY_LINE_BYTES) throw new Error(`Replay line ${lineNumber} is too large`);
    count += 1;
    if (count > MAX_REPLAY_RECORDS) throw new Error('Replay input has too many records');
    let parsed: unknown;
    try { parsed = JSON.parse(line); }
    catch { throw new Error(`Replay line ${lineNumber} is not valid JSON`); }
    verifyJevTrace(parsed as ParallelTurnTrace);
  }
  return count;
}

async function exportRecords(outputPath: string, gameId?: string): Promise<number> {
  const profileFile = process.env.MONGJIN_PROFILE_DATA_FILE ?? join(process.cwd(), 'data', 'profiles.json');
  const store = await createJevRecordStore(
    join(dirname(profileFile), 'jev-decisions'),
    process.env.DATABASE_URL,
  );
  const path = resolve(outputPath);
  let output: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  let complete = false;
  let count = 0;
  try {
    output = await open(path, 'wx', 0o600);
    created = true;
    for await (const record of store.records(gameId)) {
      await output.write(`${JSON.stringify(record)}\n`);
      count += 1;
    }
    complete = true;
    return count;
  } finally {
    await output?.close();
    await store.close();
    if (created && !complete) await unlink(path).catch(() => {});
  }
}

async function liveKey(keyFile?: string): Promise<string> {
  const key = keyFile === undefined
    ? process.env.AI_GATEWAY_API_KEY?.trim()
    : (await readFile(resolve(keyFile), 'utf8')).trim();
  if (!key) throw new Error(keyFile === undefined
    ? 'Live mode requires AI_GATEWAY_API_KEY or --key-file'
    : 'Live key file is empty');
  return key;
}

async function runTurn(outputPath: string, mode: 'mock' | 'live', keyFile?: string): Promise<void> {
  await preflightTurnOutput(outputPath);
  if (mode === 'live' && Date.now() >= Date.parse(JEV_EXPIRES_AT)) {
    throw new Error('Live JEV verification period has expired');
  }
  const apiKey = mode === 'mock' ? 'local-mock-key' : await liveKey(keyFile);
  let trace: ParallelTurnTrace;
  let failure: ParallelTurnError | undefined;
  try {
    const result = await chooseParallelJevMove({
      gameId: `local-verification-${randomUUID()}`,
      state: initialState(DEFAULT_CONFIG),
      config: DEFAULT_CONFIG,
      apiKey,
      deadlineMs: Date.now() + JEV_PARALLEL_POLICY.turnLimitMs,
      evaluate: mode === 'mock' ? mockEvaluateJev : evaluateJev,
    });
    trace = result.trace;
  } catch (error) {
    if (!(error instanceof ParallelTurnError)) throw error;
    trace = error.trace;
    failure = error;
  }
  verifyJevTrace(trace);
  await writeTurnOutput(outputPath, trace, {
    format: 'mongjin-jev-verification-manifest-1',
    createdAt: new Date().toISOString(),
    mode,
    traceCount: 1,
    model: JEV_MODEL,
    policy: JEV_PARALLEL_POLICY,
    versions: {
      analysis: JEV_ANALYSIS_VERSION,
      search: JEV_SEARCH_VERSION,
      extension: JEV_EXTENSION_POLICY_VERSION,
      protocol: JEV_PARALLEL_POLICY.protocolVersion,
    },
  });
  if (failure) throw new Error(`JEV turn failed: ${failure.code}`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      replay: { type: 'string' },
      out: { type: 'string' },
      mock: { type: 'boolean', default: false },
      live: { type: 'boolean', default: false },
      'key-file': { type: 'string' },
      export: { type: 'boolean', default: false },
      'game-id': { type: 'string' },
    },
  });

  const isTurn = values.mock || values.live;
  if (values.replay) {
    if (values.out || isTurn || values.export || values['key-file'] || values['game-id']) {
      throw new Error('--replay cannot be combined with other modes');
    }
    const count = await verifyJsonl(values.replay);
    console.log(`Verified ${count} trace(s).`);
    return;
  }
  if (values.export) {
    if (!values.out || isTurn || values['key-file']) throw new Error('--export requires only --out and optional --game-id');
    const count = await exportRecords(values.out, values['game-id']);
    console.log(`Exported ${count} trace(s).`);
    return;
  }
  if (values.mock === values.live) throw new Error('Choose exactly one of --mock or --live');
  if (!values.out) throw new Error('--out is required');
  if (values['game-id']) throw new Error('--game-id is only valid with --export');
  if (values['key-file'] && !values.live) throw new Error('--key-file is only valid with --live');
  await runTurn(values.out, values.live ? 'live' : 'mock', values['key-file']);
  console.log('Wrote 1 trace and 1 manifest.');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'JEV verification failed');
    process.exitCode = 1;
  });
}
