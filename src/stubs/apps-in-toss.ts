/** 로컬/웹 빌드용 no-op. 토스 앱인토스 배포 시 `npm i @apps-in-toss/web-framework` 후 vite alias를 제거하세요. */
export const AppsInToss = {
  registerApp(_opts: { appName: string }) {},
};

/** TDS 개발 서버의 의존성 사전 번들링에서 요구하는 웹용 기본값. */
export function getAppsInTossGlobals() {
  return {};
}

export function getSafeAreaInsets() {
  return { top: 0, right: 0, bottom: 0, left: 0 };
}
