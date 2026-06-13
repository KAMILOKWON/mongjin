/** 로컬/웹 빌드용 no-op. 토스 앱인토스 배포 시 `npm i @apps-in-toss/web-framework` 후 vite alias를 제거하세요. */
export const AppsInToss = {
  registerApp(_opts: { appName: string }) {},
};
