/** 네이티브 앱·홈화면 추가·좁은 화면에서는 모바일 셸을 쓴다. `?desktop=1` / `?app=1`로 강제할 수 있다. */
export function useMobileShell(): boolean {
  const params = new URLSearchParams(globalThis.location?.search ?? '');
  if (params.get('desktop') === '1') return false;
  if (params.get('app') === '1') return true;

  if (globalThis.window?.Capacitor?.isNativePlatform?.()) return true;

  const media = globalThis.window?.matchMedia?.bind(globalThis.window);
  if (!media) return false;
  if (media('(display-mode: standalone)').matches) return true;
  if (media('(max-width: 720px)').matches) return true;
  if (media('(max-height: 540px) and (orientation: landscape)').matches) return true;
  return false;
}
