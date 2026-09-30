import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { initialState, legalMoves } from '../src/core/rules';
import { DEFAULT_CONFIG } from '../src/core/config';
import { applyMove } from '../src/core/apply';
import { getResult } from '../src/core/result';
import type { GameState, Move } from '../src/core/types';
import { actionId, moveForAction } from './mandakoCodec';

function equalMove(a: Move, b: Move): boolean {
  return a.kind === b.kind && a.to.r === b.to.r && a.to.c === b.to.c &&
    (a.kind === 'PLACE' || (b.kind === 'MOVE' && a.from.r === b.from.r && a.from.c === b.from.c));
}

/** Replay practice only. No profile, event, or promotion repository is reachable here. */
export function replayPractice(moves: unknown): GameState {
  if (!Array.isArray(moves) || moves.length > 512) throw new Error('Invalid history');
  let state = initialState(DEFAULT_CONFIG);
  for (const raw of moves) {
    if (!raw || typeof raw !== 'object' || !raw.to ||
      !Number.isInteger(raw.to.r) || !Number.isInteger(raw.to.c) ||
      !['PLACE', 'MOVE'].includes(raw.kind) ||
      (raw.kind === 'MOVE' && (!raw.from || !Number.isInteger(raw.from.r) || !Number.isInteger(raw.from.c)))) {
      throw new Error('Invalid move');
    }
    if (getResult(state, DEFAULT_CONFIG)) throw new Error('Game finished');
    const move = legalMoves(state, DEFAULT_CONFIG).find(candidate => equalMove(candidate, raw));
    if (!move) throw new Error('Illegal move');
    state = applyMove(state, move);
  }
  if (state.turn !== 'WHITE' || getResult(state, DEFAULT_CONFIG)) throw new Error('Not computer turn');
  return state;
}

type Pending = { resolve: (action: number) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
class MandakoProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 0;
  private idle: NodeJS.Timeout | undefined;

  get pendingCount(): number { return this.pending.size; }

  private stop(): void {
    clearTimeout(this.idle);
    const child = this.child;
    this.child = null;
    child?.kill('SIGTERM');
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Mandako unavailable'));
    }
    this.pending.clear();
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/mandako-practice.mjs', import.meta.url))], {
      stdio: ['pipe', 'pipe', 'pipe'], env: process.env,
    });
    this.child = child;
    child.stderr.resume();
    child.stdin.on('error', () => { if (this.child === child) this.stop(); });
    child.on('error', () => { if (this.child === child) this.stop(); });
    child.on('exit', () => { if (this.child === child) this.stop(); });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      if (this.child !== child) return;
      try {
        const result = JSON.parse(line);
        const pending = this.pending.get(result.id);
        if (!pending) return;
        this.pending.delete(result.id);
        clearTimeout(pending.timer);
        if (Number.isInteger(result.action)) pending.resolve(result.action);
        else pending.reject(new Error('Mandako inference failed'));
        if (!this.pending.size) this.idle = setTimeout(() => this.stop(), 60_000).unref();
      } catch { this.stop(); }
    });
    return child;
  }

  async infer(state: GameState): Promise<Move> {
    if (this.pending.size >= 4) throw new Error('Mandako busy');
    clearTimeout(this.idle);
    const child = this.start();
    const id = ++this.nextId;
    const action = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => this.stop(), 20_000).unref();
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, state }) + '\n');
    });
    const move = moveForAction(state, action);
    if (!legalMoves(state, DEFAULT_CONFIG).some(candidate => actionId(state, candidate) === action)) {
      throw new Error('Mandako returned illegal move');
    }
    return move;
  }
}

export function createMandakoHandler(options: {
  authorize: (playerId: string, token: string) => boolean;
  beforePractice?: (playerId: string, practiceId: string, moves: Move[]) => Promise<Move | null>;
  savePracticeMove?: (playerId: string, practiceId: string, moves: Move[], move: Move) => Promise<void>;
  /** Test injection. Production uses the app's strongest built-in bot. */
  infer?: (state: GameState) => Promise<Move>;
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const models = [new MandakoProcess(), new MandakoProcess()];
  const infer = options.infer ?? ((state: GameState) => {
    const model = models[0]!.pendingCount <= models[1]!.pendingCount ? models[0]! : models[1]!;
    return model.infer(state);
  });
  const busy = new Set<string>();
  return async (req, res) => {
    if (req.url?.split('?')[0] !== '/tournament/practice-move') return false;
    const reply = (status: number, body: unknown): void => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST') { reply(405, { error: 'METHOD_NOT_ALLOWED' }); return true; }
    let input: { playerId?: unknown; token?: unknown; moves?: unknown; practiceId?: unknown };
    try {
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 65536) { reply(413, { error: 'BODY_TOO_LARGE' }); return true; }
        chunks.push(Buffer.from(chunk));
      }
      input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!input || typeof input !== 'object') throw new Error('Invalid body');
    } catch { reply(400, { error: 'INVALID_REQUEST' }); return true; }
    const { playerId, token } = input;
    if (typeof playerId !== 'string' || typeof token !== 'string' || !options.authorize(playerId, token)) {
      reply(401, { error: 'NOT_QUEUED' }); return true;
    }
    let state: GameState;
    try { state = replayPractice(input.moves); }
    catch { reply(400, { error: 'INVALID_PRACTICE' }); return true; }
    if (busy.has(playerId) || busy.size >= 8) { reply(429, { error: 'PRACTICE_BUSY' }); return true; }
    busy.add(playerId);
    try {
      const practiceId = input.practiceId;
      if (practiceId !== undefined && (typeof practiceId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(practiceId))) {
        reply(400, { error: 'INVALID_PRACTICE' }); return true;
      }
      const moves = input.moves as Move[];
      let cached: Move | null = null;
      if (typeof practiceId === 'string' && options.beforePractice) {
        try { cached = await options.beforePractice(playerId, practiceId, moves); }
        catch { reply(400, { error: 'INVALID_PRACTICE' }); return true; }
      }
      const move = cached ?? await infer(state);
      if (typeof practiceId === 'string' && options.savePracticeMove && !cached) {
        await options.savePracticeMove(playerId, practiceId, moves, move);
      }
      // Pairing may have occurred while the model was searching.
      if (!options.authorize(playerId, token)) reply(409, { error: 'NO_LONGER_QUEUED' });
      else reply(200, { move, model: 'Mandako' });
    } catch { reply(503, { error: 'PRACTICE_UNAVAILABLE' }); }
    finally { busy.delete(playerId); }
    return true;
  };
}
