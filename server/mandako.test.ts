import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMove } from '../src/core/apply';
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState, legalMoves } from '../src/core/rules';
import type { GameState, Move } from '../src/core/types';
import { createMandakoHandler, replayPractice } from './mandako';
import { actionId, moveForAction } from './mandakoCodec';

const servers: Server[] = [];

async function withEndpoint(
  infer: (state: GameState) => Promise<Move>,
  authorize: (playerId: string, token: string) => boolean = () => true,
  body: unknown = { playerId: 'p1', token: 't1', moves: [legalMoves(initialState(DEFAULT_CONFIG), DEFAULT_CONFIG)[0]] },
): Promise<Response> {
  const handler = createMandakoHandler({ infer, authorize });
  const server = createServer((req, res) => { void handler(req, res); });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No ephemeral server address');
  return fetch(`http://127.0.0.1:${address.port}/tournament/practice-move`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

describe('Mandako practice replay and codec', () => {
  it('rejects malformed, out-of-turn, and illegal histories', () => {
    expect(() => replayPractice({})).toThrow();
    expect(() => replayPractice([])).toThrow(/Not computer turn/);
    expect(() => replayPractice([{ kind: 'PLACE', to: { r: 8, c: 4 } }])).toThrow(/Illegal move/);
    expect(() => replayPractice([{ kind: 'MOVE', to: { r: 1, c: 2 } }])).toThrow(/Invalid move/);
  });

  it.each(['BLACK', 'WHITE'] as const)('round-trips every legal %s action', player => {
    let state = initialState(DEFAULT_CONFIG);
    if (player === 'WHITE') state = applyMove(state, legalMoves(state, DEFAULT_CONFIG)[0]!);
    for (const move of legalMoves(state, DEFAULT_CONFIG)) {
      expect(moveForAction(state, actionId(state, move))).toEqual(move);
    }
  });
});

describe('Mandako practice HTTP handler', () => {
  it('requires queue authorization and rejects history that is not the computer turn', async () => {
    const unauthorized = await withEndpoint(async () => { throw new Error('must not infer'); }, () => false);
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: 'NOT_QUEUED' });
    const malformed = await withEndpoint(async () => { throw new Error('must not infer'); }, () => true, { playerId: 'p1', token: 't1', moves: [] });
    expect(malformed.status).toBe(400);
  });

  it('returns busy for overlapping work and 409 when the player leaves the queue during inference', async () => {
    let release!: (move: Move) => void;
    const pending = new Promise<Move>(resolve => { release = resolve; });
    const busyBody = { playerId: 'p1', token: 't1', moves: [legalMoves(initialState(DEFAULT_CONFIG), DEFAULT_CONFIG)[0]] };
    const createHandler = createMandakoHandler({ infer: () => pending, authorize: () => true });
    const server = createServer((req, res) => { void createHandler(req, res); });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No ephemeral server address');
    const url = `http://127.0.0.1:${address.port}/tournament/practice-move`;
    const request = () => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(busyBody) });
    const first = request();
    await new Promise(resolve => setTimeout(resolve, 10));
    const second = await request();
    expect(second.status).toBe(429);
    const validMove = legalMoves(replayPractice(busyBody.moves), DEFAULT_CONFIG)[0]!;
    release(validMove);
    const firstResponse = await first;
    expect(firstResponse.status).toBe(200);

    let queued = true;
    const stale = await withEndpoint(async state => {
      queued = false;
      return legalMoves(state, DEFAULT_CONFIG)[0]!;
    }, () => queued);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'NO_LONGER_QUEUED' });
  });

  it('returns 409 for stale inference and 503 without fabricating a fallback move', async () => {
    const unavailable = await withEndpoint(async () => { throw new Error('checkpoint failed'); });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: 'PRACTICE_UNAVAILABLE' });
  });
});
