import { JevError, type JevErrorCode } from './jev';

export { JevError, type JevErrorCode };

export const JEV_MODEL = 'typesafe-ai/jev' as const;
export const EVALUATE_URL = 'https://ai-gateway.vercel.sh/v1/evaluate';
export const MAX_CHOICES = 255;
export const MAX_RAW_BODY_LENGTH = 1024;

export type JevQuestion =
  | {
      type: 'choice';
      instructions: string;
      criteria: Record<string, string>;
    }
  | {
      type: 'boolean';
      instructions: string;
      criteria?: { true: string; false: string };
    };

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence?: number;
}

export interface BooleanAnswer {
  type: 'boolean';
  probability: number;
}

export type JevAnswer = ChoiceAnswer | BooleanAnswer;

export interface EvaluateJevOptions {
  state: unknown;
  questions: Record<string, JevQuestion>;
  apiKey: string;
  deadlineMs: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  onResponse?: (value: unknown) => void;
}

export interface EvaluateJevResult {
  model: 'typesafe-ai/jev';
  answers: Record<string, ChoiceAnswer | BooleanAnswer>;
  request: {
    model: 'typesafe-ai/jev';
    state: unknown;
    questions: Record<string, JevQuestion>;
  };
  response: unknown;
  elapsedMs: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeApiKey<T>(value: T, apiKey: string): T {
  if (!apiKey || typeof apiKey !== 'string') return value;

  function sanitize(v: unknown): unknown {
    if (typeof v === 'string') {
      return v.replaceAll(apiKey, '[REDACTED]');
    }
    if (Array.isArray(v)) {
      return v.map(sanitize);
    }
    if (v !== null && typeof v === 'object') {
      const res: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(v)) {
        const sanitizedKey = key.replaceAll(apiKey, '[REDACTED]');
        res[sanitizedKey] = sanitize(val);
      }
      return res;
    }
    return v;
  }

  return sanitize(value) as T;
}

function processResponseBody(
  rawText: string,
  apiKey: string,
  status: number,
): { isJson: boolean; payload: unknown } {
  const sanitizedText = apiKey ? rawText.replaceAll(apiKey, '[REDACTED]') : rawText;
  try {
    const parsed = JSON.parse(sanitizedText);
    const sanitized = sanitizeApiKey(parsed, apiKey);
    return { isJson: true, payload: sanitized };
  } catch {
    const truncated = sanitizedText.length > MAX_RAW_BODY_LENGTH
      ? sanitizedText.slice(0, MAX_RAW_BODY_LENGTH) + '...[truncated]'
      : sanitizedText;
    return {
      isJson: false,
      payload: {
        status,
        body: truncated,
      },
    };
  }
}

function extractReportedCost(payload: Record<string, unknown>): number | null {
  const providerMetadata = payload.providerMetadata;
  if (!isRecord(providerMetadata)) return null;
  const gateway = providerMetadata.gateway;
  if (!isRecord(gateway) || !Object.hasOwn(gateway, 'cost')) return null;
  const raw = gateway.cost;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The gateway can wrap a missing upstream alias in HTTP 400 despite a valid public model ID. */
function isUnavailableProviderAlias(payload: unknown): boolean {
  if (!isRecord(payload) || !isRecord(payload.error) || payload.error.type !== 'AI_APICallError') return false;
  const param = payload.error.param;
  const metadata = payload.providerMetadata;
  if (!isRecord(param) || param.statusCode !== 400 || typeof param.message !== 'string'
    || !isRecord(metadata) || !isRecord(metadata.gateway) || !isRecord(metadata.gateway.routing)) return false;
  const routing = metadata.gateway.routing;
  if (routing.originalModelId !== JEV_MODEL || routing.canonicalSlug !== JEV_MODEL
    || routing.resolvedProvider !== 'typesafe-ai') return false;
  try {
    const detail: unknown = JSON.parse(param.message);
    return isRecord(detail) && detail.error_type === 'api_usage_error'
      && detail.message === 'Unknown model: jev-latest';
  } catch { return false; }
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function validateQuestions(questions: Record<string, JevQuestion>): void {
  if (!isRecord(questions)) {
    throw new JevError('invalid_response', 'Questions must be an object.');
  }
  const entries = Object.entries(questions);
  if (entries.length === 0) {
    throw new JevError('invalid_response', 'At least one question is required.');
  }

  for (const [key, question] of entries) {
    if (!isRecord(question)) {
      throw new JevError('invalid_response', `Question "${key}" must be an object.`);
    }
    if (typeof question.instructions !== 'string' || question.instructions.trim() === '') {
      throw new JevError('invalid_response', `Question "${key}" missing instructions.`);
    }

    if (question.type === 'choice') {
      if (!isRecord(question.criteria)) {
        throw new JevError('invalid_response', `Choice question "${key}" must have criteria object.`);
      }
      const choiceKeys = Object.keys(question.criteria);
      if (choiceKeys.length === 0) {
        throw new JevError('invalid_response', `Choice question "${key}" has empty choices.`);
      }
      if (choiceKeys.length > MAX_CHOICES) {
        throw new JevError('invalid_response', `Choice question "${key}" exceeds maximum of ${MAX_CHOICES} choices.`);
      }
      for (const [cKey, desc] of Object.entries(question.criteria)) {
        if (typeof desc !== 'string' || desc.trim() === '') {
          throw new JevError('invalid_response', `Choice question "${key}" criterion "${cKey}" must be a nonempty string.`);
        }
      }
    } else if (question.type === 'boolean') {
      if (question.criteria !== undefined) {
        if (!isRecord(question.criteria)) {
          throw new JevError('invalid_response', `Boolean question "${key}" has invalid criteria.`);
        }
        if (
          (Object.hasOwn(question.criteria, 'true') && (typeof question.criteria.true !== 'string' || question.criteria.true.trim() === ''))
          || (Object.hasOwn(question.criteria, 'false') && (typeof question.criteria.false !== 'string' || question.criteria.false.trim() === ''))
        ) {
          throw new JevError('invalid_response', `Boolean question "${key}" criteria strings must be nonempty.`);
        }
      }
    } else {
      throw new JevError('invalid_response', `Question "${key}" has unsupported question type.`);
    }
  }
}

export async function evaluateJev(options: EvaluateJevOptions): Promise<EvaluateJevResult> {
  validateQuestions(options.questions);

  const startedAt = Date.now();
  if (typeof options.deadlineMs !== 'number' || !Number.isFinite(options.deadlineMs)) {
    throw new JevError('invalid_response', 'Invalid deadlineMs.');
  }

  const timeoutMs = options.deadlineMs - startedAt;
  if (timeoutMs <= 0) {
    throw new JevError('timeout', 'JEV evaluation deadline expired before request.');
  }

  if (options.signal?.aborted) {
    throw new JevError('aborted', 'JEV evaluation was aborted.');
  }

  const controller = new AbortController();
  let stoppedBy: 'timeout' | 'aborted' | undefined;

  const stop = (reason: 'timeout' | 'aborted') => {
    if (stoppedBy) return;
    stoppedBy = reason;
    controller.abort(new DOMException(reason === 'timeout' ? 'Timed out' : 'Aborted', 'AbortError'));
  };

  const onCallerAbort = () => stop('aborted');
  if (options.signal?.aborted) {
    onCallerAbort();
  } else {
    options.signal?.addEventListener('abort', onCallerAbort, { once: true });
  }

  const timer = setTimeout(() => stop('timeout'), timeoutMs);

  const throwRequestError = (error: unknown): never => {
    if (stoppedBy === 'timeout') throw new JevError('timeout', 'JEV request timed out.');
    if (stoppedBy === 'aborted') throw new JevError('aborted', 'JEV request was aborted.');
    if (error instanceof JevError) throw error;
    throw new JevError('http_error', 'JEV request failed.');
  };

  const requestBody = {
    model: JEV_MODEL,
    state: options.state,
    questions: options.questions,
  };

  try {
    let response: Response;
    try {
      response = await withAbort(
        (options.fetchImpl ?? fetch)(EVALUATE_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        }),
        controller.signal,
      );
    } catch (error: unknown) {
      return throwRequestError(error);
    }

    let rawText: string;
    try {
      rawText = await withAbort(response.text(), controller.signal);
    } catch (error: unknown) {
      if (stoppedBy) return throwRequestError(error);
      if (!response.ok) {
        if (options.onResponse) {
          try {
            options.onResponse({ status: response.status, error: 'unreadable_body' });
          } catch (_err: unknown) {
            throw new JevError('invalid_response', 'JEV onResponse callback failed.');
          }
        }
        if (response.status === 429) {
          throw new JevError('http_429', 'JEV request was rate limited.', response.status);
        }
        throw new JevError('http_error', `JEV request failed with HTTP ${response.status}.`, response.status);
      }
      throw new JevError('invalid_response', 'JEV returned an unreadable response.');
    }

    const { isJson, payload } = processResponseBody(rawText, options.apiKey, response.status);

    if (!response.ok) {
      const errorPayload = isJson
        ? (isRecord(payload)
            ? (Object.hasOwn(payload, 'status') ? payload : { status: response.status, ...payload })
            : { status: response.status, body: payload })
        : payload;

      if (options.onResponse) {
        try {
          options.onResponse(errorPayload);
        } catch (_error: unknown) {
          throw new JevError('invalid_response', 'JEV onResponse callback failed.');
        }
      }

      if (response.status === 429) {
        throw new JevError('http_429', 'JEV request was rate limited.', response.status);
      }
      if (response.status === 400 && isUnavailableProviderAlias(errorPayload)) {
        throw new JevError('provider_unavailable', 'JEV provider model alias is temporarily unavailable.', response.status);
      }
      throw new JevError('http_error', `JEV request failed with HTTP ${response.status}.`, response.status);
    }

    if (!isJson) {
      if (options.onResponse) {
        try {
          options.onResponse(payload);
        } catch (_error: unknown) {
          throw new JevError('invalid_response', 'JEV onResponse callback failed.');
        }
      }
      throw new JevError('invalid_response', 'JEV returned an unreadable response.');
    }

    const sanitizedPayload = payload;

    if (options.onResponse) {
      try {
        options.onResponse(sanitizedPayload);
      } catch (_error: unknown) {
        throw new JevError('invalid_response', 'JEV onResponse callback failed.');
      }
    }

    if (!isRecord(sanitizedPayload)) {
      throw new JevError('invalid_response', 'JEV returned a malformed response.');
    }
    if (!Object.hasOwn(sanitizedPayload, 'model') || sanitizedPayload.model !== JEV_MODEL) {
      throw new JevError('invalid_response', 'JEV returned an unexpected or missing model.');
    }

    const cost = extractReportedCost(sanitizedPayload);
    if (cost === null || cost !== 0) {
      throw new JevError('non_free', 'JEV evaluation reported missing, invalid, or nonzero cost.');
    }

    const usage = sanitizedPayload.usage;
    if (!isRecord(usage)) {
      throw new JevError('invalid_response', 'JEV returned missing or malformed usage metadata.');
    }
    const inputTokens = usage.inputTokens;
    const outputTokens = usage.outputTokens;
    if (
      typeof inputTokens !== 'number'
      || !Number.isSafeInteger(inputTokens)
      || inputTokens < 0
      || typeof outputTokens !== 'number'
      || !Number.isSafeInteger(outputTokens)
      || outputTokens < 0
    ) {
      throw new JevError('invalid_response', 'JEV returned invalid usage token counts.');
    }

    const rawAnswers = sanitizedPayload.answers;
    if (!isRecord(rawAnswers)) {
      throw new JevError('invalid_response', 'JEV returned missing or malformed answers.');
    }

    const questionKeys = Object.keys(options.questions);
    const answerKeys = Object.keys(rawAnswers);

    if (answerKeys.length !== questionKeys.length) {
      throw new JevError('invalid_response', 'JEV answers count does not match questions count.');
    }
    for (const qId of questionKeys) {
      if (!Object.hasOwn(rawAnswers, qId)) {
        throw new JevError('invalid_response', `JEV response missing answer for question "${qId}".`);
      }
    }
    for (const aId of answerKeys) {
      if (!Object.hasOwn(options.questions, aId)) {
        throw new JevError('invalid_response', `JEV response contains unexpected answer ID "${aId}".`);
      }
    }

    const answers: Record<string, ChoiceAnswer | BooleanAnswer> = {};

    for (const [qId, question] of Object.entries(options.questions)) {
      const rawAnswer = rawAnswers[qId];
      if (!isRecord(rawAnswer)) {
        throw new JevError('invalid_response', `Answer for "${qId}" must be an object.`);
      }

      if (question.type === 'choice') {
        if (rawAnswer.type !== 'choice') {
          throw new JevError('invalid_response', `Expected choice answer for "${qId}".`);
        }
        if (typeof rawAnswer.choice !== 'string') {
          throw new JevError('invalid_response', `Choice for "${qId}" must be a string.`);
        }
        if (!Object.hasOwn(question.criteria, rawAnswer.choice)) {
          throw new JevError('invalid_response', `Choice "${rawAnswer.choice}" for "${qId}" is not in supplied criteria.`);
        }

        const probs = rawAnswer.probabilities;
        if (!isRecord(probs)) {
          throw new JevError('invalid_response', `Probabilities for "${qId}" must be an object.`);
        }
        const criteriaKeys = Object.keys(question.criteria);
        const probKeys = Object.keys(probs);
        if (probKeys.length !== criteriaKeys.length) {
          throw new JevError('invalid_response', `Probabilities distribution for "${qId}" is incomplete.`);
        }

        let sum = 0;
        for (const choiceKey of criteriaKeys) {
          if (!Object.hasOwn(probs, choiceKey)) {
            throw new JevError('invalid_response', `Missing probability for choice "${choiceKey}" in "${qId}".`);
          }
          const p = probs[choiceKey];
          if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) {
            throw new JevError('invalid_response', `Probability for "${choiceKey}" in "${qId}" must be a finite number in [0, 1].`);
          }
          sum += p;
        }

        if (Math.abs(sum - 1) > 0.02) {
          throw new JevError('invalid_response', `Probabilities for "${qId}" do not sum to 1 within 0.02 (sum=${sum}).`);
        }

        let confidence: number | undefined;
        if (Object.hasOwn(rawAnswer, 'confidence') && rawAnswer.confidence !== undefined) {
          const conf = rawAnswer.confidence;
          if (typeof conf !== 'number' || !Number.isFinite(conf) || conf < 0 || conf > 1) {
            throw new JevError('invalid_response', `Confidence for "${qId}" must be a finite number in [0, 1].`);
          }
          confidence = conf;
        }

        answers[qId] = {
          type: 'choice',
          choice: rawAnswer.choice,
          probabilities: probs as Record<string, number>,
          ...(confidence !== undefined ? { confidence } : {}),
        };
      } else if (question.type === 'boolean') {
        if (rawAnswer.type !== 'boolean') {
          throw new JevError('invalid_response', `Expected boolean answer for "${qId}".`);
        }
        const prob = rawAnswer.probability;
        if (typeof prob !== 'number' || !Number.isFinite(prob) || prob < 0 || prob > 1) {
          throw new JevError('invalid_response', `Probability for boolean question "${qId}" must be a finite number in [0, 1].`);
        }
        answers[qId] = {
          type: 'boolean',
          probability: prob,
        };
      }
    }

    return {
      model: JEV_MODEL,
      answers,
      request: requestBody,
      response: sanitizedPayload,
      elapsedMs: Date.now() - startedAt,
      inputTokens,
      outputTokens,
      cost,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onCallerAbort);
  }
}
