import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMobileShell } from './detect';

function stub(opts: {
  search?: string;
  media?: Record<string, boolean>;
}) {
  vi.stubGlobal('location', { search: opts.search ?? '' } as Location);
  vi.stubGlobal('window', {
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
    stub({ search: '?desktop=1', media: { '(max-width: 720px)': true } });
    expect(useMobileShell()).toBe(false);
  });

  it('uses the mobile shell on phones', () => {
    stub({ media: { '(max-width: 720px)': true } });
    expect(useMobileShell()).toBe(true);
    stub({});
    expect(useMobileShell()).toBe(false);
  });
});
