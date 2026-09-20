import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, type RuleConfig } from '../src/core/config';
import { initialState, legalMoves } from '../src/core/rules';
import type { GameState } from '../src/core/types';
import { chooseJevMove, JevError } from './jev';

const apiKey = 'test-key';

function successPayload(
  criteria: Record<string, string>,
  choice = 'm0',
  cost: unknown = '0',
): Record<string, unknown> {
  return {
    model: 'typesafe-ai/jev',
    answers: {
      move: {
        type: 'choice',
        choice,
        probabilities: Object.fromEntries(
          Object.keys(criteria).map((key) => [key, key === choice ? 1 : 0]),
        ),
      },
    },
    usage: { inputTokens: 123, outputTokens: 7 },
    providerMetadata: { gateway: { cost, generationId: 'gen_test' } },
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fetchFrom(
  buildPayload: (body: Record<string, any>) => unknown,
): { fetchImpl: typeof fetch; calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> } {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    return jsonResponse(buildPayload(body));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function expectJevError(error: unknown, code: JevError['code'], status?: number): void {
  expect(error).toBeInstanceOf(JevError);
  expect((error as JevError).code).toBe(code);
  expect((error as JevError).status).toBe(status);
}

describe('chooseJevMove', () => {
  it('sends every legal move with compact rules and an anonymous board, then maps the chosen key locally', async () => {
    const state = initialState(DEFAULT_CONFIG);
    const before = structuredClone(state);
    const legal = legalMoves(state, DEFAULT_CONFIG);
    const { fetchImpl, calls } = fetchFrom((body) => successPayload(body.questions.move.criteria, 'm2'));

    const result = await chooseJevMove(state, DEFAULT_CONFIG, { apiKey, fetchImpl });

    expect(result).toEqual({
      move: legal[2],
      elapsedMs: expect.any(Number),
      model: 'typesafe-ai/jev',
      inputTokens: 123,
      outputTokens: 7,
      cost: 0,
    });
    expect(state).toEqual(before);
    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.input)).toBe('https://ai-gateway.vercel.sh/v1/evaluate');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(calls[0]!.init?.headers).toEqual({
      Authorization: 'Bearer test-key',
      'Content-Type': 'application/json',
    });

    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, any>;
    expect(body.model).toBe('typesafe-ai/jev');
    expect(body.questions.move.type).toBe('choice');
    expect(Object.keys(body.questions.move.criteria)).toEqual(legal.map((_, index) => `m${index}`));
    expect(body.questions.move.criteria).toEqual({
      m0: 'Place a SELF guard at (7,4).',
      m1: 'Move the SELF king from (8,4) to (7,4).',
      m2: 'Move the SELF king from (8,4) to (8,3).',
      m3: 'Move the SELF king from (8,4) to (8,5).',
      m4: 'Move the SELF king from (8,4) to (7,3).',
      m5: 'Move the SELF king from (8,4) to (7,5).',
    });
    expect(body.state.board).toEqual([
      '0: ....k....',
      '1: .........',
      '2: .........',
      '3: .........',
      '4: .........',
      '5: .........',
      '6: .........',
      '7: .........',
      '8: ....K....',
    ]);
    expect(body.state.boardLegend).toContain('K=SELF king');
    expect(body.state.coordinates).toContain('Zero-based (row,column)');
    expect(body.state.rules).toEqual(expect.arrayContaining([
      'A king moves one cell in any of eight directions, only to an empty cell.',
      'A guard moves one orthogonal step to an empty cell or captures an OPPONENT guard.',
      'A guard may capture the OPPONENT king for an immediate win.',
      'A side with no legal action loses.',
    ]));
    expect(JSON.stringify(body.state)).not.toMatch(/playerId|nickname|profile|BLACK|WHITE/);
  });

  it('still asks JEV when exactly one legal move exists', async () => {
    const config: RuleConfig = { ...DEFAULT_CONFIG, boardSize: 2, guardCount: 0 };
    const state: GameState = {
      board: [
        [{ player: 'BLACK', type: 'KING' }, null],
        [{ player: 'BLACK', type: 'GUARD' }, { player: 'BLACK', type: 'GUARD' }],
      ],
      turn: 'BLACK',
      guardsInHand: { BLACK: 0, WHITE: 0 },
      history: [],
      positionCounts: {},
    };
    expect(legalMoves(state, config)).toHaveLength(1);
    const { fetchImpl, calls } = fetchFrom((body) => successPayload(body.questions.move.criteria));
    const result = await chooseJevMove(state, config, { apiKey, fetchImpl });
    expect(calls).toHaveLength(1);
    expect(result.move).toEqual({ kind: 'MOVE', from: { r: 0, c: 0 }, to: { r: 0, c: 1 } });
  });

  it.each(['m999', '__proto__', 'constructor'])(
    'rejects an unknown or prototype-like selection: %s',
    async (choice) => {
      const state = initialState(DEFAULT_CONFIG);
      const { fetchImpl } = fetchFrom((body) => successPayload(body.questions.move.criteria, choice));
      await expect(chooseJevMove(state, DEFAULT_CONFIG, { apiKey, fetchImpl })).rejects.toSatisfy(
        (error: unknown) => {
          expectJevError(error, 'invalid_response');
          return true;
        },
      );
    },
  );

  it('rejects malformed answers and a wrong reported model without exposing response bodies', async () => {
    const state = initialState(DEFAULT_CONFIG);
    const malformed = fetchFrom(() => ({ answers: { move: { type: 'choice', choice: 'm0' } } }));
    await expect(chooseJevMove(state, DEFAULT_CONFIG, { apiKey, fetchImpl: malformed.fetchImpl }))
      .rejects.toMatchObject({ code: 'invalid_response' });

    const wrongModel = fetchFrom((body) => ({
      ...successPayload(body.questions.move.criteria),
      model: 'other/model',
      secret: 'must-not-appear',
    }));
    try {
      await chooseJevMove(state, DEFAULT_CONFIG, { apiKey, fetchImpl: wrongModel.fetchImpl });
      throw new Error('Expected chooseJevMove to reject');
    } catch (error: unknown) {
      expectJevError(error, 'invalid_response');
      expect((error as Error).message).not.toContain('must-not-appear');
    }
  });

  it.each([
    ['missing', undefined],
    ['invalid', 'unknown'],
  ])('returns unknown cost for %s cost metadata', async (_label, cost) => {
    const state = initialState(DEFAULT_CONFIG);
    const { fetchImpl } = fetchFrom((body) => {
      const payload = successPayload(body.questions.move.criteria);
      if (cost === undefined) delete (payload.providerMetadata as any).gateway.cost;
      else (payload.providerMetadata as any).gateway.cost = cost;
      return payload;
    });
    await expect(chooseJevMove(state, DEFAULT_CONFIG, { apiKey, fetchImpl }))
      .resolves.toMatchObject({ cost: null });
  });

  it('throws non_free for any explicit nonzero cost', async () => {
    const state = initialState(DEFAULT_CONFIG);
    for (const cost of ['0.00001155', -1, 2]) {
      const { fetchImpl } = fetchFrom((body) => successPayload(body.questions.move.criteria, 'm0', cost));
      await expect(chooseJevMove(state, DEFAULT_CONFIG, { apiKey, fetchImpl }))
        .rejects.toMatchObject({ code: 'non_free' });
    }
  });

  it('classifies rate limits, other HTTP failures, and transport failures', async () => {
    const state = initialState(DEFAULT_CONFIG);
    const rateLimited = vi.fn(async () => jsonResponse({ secret: 'hidden' }, 429)) as unknown as typeof fetch;
    await expect(chooseJevMove(state, DEFAULT_CONFIG, { apiKey, fetchImpl: rateLimited }))
      .rejects.toMatchObject({ code: 'http_429', status: 429 });

    const unavailable = vi.fn(async () => jsonResponse({ secret: 'hidden' }, 503)) as unknown as typeof fetch;
    await expect(chooseJevMove(state, DEFAULT_CONFIG, { apiKey, fetchImpl: unavailable }))
      .rejects.toMatchObject({ code: 'http_error', status: 503 });

    const failed = vi.fn(async () => { throw new Error('network secret'); }) as unknown as typeof fetch;
    try {
      await chooseJevMove(state, DEFAULT_CONFIG, { apiKey, fetchImpl: failed });
      throw new Error('Expected chooseJevMove to reject');
    } catch (error: unknown) {
      expectJevError(error, 'http_error');
      expect((error as Error).message).not.toContain('network secret');
    }
  });

  it('times out while reading the response body', async () => {
    const state = initialState(DEFAULT_CONFIG);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: () => new Promise<unknown>(() => undefined),
    }) as Response) as unknown as typeof fetch;
    await expect(chooseJevMove(state, DEFAULT_CONFIG, { apiKey, fetchImpl, timeoutMs: 10 }))
      .rejects.toMatchObject({ code: 'timeout' });
  });

  it('propagates an external abort as a typed aborted error and cleans up the request', async () => {
    const state = initialState(DEFAULT_CONFIG);
    const external = new AbortController();
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    })) as unknown as typeof fetch;
    const pending = chooseJevMove(state, DEFAULT_CONFIG, {
      apiKey,
      fetchImpl,
      signal: external.signal,
      timeoutMs: 1_000,
    });
    external.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
  });

  it('returns null without an HTTP call when there are no legal moves', async () => {
    const config: RuleConfig = { ...DEFAULT_CONFIG, boardSize: 1, guardCount: 0 };
    const state: GameState = {
      board: [[{ player: 'BLACK', type: 'KING' }]],
      turn: 'BLACK',
      guardsInHand: { BLACK: 0, WHITE: 0 },
      history: [],
      positionCounts: {},
    };
    const fetchImpl = vi.fn(async () => { throw new Error('must not call'); }) as unknown as typeof fetch;
    await expect(chooseJevMove(state, config, { apiKey, fetchImpl })).resolves.toEqual({
      move: null,
      elapsedMs: expect.any(Number),
      model: 'typesafe-ai/jev',
      inputTokens: null,
      outputTokens: null,
      cost: null,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects positions that exceed the gateway choice limit before an HTTP call', async () => {
    const config: RuleConfig = {
      ...DEFAULT_CONFIG,
      boardSize: 33,
      guardCount: 1,
      placement: 'own-half',
      noGuardOnGoal: false,
    };
    const state = initialState(config);
    expect(legalMoves(state, config).length).toBeGreaterThan(255);
    const fetchImpl = vi.fn(async () => { throw new Error('must not call'); }) as unknown as typeof fetch;
    await expect(chooseJevMove(state, config, { apiKey, fetchImpl }))
      .rejects.toMatchObject({ code: 'invalid_response' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
