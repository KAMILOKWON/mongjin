import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MATCHMAKING_TIMEOUT_MS, OnlineClient } from './online';

describe('온라인 매칭 제한시간', () => {
  const sent: string[] = [];
  const originalWebSocket = globalThis.WebSocket;
  const originalWindow = (globalThis as typeof globalThis & { window?: unknown }).window;

  class FakeWebSocket {
    static OPEN = 1;
    readyState = FakeWebSocket.OPEN;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;

    constructor(public readonly url: string) {
      queueMicrotask(() => this.onopen?.());
    }

    send(message: string) {
      sent.push(message);
    }

    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    sent.length = 0;
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FakeWebSocket });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: originalWebSocket });
    if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  });

  it('상대가 없으면 15초 뒤 큐를 취소하고 폴백을 호출한다', async () => {
    const onMatchmakingTimeout = vi.fn();
    const client = new OnlineClient({
      onState: () => {},
      onJoined: () => {},
      onMatchFound: () => {},
      onMatchResult: () => {},
      onProfile: () => {},
      onOpponentLeft: () => {},
      onMatchmakingTimeout,
      onError: () => {},
      onStatus: () => {},
    }, 'ws://test');

    await client.startMatchmaking();
    expect(client.isQueued).toBe(true);
    await vi.advanceTimersByTimeAsync(MATCHMAKING_TIMEOUT_MS);

    expect(client.isQueued).toBe(false);
    expect(onMatchmakingTimeout).toHaveBeenCalledOnce();
    expect(sent.map((message) => JSON.parse(message).type)).toContain('CANCEL_MATCHMAKING');
    client.disconnect();
  });

  it('기존 웹 프로필 Elo를 서버 승계 메시지로 보낸다', async () => {
    const client = new OnlineClient({
      onState: () => {},
      onJoined: () => {},
      onMatchFound: () => {},
      onMatchResult: () => {},
      onProfile: () => {},
      onOpponentLeft: () => {},
      onMatchmakingTimeout: () => {},
      onError: () => {},
      onStatus: () => {},
    }, 'ws://test');

    await client.migrateLegacyProfile({ name: '웹고수', wins: 9, losses: 3, rating: 1310 });

    expect(sent.map((message) => JSON.parse(message))).toContainEqual({
      type: 'MIGRATE_LEGACY_PROFILE',
      legacyProfile: { name: '웹고수', wins: 9, losses: 3, rating: 1310 },
    });
    client.disconnect();
  });
});
