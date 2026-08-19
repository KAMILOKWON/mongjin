/** 앱인토스 WebView 환경에서만 SDK를 초기화한다. 일반 웹/GitHub Pages에서는 no-op. */
export async function initAppsInToss(): Promise<void> {
  try {
    const { AppsInToss } = await import('@apps-in-toss/web-framework');
    AppsInToss.registerApp({ appName: 'mongjin' });
  } catch {
    // @apps-in-toss/web-framework 미설치 또는 토스 외부 환경
  }
}
