import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState, legalMoves } from '../src/core/rules';
import { applyMove } from '../src/core/apply';
import type { Move } from '../src/core/types';
import { CommunityService } from './community';
import { FileCommunityStore } from './communityStore';
import { createMandakoHandler } from './mandako';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

describe('Mandako provenance across a pairing interruption', () => {
  it('saves an in-flight human move and returns the same verified AI reply on resume', async () => {
    const service = new CommunityService(new FileCommunityStore(null));
    const human = legalMoves(initialState(DEFAULT_CONFIG), DEFAULT_CONFIG)[0]!;
    const afterHuman = applyMove(initialState(DEFAULT_CONFIG), human);
    const ai = legalMoves(afterHuman, DEFAULT_CONFIG)[0]!;
    let release!: (move: Move) => void;
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const pending = new Promise<Move>(resolve => { release = resolve; });
    let queued = true;
    const infer = vi.fn(async () => { began(); return pending; });
    const handler = createMandakoHandler({
      authorize: (id, token) => queued && id === 'player' && token === 'credential',
      infer,
      beforePractice: (id, game, moves) => service.beforePractice(id, game, moves),
      savePracticeMove: (id, game, moves, reply) => service.savePracticeMove(id, game, moves, reply, 'test-checkpoint'),
    });
    const server = createServer((req, res) => { void handler(req, res); });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const post = () => fetch(`http://127.0.0.1:${address.port}/tournament/practice-move`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: 'player', token: 'credential', practiceId: 'game', moves: [human] }),
    });
    const first = post();
    await started;
    expect(await service.finishPractice('player', 'game', [human], 'interrupted')).toEqual({ saved: true, completed: false, completedCount: 0 });
    queued = false;
    release(ai);
    expect((await first).status).toBe(409);
    // A client missing the last AI response can also save its interruption.
    expect(await service.finishPractice('player', 'game', [human], 'interrupted')).toEqual({ saved: true, completed: false, completedCount: 0 });
    queued = true;
    const resumed = await post();
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toEqual({ move: ai, model: 'Mandako' });
    expect(infer).toHaveBeenCalledTimes(1);
    const receipt = await service.finishPractice('player', 'game', [human, ai], 'resign');
    expect(receipt).toEqual({ saved: true, completed: true, completedCount: 1 });
    expect(await service.finishPractice('player', 'game', [human, ai], 'resign')).toEqual(receipt);
  });

  it('rejects forged AI histories and rejects a different player copying a saved game', async () => {
    const service = new CommunityService(new FileCommunityStore(null));
    const human = legalMoves(initialState(DEFAULT_CONFIG), DEFAULT_CONFIG)[0]!;
    const state = applyMove(initialState(DEFAULT_CONFIG), human);
    const [ai, forged] = legalMoves(state, DEFAULT_CONFIG);
    await service.savePracticeMove('player', 'game', [human], ai!, 'test-checkpoint');
    await expect(service.finishPractice('player', 'game', [human, forged!], 'resign')).rejects.toThrow('INVALID_PRACTICE');
    await expect(service.finishPractice('other', 'game', [human, ai!], 'resign')).rejects.toThrow('INVALID_PRACTICE');
    expect(await service.store.list('practiceRecords')).toEqual([]);
  });
});
