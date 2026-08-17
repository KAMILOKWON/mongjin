import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMobileShell } from './detect';

function stub(opts: {
  search?: string;
  native?: boolean;
  media?: Record<string, boolean>;
}) {
  vi.stubGlobal('location', { search: opts.search ?? '' } as Location);
  vi.stubGlobal('window', {
    Capacitor: opts.native ? { isNativePlatform: () => true } : undefined,
    matchMedia: (query: string) => ({ matches: opts.media?.[query] ?? false }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useMobileShell', () => {
  it('can be forced on or off with query flags', () => {
    stub({ search: '?app=1' });
    expect(useMobileShell()).toBe(true);
    stub({ search: '?desktop=1', native: true, media: { '(max-width: 720px)': true } });
    expect(useMobileShell()).toBe(false);
  });

  it('uses the mobile shell in the native app and on phones', () => {
    stub({ native: true });
    expect(useMobileShell()).toBe(true);
    stub({ media: { '(max-width: 720px)': true } });
    expect(useMobileShell()).toBe(true);
    stub({});
    expect(useMobileShell()).toBe(false);
  });
});
