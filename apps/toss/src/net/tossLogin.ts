import { appLogin } from '@apps-in-toss/web-framework';
import { saveIdentity } from './online';
import { resolveHttpUrl } from './wsUrl';

export interface TossLoginOutcome {
  ok: boolean;
  /** 로그인 시도 자체가 불가능한 환경(토스 외부)인지 */
  unavailable?: boolean;
  message?: string;
}

interface TossLoginResponse {
  playerId: string;
  token: string;
  profile: { playerId: string; name: string };
}

/**
 * 토스 로그인 인가 코드를 서버 세션으로 교환한다.
 * 성공하면 source:'toss' identity가 저장되어 이후 HELLO마다 같은 프로필로 인증된다.
 */
export async function loginWithToss(): Promise<TossLoginOutcome> {
  let authorizationCode: string;
  let referrer: string;
  try {
    const result = await appLogin();
    authorizationCode = result.authorizationCode;
    referrer = result.referrer;
  } catch {
    // 토스 앱 외부(일반 브라우저·개발 환경)에서는 토스 로그인을 쓸 수 없다.
    return { ok: false, unavailable: true };
  }
  try {
    const response = await fetch(`${resolveHttpUrl()}/auth/toss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authorizationCode, referrer }),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
      return { ok: false, message: payload?.message ?? '토스 로그인에 실패했습니다' };
    }
    const data = (await response.json()) as TossLoginResponse;
    if (!data?.playerId || !data?.token) {
      return { ok: false, message: '토스 로그인 응답이 올바르지 않습니다' };
    }
    saveIdentity({ playerId: data.playerId, token: data.token, source: 'toss' });
    return { ok: true };
  } catch {
    return { ok: false, message: '로그인 서버에 연결하지 못했습니다' };
  }
}
