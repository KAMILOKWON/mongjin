import { request } from 'node:https';
import { readFileSync } from 'node:fs';
import { createDecipheriv, timingSafeEqual } from 'node:crypto';

/**
 * 토스 앱인토스 로그인 서버 연동.
 * 모든 환경변수는 선택 사항이며, 하나라도 빠지면 isTossLoginConfigured()가
 * false를 반환해 관련 경로가 자연스럽게 비활성화된다.
 */

const TOSS_API_HOST = 'apps-in-toss-api.toss.im';

export class TossApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly errorCode: string | null = null,
  ) {
    super(message);
    this.name = 'TossApiError';
  }
}

export function isTossLoginConfigured(): boolean {
  return Boolean(
    process.env.TOSS_MTLS_CERT_PATH &&
      process.env.TOSS_MTLS_KEY_PATH &&
      process.env.TOSS_DECRYPT_KEY &&
      process.env.TOSS_DECRYPT_AAD,
  );
}

let cachedMtls: { cert: Buffer; key: Buffer } | null = null;

function mtlsCredentials(): { cert: Buffer; key: Buffer } {
  if (!cachedMtls) {
    cachedMtls = {
      cert: readFileSync(process.env.TOSS_MTLS_CERT_PATH!),
      key: readFileSync(process.env.TOSS_MTLS_KEY_PATH!),
    };
  }
  return cachedMtls;
}

interface TossResponse<T> {
  resultType: 'SUCCESS' | 'FAIL';
  success?: T;
  error?: { errorCode: string; reason: string };
}

function tossRequest<T>(method: 'GET' | 'POST', path: string, options: { body?: unknown; accessToken?: string }): Promise<T> {
  const { cert, key } = mtlsCredentials();
  const payload = options.body === undefined ? null : JSON.stringify(options.body);
  return new Promise<T>((resolve, reject) => {
    const req = request(
      {
        host: TOSS_API_HOST,
        port: 443,
        method,
        path,
        cert,
        key,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new TossApiError(`토스 API HTTP ${res.statusCode}: ${text.slice(0, 200)}`, res.statusCode ?? null));
            return;
          }
          let parsed: TossResponse<T>;
          try {
            parsed = JSON.parse(text) as TossResponse<T>;
          } catch {
            reject(new TossApiError('토스 API 응답을 해석하지 못했습니다', res.statusCode ?? null));
            return;
          }
          if (parsed.resultType !== 'SUCCESS' || parsed.success === undefined) {
            reject(new TossApiError(parsed.error?.reason ?? '토스 API 요청이 실패했습니다', res.statusCode ?? null, parsed.error?.errorCode ?? null));
            return;
          }
          resolve(parsed.success);
        });
      },
    );
    req.on('error', (error) => reject(new TossApiError(`토스 API 연결 실패: ${error.message}`)));
    req.setTimeout(10_000, () => {
      req.destroy(new TossApiError('토스 API 응답 시간 초과'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

export interface TossTokenBundle {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
  tokenType: string;
}

export function exchangeAuthCode(authorizationCode: string, referrer: string): Promise<TossTokenBundle> {
  return tossRequest<TossTokenBundle>('POST', '/api-partner/v1/apps-in-toss/user/oauth2/generate-token', {
    body: { authorizationCode, referrer },
  });
}

export interface TossUserPayload {
  userKey: number;
  scope: string;
  agreedTerms: string[];
  name: string | null;
  phone: string | null;
  birthday: string | null;
  ci: string | null;
  di: string | null;
  gender: string | null;
  nationality: string | null;
  email: string | null;
}

export function fetchTossUser(accessToken: string): Promise<TossUserPayload> {
  return tossRequest<TossUserPayload>('GET', '/api-partner/v1/apps-in-toss/user/oauth2/login-me', { accessToken });
}

export function unlinkByUserKey(accessToken: string, userKey: number): Promise<unknown> {
  return tossRequest('POST', '/api-partner/v1/apps-in-toss/user/oauth2/access/remove-by-user-key', {
    accessToken,
    body: { userKey },
  });
}

/** AES-256-GCM 복호화: base64 = IV(12) + 암호문 + 인증 태그(16) */
export function decryptField(encrypted: string): string {
  const raw = Buffer.from(encrypted, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const ciphertext = raw.subarray(12, raw.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(process.env.TOSS_DECRYPT_KEY!, 'base64'), iv);
  decipher.setAAD(Buffer.from(process.env.TOSS_DECRYPT_AAD!, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export interface TossLoginResult {
  userKey: number;
  name: string | null;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export async function loginWithToss(authorizationCode: string, referrer: string): Promise<TossLoginResult> {
  const tokens = await exchangeAuthCode(authorizationCode, referrer);
  const user = await fetchTossUser(tokens.accessToken);
  let name: string | null = null;
  if (user.name) {
    try {
      name = decryptField(user.name);
    } catch (error) {
      console.error('[toss] 이름 복호화 실패:', error);
    }
  }
  return {
    userKey: user.userKey,
    name,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
  };
}

/** 연결 해제 콜백의 Basic 인증 검증 (타이밍 안전 비교) */
export function verifyCallbackBasicAuth(header: string | undefined): boolean {
  const expected = process.env.TOSS_CALLBACK_BASIC_AUTH;
  if (!expected || !header) return false;
  const match = /^Basic\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8');
  } catch {
    return false;
  }
  const a = Buffer.from(decoded, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
