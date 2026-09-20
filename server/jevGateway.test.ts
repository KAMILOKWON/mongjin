import { describe, expect, it, vi } from 'vitest';
import {
  evaluateJev,
  JEV_MODEL,
  JevError,
  type JevQuestion,
} from './jevGateway';

const apiKey = 'sk-secret-test-key-12345';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(text: string, status = 200, contentType = 'text/plain'): Response {
  return new Response(text, {
    status,
    headers: { 'Content-Type': contentType },
  });
}

function expectJevError(error: unknown, code: JevError['code'], status?: number): void {
  expect(error).toBeInstanceOf(JevError);
  expect((error as JevError).code).toBe(code);
  expect((error as JevError).status).toBe(status);
}

function makeMultiQuestions(): Record<string, JevQuestion> {
  const choiceCriteria: Record<string, string> = {
    c0: 'Choice 0',
    c1: 'Choice 1',
    c2: 'Choice 2',
    c3: 'Choice 3',
    c4: 'Choice 4',
    c5: 'Choice 5',
  };

  return {
    move: {
      type: 'choice',
      instructions: 'Select the optimal move.',
      criteria: choiceCriteria,
    },
    b0: { type: 'boolean', instructions: 'Is king safe?' },
    b1: { type: 'boolean', instructions: 'Is opponent threatened?' },
    b2: { type: 'boolean', instructions: 'Can advance center guard?' },
    b3: { type: 'boolean', instructions: 'Is reserve guard needed?' },
    b4: { type: 'boolean', instructions: 'Is winning sequence reachable?' },
  };
}

function makeSuccessPayload(
  questions: Record<string, JevQuestion>,
  overrides?: {
    cost?: unknown;
    model?: string;
    answers?: Record<string, unknown>;
    usage?: unknown;
  },
): Record<string, unknown> {
  const answers: Record<string, unknown> = {};

  for (const [id, q] of Object.entries(questions)) {
    if (q.type === 'choice') {
      const keys = Object.keys(q.criteria);
      const probabilities: Record<string, number> = {};
      const equalShare = 1 / keys.length;
      for (const k of keys) {
        probabilities[k] = equalShare;
      }
      answers[id] = {
        type: 'choice',
        choice: keys[0],
        probabilities,
        confidence: 0.95,
      };
    } else {
      answers[id] = {
        type: 'boolean',
        probability: 0.8,
      };
    }
  }

  return {
    model: overrides?.model ?? JEV_MODEL,
    answers: overrides?.answers ?? answers,
    usage: overrides?.usage ?? { inputTokens: 180, outputTokens: 35 },
    providerMetadata: {
      gateway: {
        cost: overrides?.cost !== undefined ? overrides.cost : 0,
        generationId: 'gen-multi-test',
      },
    },
  };
}

describe('evaluateJev', () => {
  it('succeeds with mocked fetch zero-cost multi-question (6 choices + 5 boolean)', async () => {
    const questions = makeMultiQuestions();
    const state = { turn: 'BLACK', board: 'test-board-state' };
    const payload = makeSuccessPayload(questions);

    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return jsonResponse(payload);
    }) as unknown as typeof fetch;

    const deadlineMs = Date.now() + 5000;
    const result = await evaluateJev({
      state,
      questions,
      apiKey,
      deadlineMs,
      fetchImpl,
    });

    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.input)).toBe('https://ai-gateway.vercel.sh/v1/evaluate');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(calls[0]!.init?.headers).toEqual({
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    });

    const parsedBody = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    expect(parsedBody).toEqual({
      model: 'typesafe-ai/jev',
      state,
      questions,
    });

    expect(result.model).toBe('typesafe-ai/jev');
    expect(result.cost).toBe(0);
    expect(result.inputTokens).toBe(180);
    expect(result.outputTokens).toBe(35);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.request).toEqual({
      model: 'typesafe-ai/jev',
      state,
      questions,
    });
    expect(result.response).toEqual(payload);

    // Verify choice answer structure
    const moveAns = result.answers.move;
    expect(moveAns?.type).toBe('choice');
    if (moveAns?.type === 'choice') {
      expect(moveAns.choice).toBe('c0');
      expect(moveAns.confidence).toBe(0.95);
      expect(Object.keys(moveAns.probabilities)).toHaveLength(6);
    }

    // Verify 5 boolean answers
    for (let i = 0; i < 5; i++) {
      const bAns = result.answers[`b${i}`];
      expect(bAns?.type).toBe('boolean');
      if (bAns?.type === 'boolean') {
        expect(bAns.probability).toBe(0.8);
      }
    }
  });

  describe('onResponse hook and API key sanitization', () => {
    it('calls onResponse with sanitized payload replacing any apiKey occurrence with [REDACTED]', async () => {
      const questions = makeMultiQuestions();
      const payload = makeSuccessPayload(questions);
      // Inject apiKey into response payload text
      (payload as any).leakedField = `Here is the key: ${apiKey} and again ${apiKey}`;
      (payload as any).nested = { secretKey: apiKey };

      let capturedResponse: any = null;
      const onResponse = vi.fn((val: unknown) => {
        capturedResponse = val;
      });

      const fetchImpl = vi.fn(async () => jsonResponse(payload)) as unknown as typeof fetch;
      const result = await evaluateJev({
        state: {},
        questions,
        apiKey,
        deadlineMs: Date.now() + 5000,
        fetchImpl,
        onResponse,
      });

      expect(onResponse).toHaveBeenCalledTimes(1);
      expect(capturedResponse).toBeDefined();
      expect(JSON.stringify(capturedResponse)).not.toContain(apiKey);
      expect(capturedResponse.leakedField).toBe('Here is the key: [REDACTED] and again [REDACTED]');
      expect(capturedResponse.nested.secretKey).toBe('[REDACTED]');

      // Result.response is also sanitized
      expect(JSON.stringify(result.response)).not.toContain(apiKey);
      expect((result.response as any).leakedField).toBe('Here is the key: [REDACTED] and again [REDACTED]');
    });

    it('invokes onResponse before validation fails on invalid or nonzero cost responses', async () => {
      const questions = makeMultiQuestions();
      // Nonzero cost payload with leaked key
      const payload = makeSuccessPayload(questions, { cost: 0.05 });
      (payload as any).note = `Ref for ${apiKey}`;

      let capturedOnNonzeroCost: any = null;
      const onResponse = vi.fn((val: unknown) => {
        capturedOnNonzeroCost = val;
      });

      const fetchImpl = vi.fn(async () => jsonResponse(payload)) as unknown as typeof fetch;
      await expect(
        evaluateJev({
          state: {},
          questions,
          apiKey,
          deadlineMs: Date.now() + 5000,
          fetchImpl,
          onResponse,
        }),
      ).rejects.toMatchObject({ code: 'non_free' });

      expect(onResponse).toHaveBeenCalledTimes(1);
      expect(capturedOnNonzeroCost).toBeDefined();
      expect(capturedOnNonzeroCost.note).toBe('Ref for [REDACTED]');
      expect(JSON.stringify(capturedOnNonzeroCost)).not.toContain(apiKey);
    });

    it('invokes onResponse before invalid_response error when answers are missing', async () => {
      const questions = makeMultiQuestions();
      const payload = makeSuccessPayload(questions);
      delete (payload.answers as any).move;

      let captured: any = null;
      const onResponse = vi.fn((val: unknown) => {
        captured = val;
      });

      const fetchImpl = vi.fn(async () => jsonResponse(payload)) as unknown as typeof fetch;
      await expect(
        evaluateJev({
          state: {},
          questions,
          apiKey,
          deadlineMs: Date.now() + 5000,
          fetchImpl,
          onResponse,
        }),
      ).rejects.toMatchObject({ code: 'invalid_response' });

      expect(onResponse).toHaveBeenCalledTimes(1);
      expect(captured).toBeDefined();
    });

    it('safely propagates onResponse callback failures as JevError invalid_response without resending', async () => {
      const questions = makeMultiQuestions();
      const payload = makeSuccessPayload(questions);

      const onResponse = vi.fn(() => {
        throw new Error('Callback failed intentionally');
      });

      const fetchImpl = vi.fn(async () => jsonResponse(payload)) as unknown as typeof fetch;
      await expect(
        evaluateJev({
          state: {},
          questions,
          apiKey,
          deadlineMs: Date.now() + 5000,
          fetchImpl,
          onResponse,
        }),
      ).rejects.toMatchObject({ code: 'invalid_response' });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });

  describe('HTTP error response body capturing and sanitization', () => {
    it('captures HTTP 403 customer_verification_required body with masked API key and throws safe http_error', async () => {
      const questions = makeMultiQuestions();
      const errorBody = {
        error: {
          code: 'customer_verification_required',
          message: `Verification required for token ${apiKey}`,
        },
      };

      let capturedError: any = null;
      const onResponse = vi.fn((val: unknown) => {
        capturedError = val;
      });

      const fetchImpl = vi.fn(async () => jsonResponse(errorBody, 403)) as unknown as typeof fetch;

      try {
        await evaluateJev({
          state: {},
          questions,
          apiKey,
          deadlineMs: Date.now() + 5000,
          fetchImpl,
          onResponse,
        });
        throw new Error('Expected evaluateJev to reject');
      } catch (err: unknown) {
        expectJevError(err, 'http_error', 403);
        expect((err as Error).message).toBe('JEV request failed with HTTP 403.');
        expect((err as Error).message).not.toContain(apiKey);
        expect((err as Error).message).not.toContain('customer_verification_required');
      }

      expect(onResponse).toHaveBeenCalledTimes(1);
      expect(capturedError).toBeDefined();
      expect(capturedError.status).toBe(403);
      expect(capturedError.error?.code).toBe('customer_verification_required');
      expect(capturedError.error?.message).toBe('Verification required for token [REDACTED]');
      expect(JSON.stringify(capturedError)).not.toContain(apiKey);
    });

    it('captures HTTP 429 rate limit body with masked API key and maintains http_429 error code', async () => {
      const questions = makeMultiQuestions();
      const errorBody = {
        error: {
          code: 'rate_limited',
          details: `Exceeded quota with ${apiKey}`,
        },
      };

      let capturedError: any = null;
      const onResponse = vi.fn((val: unknown) => {
        capturedError = val;
      });

      const fetchImpl = vi.fn(async () => jsonResponse(errorBody, 429)) as unknown as typeof fetch;

      try {
        await evaluateJev({
          state: {},
          questions,
          apiKey,
          deadlineMs: Date.now() + 5000,
          fetchImpl,
          onResponse,
        });
        throw new Error('Expected evaluateJev to reject');
      } catch (err: unknown) {
        expectJevError(err, 'http_429', 429);
        expect((err as Error).message).toBe('JEV request was rate limited.');
        expect((err as Error).message).not.toContain(apiKey);
        expect((err as Error).message).not.toContain('rate_limited');
      }

      expect(onResponse).toHaveBeenCalledTimes(1);
      expect(capturedError).toBeDefined();
      expect(capturedError.status).toBe(429);
      expect(capturedError.error?.code).toBe('rate_limited');
      expect(capturedError.error?.details).toBe('Exceeded quota with [REDACTED]');
      expect(JSON.stringify(capturedError)).not.toContain(apiKey);
    });

    it('captures non-JSON malformed HTTP 500 body with bounded length and masked API key', async () => {
      const questions = makeMultiQuestions();
      const largeHtml = `<html><body>500 Internal Error: key=${apiKey} ` + 'x'.repeat(5000) + '</body></html>';

      let capturedError: any = null;
      const onResponse = vi.fn((val: unknown) => {
        capturedError = val;
      });

      const fetchImpl = vi.fn(async () =>
        textResponse(largeHtml, 500, 'text/html'),
      ) as unknown as typeof fetch;

      try {
        await evaluateJev({
          state: {},
          questions,
          apiKey,
          deadlineMs: Date.now() + 5000,
          fetchImpl,
          onResponse,
        });
        throw new Error('Expected evaluateJev to reject');
      } catch (err: unknown) {
        expectJevError(err, 'http_error', 500);
        expect((err as Error).message).toBe('JEV request failed with HTTP 500.');
        expect((err as Error).message).not.toContain(apiKey);
        expect((err as Error).message).not.toContain('<html>');
      }

      expect(onResponse).toHaveBeenCalledTimes(1);
      expect(capturedError).toBeDefined();
      expect(capturedError.status).toBe(500);
      expect(typeof capturedError.body).toBe('string');
      expect(capturedError.body).toContain('[REDACTED]');
      expect(capturedError.body).not.toContain(apiKey);
      // Bounded output length (truncated)
      expect(capturedError.body.length).toBeLessThan(1200);
      expect(capturedError.body).toContain('[truncated]');
    });

    it('captures malformed non-JSON 200 OK body and rejects with invalid_response', async () => {
      const questions = makeMultiQuestions();
      const nonJsonBody = `Not a valid JSON response: ${apiKey}`;

      let captured: any = null;
      const onResponse = vi.fn((val: unknown) => {
        captured = val;
      });

      const fetchImpl = vi.fn(async () => textResponse(nonJsonBody, 200)) as unknown as typeof fetch;

      await expect(
        evaluateJev({
          state: {},
          questions,
          apiKey,
          deadlineMs: Date.now() + 5000,
          fetchImpl,
          onResponse,
        }),
      ).rejects.toMatchObject({ code: 'invalid_response' });

      expect(onResponse).toHaveBeenCalledTimes(1);
      expect(captured).toBeDefined();
      expect(captured.status).toBe(200);
      expect(captured.body).toBe('Not a valid JSON response: [REDACTED]');
      expect(captured.body).not.toContain(apiKey);
    });

    it('applies deadline timeout to HTTP error body reading', async () => {
      const questions = makeMultiQuestions();
      const fetchImpl = vi.fn(async () => ({
        ok: false,
        status: 500,
        text: () => new Promise<string>(() => undefined),
      }) as Response) as unknown as typeof fetch;

      await expect(
        evaluateJev({
          state: {},
          questions,
          apiKey,
          deadlineMs: Date.now() + 15,
          fetchImpl,
        }),
      ).rejects.toMatchObject({ code: 'timeout' });
    });

    it('applies external abort to HTTP error body reading', async () => {
      const questions = makeMultiQuestions();
      const controller = new AbortController();

      const fetchImpl = vi.fn(async () => ({
        ok: false,
        status: 500,
        text: () =>
          new Promise<string>((_resolve, reject) => {
            controller.signal.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          }),
      }) as Response) as unknown as typeof fetch;

      const promise = evaluateJev({
        state: {},
        questions,
        apiKey,
        deadlineMs: Date.now() + 5000,
        signal: controller.signal,
        fetchImpl,
      });

      controller.abort();
      await expect(promise).rejects.toMatchObject({ code: 'aborted' });
    });
  });

  describe('invalid or missing answers', () => {
    it('rejects when an answer for a requested question is missing', async () => {
      const questions = makeMultiQuestions();
      const payload = makeSuccessPayload(questions);
      delete (payload.answers as Record<string, unknown>).b4;

      const fetchImpl = vi.fn(async () => jsonResponse(payload)) as unknown as typeof fetch;
      await expect(
        evaluateJev({
          state: {},
          questions,
          apiKey,
          deadlineMs: Date.now() + 5000,
          fetchImpl,
        }),
      ).rejects.toMatchObject({ code: 'invalid_response' });
    });

    it('rejects when choice answer selects an unknown choice', async () => {
      const questions = makeMultiQuestions();
      const payload = makeSuccessPayload(questions);
      (payload.answers as any).move.choice = 'c999';

      const fetchImpl = vi.fn(async () => jsonResponse(payload)) as unknown as typeof fetch;
      await expect(
        evaluateJev({
          state: {},
          questions,
          apiKey,
          deadlineMs: Date.now() + 5000,
          fetchImpl,
        }),
      ).rejects.toMatchObject({ code: 'invalid_response' });
    });

    it.each(['__proto__', 'constructor'])(
      'rejects prototype-polluting choice key: %s',
      async (choice) => {
        const questions = makeMultiQuestions();
        const payload = makeSuccessPayload(questions);
        (payload.answers as any).move.choice = choice;

        const fetchImpl = vi.fn(async () => jsonResponse(payload)) as unknown as typeof fetch;
        await expect(
          evaluateJev({
            state: {},
            questions,
            apiKey,
            deadlineMs: Date.now() + 5000,
            fetchImpl,
          }),
        ).rejects.toMatchObject({ code: 'invalid_response' });
      },
    );

    it('rejects when choice probabilities distribution is incomplete', async () => {
      const questions = makeMultiQuestions();
      const payload = makeSuccessPayload(questions);
      delete (payload.answers as any).move.probabilities.c5;

      const fetchImpl = vi.fn(async () => jsonResponse(payload)) as unknown as typeof fetch;
      await expect(
        evaluateJev({
          state: {},
          questions,
          apiKey,
          deadlineMs: Date.now() + 5000,
          fetchImpl,
        }),
      ).rejects.toMatchObject({ code: 'invalid_response' });
    });

    it('rejects when choice probabilities sum is not normalized within 0.02', async () => {
      const questions = makeMultiQuestions();
      const payload = makeSuccessPayload(questions);
      (payload.answers as any).move.probabilities.c0 = 0.5; // Sum becomes ~1.33

      const fetchImpl = vi.fn(async () => jsonResponse(payload)) as unknown as typeof fetch;
      await expect(
        evaluateJev({
          state: {},
          questions,
          apiKey,
          deadlineMs: Date.now() + 5000,
          fetchImpl,
        }),
      ).rejects.toMatchObject({ code: 'invalid_response' });
    });

    it('accepts normalized probabilities within 0.02 threshold', async () => {
      const questions = {
        q: {
          type: 'choice' as const,
          instructions: 'test',
          criteria: { c0: '0', c1: '1' },
        },
      };
      // 0.49 + 0.50 = 0.99 (diff 0.01 <= 0.02)
      const payload = {
        model: JEV_MODEL,
        answers: {
          q: {
            type: 'choice',
            choice: 'c0',
            probabilities: { c0: 0.49, c1: 0.5 },
          },
        },
        usage: { inputTokens: 10, outputTokens: 5 },
        providerMetadata: { gateway: { cost: 0 } },
      };

      const fetchImpl = vi.fn(async () => jsonResponse(payload)) as unknown as typeof fetch;
      const result = await evaluateJev({
        state: {},
        questions,
        apiKey,
        deadlineMs: Date.now() + 5000,
        fetchImpl,
      });
      expect(result.answers.q?.type).toBe('choice');
    });

    it('rejects out-of-range confidence in choice answer', async () => {
      const questions = makeMultiQuestions();
      const payload = makeSuccessPayload(questions);
      (payload.answers as any).move.confidence = 1.05;

      const fetchImpl = vi.fn(async () => jsonResponse(payload)) as unknown as typeof fetch;
      await expect(
        evaluateJev({
          state: {},
          questions,
          apiKey,
          deadlineMs: Date.now() + 5000,
          fetchImpl,
        }),
      ).rejects.toMatchObject({ code: 'invalid_response' });
    });

    it('rejects out-of-range boolean probability', async () => {
      const questions = makeMultiQuestions();
      const payload = makeSuccessPayload(questions);
      (payload.answers as any).b0.probability = 1.2;

      const fetchImpl = vi.fn(async () => jsonResponse(payload)) as unknown as typeof fetch;
      await expect(
        evaluateJev({
          state: {},
          questions,
          apiKey,
          deadlineMs: Date.now() + 5000,
          fetchImpl,
        }),
      ).rejects.toMatchObject({ code: 'invalid_response' });
    });

    it('rejects invalid usage token counts', async () => {
      const questions = makeMultiQuestions();
      const payload = makeSuccessPayload(questions, {
        usage: { inputTokens: -5, outputTokens: 10 },
      });

      const fetchImpl = vi.fn(async () => jsonResponse(payload)) as unknown as typeof fetch;
      await expect(
        evaluateJev({
          state: {},
          questions,
          apiKey,
          deadlineMs: Date.now() + 5000,
          fetchImpl,
        }),
      ).rejects.toMatchObject({ code: 'invalid_response' });
    });
  });

  describe('wrong ID', () => {
    it('rejects when response contains unexpected answer ID', async () => {
      const questions = makeMultiQuestions();
      const payload = makeSuccessPayload(questions);
      (payload.answers as Record<string, unknown>).unrequested_question = {
        type: 'boolean',
        probability: 0.5,
      };

      const fetchImpl = vi.fn(async () => jsonResponse(payload)) as unknown as typeof fetch;
      await expect(
        evaluateJev({
          state: {},
          questions,
          apiKey,
          deadlineMs: Date.now() + 5000,
          fetchImpl,
        }),
      ).rejects.toMatchObject({ code: 'invalid_response' });
    });

    it('rejects when response answers map uses wrong question key', async () => {
      const questions = {
        q_expected: {
          type: 'boolean' as const,
          instructions: 'test',
        },
      };
      const payload = {
        model: JEV_MODEL,
        answers: {
          q_wrong: { type: 'boolean', probability: 0.5 },
        },
        usage: { inputTokens: 10, outputTokens: 2 },
        providerMetadata: { gateway: { cost: 0 } },
      };

      const fetchImpl = vi.fn(async () => jsonResponse(payload)) as unknown as typeof fetch;
      await expect(
        evaluateJev({
          state: {},
          questions,
          apiKey,
          deadlineMs: Date.now() + 5000,
          fetchImpl,
        }),
      ).rejects.toMatchObject({ code: 'invalid_response' });
    });
  });

  describe('nonzero and unknown cost', () => {
    it.each([0.00001, -1, 2, '0.005', '1'])(
      'rejects nonzero cost: %s with non_free code',
      async (cost) => {
        const questions = makeMultiQuestions();
        const payload = makeSuccessPayload(questions, { cost });

        const fetchImpl = vi.fn(async () => jsonResponse(payload)) as unknown as typeof fetch;
        try {
          await evaluateJev({
            state: {},
            questions,
            apiKey,
            deadlineMs: Date.now() + 5000,
            fetchImpl,
          });
          throw new Error('Expected evaluateJev to reject');
        } catch (error: unknown) {
          expectJevError(error, 'non_free');
          expect((error as Error).message).not.toContain(apiKey);
        }
      },
    );

    it.each([
      ['missing providerMetadata', undefined],
      ['missing gateway', {}],
      ['missing cost field', { gateway: {} }],
      ['string unknown', { gateway: { cost: 'unknown' } }],
      ['null cost', { gateway: { cost: null } }],
    ])('rejects %s with non_free code', async (_desc, providerMetadata) => {
      const questions = makeMultiQuestions();
      const payload = makeSuccessPayload(questions);
      if (providerMetadata === undefined) {
        delete (payload as any).providerMetadata;
      } else {
        (payload as any).providerMetadata = providerMetadata;
      }

      const fetchImpl = vi.fn(async () => jsonResponse(payload)) as unknown as typeof fetch;
      try {
        await evaluateJev({
          state: {},
          questions,
          apiKey,
          deadlineMs: Date.now() + 5000,
          fetchImpl,
        });
        throw new Error('Expected evaluateJev to reject');
      } catch (error: unknown) {
        expectJevError(error, 'non_free');
        expect((error as Error).message).not.toContain(apiKey);
      }
    });

    it('accepts string "0" cost reported by gateway', async () => {
      const questions = makeMultiQuestions();
      const payload = makeSuccessPayload(questions, { cost: '0' });

      const fetchImpl = vi.fn(async () => jsonResponse(payload)) as unknown as typeof fetch;
      const result = await evaluateJev({
        state: {},
        questions,
        apiKey,
        deadlineMs: Date.now() + 5000,
        fetchImpl,
      });
      expect(result.cost).toBe(0);
    });
  });

  describe('timeout during body read', () => {
    it('times out while reading response body before deadline', async () => {
      const questions = makeMultiQuestions();
      const fetchImpl = vi.fn(async () => ({
        ok: true,
        status: 200,
        text: () => new Promise<string>(() => undefined),
      }) as Response) as unknown as typeof fetch;

      await expect(
        evaluateJev({
          state: {},
          questions,
          apiKey,
          deadlineMs: Date.now() + 15,
          fetchImpl,
        }),
      ).rejects.toMatchObject({ code: 'timeout' });
    });
  });

  describe('external abort', () => {
    it('aborts when external signal is triggered during in-flight fetch', async () => {
      const questions = makeMultiQuestions();
      const controller = new AbortController();

      const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      }) as unknown as typeof fetch;

      const promise = evaluateJev({
        state: {},
        questions,
        apiKey,
        deadlineMs: Date.now() + 5000,
        signal: controller.signal,
        fetchImpl,
      });

      controller.abort();
      await expect(promise).rejects.toMatchObject({ code: 'aborted' });
    });

    it('immediately aborts if caller signal is already aborted', async () => {
      const questions = makeMultiQuestions();
      const controller = new AbortController();
      controller.abort();

      const fetchImpl = vi.fn(async () => {
        throw new Error('should not be called');
      }) as unknown as typeof fetch;

      await expect(
        evaluateJev({
          state: {},
          questions,
          apiKey,
          deadlineMs: Date.now() + 5000,
          signal: controller.signal,
          fetchImpl,
        }),
      ).rejects.toMatchObject({ code: 'aborted' });

      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe('expired deadline', () => {
    it('rejects with timeout and does not call fetch if deadline is already expired', async () => {
      const questions = makeMultiQuestions();
      const fetchImpl = vi.fn(async () => {
        throw new Error('fetchImpl must not be called when deadline is expired');
      }) as unknown as typeof fetch;

      await expect(
        evaluateJev({
          state: {},
          questions,
          apiKey,
          deadlineMs: Date.now() - 100,
          fetchImpl,
        }),
      ).rejects.toMatchObject({ code: 'timeout' });

      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe('input validation and gateway constraints', () => {
    it('rejects empty questions object', async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error('should not call');
      }) as unknown as typeof fetch;

      await expect(
        evaluateJev({
          state: {},
          questions: {},
          apiKey,
          deadlineMs: Date.now() + 5000,
          fetchImpl,
        }),
      ).rejects.toMatchObject({ code: 'invalid_response' });

      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('rejects choice question with empty choices', async () => {
      const questions: Record<string, JevQuestion> = {
        badChoice: {
          type: 'choice',
          instructions: 'no choices',
          criteria: {},
        },
      };

      const fetchImpl = vi.fn(async () => {
        throw new Error('should not call');
      }) as unknown as typeof fetch;

      await expect(
        evaluateJev({
          state: {},
          questions,
          apiKey,
          deadlineMs: Date.now() + 5000,
          fetchImpl,
        }),
      ).rejects.toMatchObject({ code: 'invalid_response' });

      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('rejects choice question with empty criterion string', async () => {
      const questions: Record<string, JevQuestion> = {
        badChoice: {
          type: 'choice',
          instructions: 'empty string criterion',
          criteria: { c0: '   ' },
        },
      };

      const fetchImpl = vi.fn(async () => {
        throw new Error('should not call');
      }) as unknown as typeof fetch;

      await expect(
        evaluateJev({
          state: {},
          questions,
          apiKey,
          deadlineMs: Date.now() + 5000,
          fetchImpl,
        }),
      ).rejects.toMatchObject({ code: 'invalid_response' });

      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('rejects boolean question with empty criteria true string', async () => {
      const questions: Record<string, JevQuestion> = {
        badBool: {
          type: 'boolean',
          instructions: 'empty bool criteria',
          criteria: { true: '', false: 'no' },
        },
      };

      const fetchImpl = vi.fn(async () => {
        throw new Error('should not call');
      }) as unknown as typeof fetch;

      await expect(
        evaluateJev({
          state: {},
          questions,
          apiKey,
          deadlineMs: Date.now() + 5000,
          fetchImpl,
        }),
      ).rejects.toMatchObject({ code: 'invalid_response' });

      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('rejects choice question with more than 255 choices', async () => {
      const criteria: Record<string, string> = {};
      for (let i = 0; i <= 255; i++) {
        criteria[`c${i}`] = `Choice ${i}`;
      }

      const questions: Record<string, JevQuestion> = {
        tooMany: {
          type: 'choice',
          instructions: 'over 255 choices',
          criteria,
        },
      };

      const fetchImpl = vi.fn(async () => {
        throw new Error('should not call');
      }) as unknown as typeof fetch;

      await expect(
        evaluateJev({
          state: {},
          questions,
          apiKey,
          deadlineMs: Date.now() + 5000,
          fetchImpl,
        }),
      ).rejects.toMatchObject({ code: 'invalid_response' });

      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('rejects wrong or missing model returned in gateway response', async () => {
      const questions = makeMultiQuestions();
      const payload = makeSuccessPayload(questions, { model: 'other-vendor/other-model' });

      const fetchImpl = vi.fn(async () => jsonResponse(payload)) as unknown as typeof fetch;
      await expect(
        evaluateJev({
          state: {},
          questions,
          apiKey,
          deadlineMs: Date.now() + 5000,
          fetchImpl,
        }),
      ).rejects.toMatchObject({ code: 'invalid_response' });
    });
  });
});
