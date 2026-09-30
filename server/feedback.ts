import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { domainToASCII } from 'node:url';
import type { FeedbackRecord, FeedbackStore } from './feedbackStore';

const MAX_BODY_BYTES = 20 * 1024;
const DEFAULT_RECIPIENT = 'hello@studiozzg.com';
const MAX_REQUESTS_PER_WINDOW = 5;
const RATE_WINDOW_MS = 60_000;
const MAX_RATE_LIMIT_KEYS = 10_000;
const MAX_FORWARDED_HOPS = 16;
const RESEND_TIMEOUT_MS = 10_000;
const SAFE_PENDING_RETRY_AGE_MS = 23 * 60 * 60 * 1000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTEXT_LIMITS = {
  appVersion: 64,
  platform: 32,
  osVersion: 128,
  language: 35,
  playerId: 128,
  screen: 80,
  mode: 40,
} as const;
const CONTEXT_REQUIRED = ['appVersion', 'platform', 'osVersion', 'language'] as const;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const MESSAGE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

export interface FeedbackContext {
  appVersion: string;
  platform: string;
  osVersion: string;
  language: string;
  playerId?: string;
  screen?: string;
  mode?: string;
}

export interface FeedbackSubmission {
  message: string;
  replyEmail?: string;
  context: FeedbackContext;
}

export interface FeedbackConfig {
  apiKey: string;
  from: string;
  to: string;
}

export interface FeedbackHandlerOptions {
  store?: FeedbackStore;
  getStore?: () => Promise<FeedbackStore>;
  /** Evaluated for each request so deployment configuration is read lazily. */
  getConfig?: () => FeedbackConfig | null;
  /** Injected in tests; production uses the native fetch implementation. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  createReceiptId?: () => string;
  rateLimit?: { limit: number; windowMs: number };
  /** Exact IP addresses for proxy peers permitted to supply X-Forwarded-For. */
  trustedProxyIps?: string[];
}

export interface LazyFeedbackHandlerOptions extends Omit<FeedbackHandlerOptions, 'store' | 'getStore'> {
  createStore: () => Promise<FeedbackStore>;
}

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
  retryAfter?: number;
}

class RequestError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}

class BodyTooLargeError extends Error {}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>, retryAfter?: number) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  if (retryAfter !== undefined) headers['Retry-After'] = String(retryAfter);
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function errorResult(status: number, code: string, message: string, retryAfter?: number): HttpResult {
  return { status, body: { code, message }, ...(retryAfter === undefined ? {} : { retryAfter }) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function characterCount(value: string): number {
  return Array.from(value).length;
}

function validateBoundedString(value: unknown, field: string, limit: number): string {
  if (typeof value !== 'string' || characterCount(value) > limit || CONTROL_CHARACTERS.test(value)) {
    throw new RequestError('INVALID_REQUEST', `${field} 값이 올바르지 않습니다.`);
  }
  return value.trim();
}

function isValidEmailAddress(value: string): boolean {
  if (value.length > 254 || /\s/u.test(value) || CONTROL_CHARACTERS.test(value)) return false;
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@')) return false;

  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (
    local.length > 64 ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..') ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/u.test(local)
  ) return false;

  const asciiDomain = domainToASCII(domain);
  if (!asciiDomain || asciiDomain.length > 253) return false;
  const labels = asciiDomain.split('.');
  if (labels.length < 2) return false;
  return labels.every(label =>
    label.length > 0 && label.length <= 63 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label));
}

function isSafeSender(value: string): boolean {
  if (value.length > 320 || CONTROL_CHARACTERS.test(value)) return false;
  const trimmed = value.trim();
  const wrapped = /^(.*?)\s*<([^<>]+)>$/u.exec(trimmed);
  if (wrapped) return isValidEmailAddress(wrapped[2]!);
  return isValidEmailAddress(trimmed);
}

function validateSubmission(value: unknown): { requestId: string; submission: FeedbackSubmission } {
  if (!isRecord(value)) throw new RequestError('INVALID_REQUEST', '요청 형식이 올바르지 않습니다.');
  const allowedTopLevel = new Set(['requestId', 'message', 'replyEmail', 'context']);
  if (Object.keys(value).some(key => !allowedTopLevel.has(key))) {
    throw new RequestError('INVALID_REQUEST', '요청에 허용되지 않은 항목이 있습니다.');
  }

  const rawRequestId = value.requestId;
  if (typeof rawRequestId !== 'string' || !UUID_PATTERN.test(rawRequestId)) {
    throw new RequestError('INVALID_REQUEST', '요청 ID는 UUID여야 합니다.');
  }
  const requestId = rawRequestId.toLowerCase();

  if (typeof value.message !== 'string') {
    throw new RequestError('INVALID_REQUEST', '문의 내용은 문자열이어야 합니다.');
  }
  const message = value.message.trim();
  const messageLength = characterCount(message);
  if (messageLength < 1 || messageLength > 3000 || MESSAGE_CONTROL_CHARACTERS.test(message)) {
    throw new RequestError('INVALID_REQUEST', '문의 내용은 공백을 제외하고 1~3000자여야 합니다.');
  }

  if (!isRecord(value.context)) throw new RequestError('INVALID_REQUEST', '기기 정보 형식이 올바르지 않습니다.');
  const allowedContext = new Set(Object.keys(CONTEXT_LIMITS));
  if (Object.keys(value.context).some(key => !allowedContext.has(key))) {
    throw new RequestError('INVALID_REQUEST', '기기 정보에 허용되지 않은 항목이 있습니다.');
  }

  const context = {} as FeedbackContext;
  for (const field of CONTEXT_REQUIRED) {
    if (!Object.hasOwn(value.context, field)) {
      throw new RequestError('INVALID_REQUEST', `${field} 값이 필요합니다.`);
    }
    context[field] = validateBoundedString(value.context[field], field, CONTEXT_LIMITS[field]);
  }
  for (const field of ['playerId', 'screen', 'mode'] as const) {
    if (Object.hasOwn(value.context, field)) {
      context[field] = validateBoundedString(value.context[field], field, CONTEXT_LIMITS[field]);
    }
  }

  const submission: FeedbackSubmission = { message, context };
  if (Object.hasOwn(value, 'replyEmail')) {
    if (typeof value.replyEmail !== 'string' || CONTROL_CHARACTERS.test(value.replyEmail)) {
      throw new RequestError('INVALID_REQUEST', '회신 이메일 주소가 올바르지 않습니다.');
    }
    const replyEmail = value.replyEmail.trim();
    if (!isValidEmailAddress(replyEmail)) {
      throw new RequestError('INVALID_REQUEST', '회신 이메일 주소가 올바르지 않습니다.');
    }
    submission.replyEmail = replyEmail;
  }
  return { requestId, submission };
}

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const length = Number(req.headers['content-length']);
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    req.resume();
    throw new BodyTooLargeError();
  }

  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        chunks.length = 0;
        rejectBody(new BodyTooLargeError());
        req.resume();
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolveBody(Buffer.concat(chunks));
    });
    req.on('aborted', () => {
      if (settled) return;
      settled = true;
      rejectBody(new RequestError('INVALID_REQUEST', '요청 본문을 읽지 못했습니다.'));
    });
    req.on('error', () => {
      if (settled) return;
      settled = true;
      rejectBody(new RequestError('INVALID_REQUEST', '요청 본문을 읽지 못했습니다.'));
    });
  });
}

function environmentConfig(): FeedbackConfig {
  return {
    apiKey: process.env.RESEND_API_KEY?.trim() ?? '',
    from: process.env.MONGJIN_FEEDBACK_FROM?.trim() ?? '',
    to: process.env.MONGJIN_FEEDBACK_TO?.trim() || DEFAULT_RECIPIENT,
  };
}

function isUsableConfig(value: FeedbackConfig | null): value is FeedbackConfig {
  return !!value &&
    typeof value.apiKey === 'string' && value.apiKey.trim().length > 0 && !CONTROL_CHARACTERS.test(value.apiKey) &&
    typeof value.from === 'string' && isSafeSender(value.from) &&
    typeof value.to === 'string' && isValidEmailAddress(value.to);
}

function payloadHash(submission: FeedbackSubmission): string {
  return createHash('sha256').update(JSON.stringify(submission), 'utf8').digest('hex');
}

function pendingDeliveryStateIsUnknown(record: FeedbackRecord, now: () => number): boolean {
  const createdAt = Date.parse(record.createdAt);
  return !Number.isFinite(createdAt) || now() - createdAt >= SAFE_PENDING_RETRY_AGE_MS;
}

function renderEmail(record: FeedbackRecord): { text: string; html: string } {
  const { submission, requestId } = record;
  const { context } = submission;
  const lines = [
    '몽진 인앱 문의',
    `요청 ID: ${requestId}`,
    `앱 버전: ${context.appVersion}`,
    `플랫폼: ${context.platform}`,
    `OS 버전: ${context.osVersion}`,
    `언어: ${context.language}`,
    ...(context.playerId === undefined ? [] : [`플레이어 ID: ${context.playerId}`]),
    ...(context.screen === undefined ? [] : [`화면: ${context.screen}`]),
    ...(context.mode === undefined ? [] : [`대전 모드: ${context.mode}`]),
    ...(submission.replyEmail === undefined ? [] : [`회신 이메일: ${submission.replyEmail}`]),
    '',
    '문의 내용:',
    submission.message,
  ];
  const text = lines.join('\n');
  return { text, html: `<pre style="white-space:pre-wrap;font:14px/1.5 sans-serif">${escapeHtml(text)}</pre>` };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, character => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return character;
    }
  });
}

async function sendNotification(record: FeedbackRecord, apiKey: string, fetchImpl: typeof fetch): Promise<boolean> {
  const rendered = renderEmail(record);
  const email: Record<string, unknown> = {
    from: record.from,
    to: [record.to],
    subject: `몽진 인앱 문의 ${record.requestId.slice(0, 8)}`,
    text: rendered.text,
    html: rendered.html,
  };
  if (record.submission.replyEmail !== undefined) email.reply_to = record.submission.replyEmail;

  try {
    const response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `mongjin-feedback-${record.requestId}`,
      },
      body: JSON.stringify(email),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function createRateLimiter(limit: number, windowMs: number, now: () => number) {
  const buckets = new Map<string, { startedAt: number; count: number }>();
  return (key: string): number | null => {
    const currentTime = now();
    let bucket = buckets.get(key);
    if (bucket && currentTime - bucket.startedAt >= windowMs) {
      buckets.delete(key);
      bucket = undefined;
    }
    if (!bucket) {
      if (buckets.size >= MAX_RATE_LIMIT_KEYS) {
        for (const [existingKey, existing] of buckets) {
          if (currentTime - existing.startedAt >= windowMs) buckets.delete(existingKey);
        }
        if (buckets.size >= MAX_RATE_LIMIT_KEYS) return Math.max(1, Math.ceil(windowMs / 1000));
      }
      buckets.set(key, { startedAt: currentTime, count: 1 });
      return null;
    }
    if (bucket.count >= limit) {
      return Math.max(1, Math.ceil((bucket.startedAt + windowMs - currentTime) / 1000));
    }
    bucket.count++;
    return null;
  };
}

function normalizeIp(value: string): string | null {
  const trimmed = value.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(trimmed);
  if (mapped && isIP(mapped[1]!) === 4) return mapped[1]!;
  return isIP(trimmed) ? trimmed.toLowerCase() : null;
}

function proxyAllowlist(values: string[]): Set<string> {
  return new Set(values.map(normalizeIp).filter((value): value is string => value !== null));
}

function rateLimitClientKey(req: IncomingMessage, trustedProxies: Set<string>): string {
  const remote = normalizeIp(req.socket.remoteAddress ?? '');
  if (!remote) return 'unknown';
  if (!trustedProxies.has(remote)) return remote;

  const header = req.headers['x-forwarded-for'];
  if (typeof header !== 'string' || !header.trim()) return remote;
  const forwarded = header.split(',');
  if (forwarded.length > MAX_FORWARDED_HOPS) return remote;
  const chain = forwarded.map(normalizeIp);
  if (chain.some(address => address === null)) return remote;

  const validForwarded: string[] = [];
  for (const address of chain) {
    if (address === null) return remote;
    validForwarded.push(address);
  }
  const resolved = [...validForwarded, remote];
  let index = resolved.length - 1;
  while (index > 0 && trustedProxies.has(resolved[index]!)) index--;
  return resolved[index]!;
}

async function processSubmission(
  requestId: string,
  submission: FeedbackSubmission,
  config: FeedbackConfig | null,
  store: FeedbackStore,
  rateLimit: (key: string) => number | null,
  clientKey: string,
  fetchImpl: typeof fetch,
  createReceiptId: () => string,
  now: () => number,
): Promise<HttpResult> {
  const hash = payloadHash(submission);
  let existing: FeedbackRecord | null;
  try {
    existing = await store.get(requestId);
  } catch {
    return errorResult(503, 'FEEDBACK_STORAGE_UNAVAILABLE', '문의 내용을 안전하게 저장하지 못했습니다. 다시 시도해 주세요.');
  }

  if (existing && existing.payloadHash !== hash) {
    return errorResult(400, 'REQUEST_ID_CONFLICT', '같은 요청 ID가 다른 문의 내용에 사용되었습니다.');
  }
  if (existing?.status === 'completed') {
    return { status: 201, body: { receiptId: existing.receiptId } };
  }
  if (existing?.status === 'pending' && pendingDeliveryStateIsUnknown(existing, now)) {
    return errorResult(503, 'FEEDBACK_DELIVERY_STATE_UNKNOWN', '문의 알림 상태를 확인해야 합니다. 저장된 문의는 보존되어 있습니다.');
  }
  if (!isUsableConfig(config)) {
    return errorResult(503, 'FEEDBACK_NOT_CONFIGURED', '문의 접수 기능이 아직 설정되지 않았습니다.');
  }

  const retryAfter = rateLimit(clientKey);
  if (retryAfter !== null) {
    return errorResult(429, 'RATE_LIMITED', '문의 요청이 잠시 많습니다. 잠시 후 다시 시도해 주세요.', retryAfter);
  }

  let record = existing;
  if (!record) {
    const candidate: FeedbackRecord = {
      schemaVersion: 1,
      requestId,
      payloadHash: hash,
      submission,
      receiptId: createReceiptId(),
      status: 'pending',
      createdAt: new Date(now()).toISOString(),
      from: config.from,
      to: config.to,
    };
    try {
      record = await store.createIfAbsent(candidate);
    } catch {
      return errorResult(503, 'FEEDBACK_STORAGE_UNAVAILABLE', '문의 내용을 안전하게 저장하지 못했습니다. 다시 시도해 주세요.');
    }
    if (record.payloadHash !== hash) {
      return errorResult(400, 'REQUEST_ID_CONFLICT', '같은 요청 ID가 다른 문의 내용에 사용되었습니다.');
    }
    if (record.status === 'completed') return { status: 201, body: { receiptId: record.receiptId } };
    if (pendingDeliveryStateIsUnknown(record, now)) {
      return errorResult(503, 'FEEDBACK_DELIVERY_STATE_UNKNOWN', '문의 알림 상태를 확인해야 합니다. 저장된 문의는 보존되어 있습니다.');
    }
  }

  try {
    return await store.withRecordLock(requestId, async (lockedRecord, save) => {
      if (lockedRecord.payloadHash !== hash) {
        return errorResult(400, 'REQUEST_ID_CONFLICT', '같은 요청 ID가 다른 문의 내용에 사용되었습니다.');
      }
      if (lockedRecord.status === 'completed') {
        return { status: 201, body: { receiptId: lockedRecord.receiptId } };
      }
      if (pendingDeliveryStateIsUnknown(lockedRecord, now)) {
        return errorResult(503, 'FEEDBACK_DELIVERY_STATE_UNKNOWN', '문의 알림 상태를 확인해야 합니다. 저장된 문의는 보존되어 있습니다.');
      }

      const accepted = await sendNotification(lockedRecord, config.apiKey, fetchImpl);
      if (!accepted) {
        return errorResult(503, 'FEEDBACK_DELIVERY_UNAVAILABLE', '문의 알림을 전달하지 못했습니다. 같은 요청으로 다시 시도해 주세요.');
      }

      const completed: FeedbackRecord = {
        ...lockedRecord,
        status: 'completed',
        completedAt: new Date(now()).toISOString(),
      };
      await save(completed);
      return { status: 201, body: { receiptId: completed.receiptId } };
    });
  } catch {
    return errorResult(503, 'FEEDBACK_STORAGE_UNAVAILABLE', '문의 내용을 안전하게 저장하지 못했습니다. 다시 시도해 주세요.');
  }
}

export function createFeedbackHandler(options: FeedbackHandlerOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const createReceiptId = options.createReceiptId ?? randomUUID;
  const configuredRate = options.rateLimit ?? { limit: MAX_REQUESTS_PER_WINDOW, windowMs: RATE_WINDOW_MS };
  const rateLimit = createRateLimiter(configuredRate.limit, configuredRate.windowMs, now);
  const trustedProxyValues = options.trustedProxyIps ?? process.env.MONGJIN_FEEDBACK_TRUSTED_PROXY_IPS?.split(',').map(value => value.trim()).filter(Boolean) ?? [];
  const trustedProxies = proxyAllowlist(trustedProxyValues);

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, OPTIONS');
      sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED', message: 'POST 요청만 지원합니다.' });
      return;
    }
    if ((req.headers['content-type'] ?? '').split(';', 1)[0]!.trim().toLowerCase() !== 'application/json') {
      req.resume();
      sendJson(res, 400, { code: 'INVALID_REQUEST', message: 'Content-Type은 application/json이어야 합니다.' });
      return;
    }

    try {
      const rawBody = await readRequestBody(req);
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody));
      } catch {
        throw new RequestError('INVALID_REQUEST', 'JSON 요청 본문이 올바르지 않습니다.');
      }
      const { requestId, submission } = validateSubmission(body);
      let config: FeedbackConfig | null;
      try {
        config = (options.getConfig ?? environmentConfig)();
      } catch {
        config = null;
      }
      let store = options.store;
      if (!store && !isUsableConfig(config)) {
        sendJson(res, 503, { code: 'FEEDBACK_NOT_CONFIGURED', message: '문의 접수 기능이 아직 설정되지 않았습니다.' });
        return;
      }
      if (!store && options.getStore) {
        try {
          store = await options.getStore();
        } catch {
          sendJson(res, 503, { code: 'FEEDBACK_STORAGE_UNAVAILABLE', message: '문의 저장소를 사용할 수 없습니다. 다시 시도해 주세요.' });
          return;
        }
      }
      if (!store) {
        sendJson(res, 503, { code: 'FEEDBACK_STORAGE_UNAVAILABLE', message: '문의 저장소를 사용할 수 없습니다. 다시 시도해 주세요.' });
        return;
      }
      const result = await processSubmission(
        requestId,
        submission,
        config,
        store,
        rateLimit,
        rateLimitClientKey(req, trustedProxies),
        fetchImpl,
        createReceiptId,
        now,
      );
      sendJson(res, result.status, result.body, result.retryAfter);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        sendJson(res, 413, { code: 'BODY_TOO_LARGE', message: '요청 본문은 20KB 이하여야 합니다.' });
      } else if (error instanceof RequestError) {
        sendJson(res, error.status, { code: error.code, message: error.message });
      } else {
        sendJson(res, 503, { code: 'FEEDBACK_STORAGE_UNAVAILABLE', message: '문의 내용을 안전하게 저장하지 못했습니다. 다시 시도해 주세요.' });
      }
    }
  };
}

export function createLazyFeedbackHandler(options: LazyFeedbackHandlerOptions) {
  const { createStore, ...handlerOptions } = options;
  let storePromise: Promise<FeedbackStore> | undefined;
  const getStore = (): Promise<FeedbackStore> => {
    if (!storePromise) {
      const attempt = Promise.resolve().then(createStore);
      const tracked = attempt.catch(error => {
        if (storePromise === tracked) storePromise = undefined;
        throw error;
      });
      storePromise = tracked;
    }
    return storePromise;
  };
  return createFeedbackHandler({ ...handlerOptions, getStore });
}
