import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  TossAds,
  loadFullScreenAd,
  showFullScreenAd,
  type TossAdsAttachBannerResult,
} from '@apps-in-toss/web-framework';

const TEST_INTERSTITIAL_AD_GROUP_ID = 'ait-ad-test-interstitial-id';
const TEST_BANNER_AD_GROUP_ID = 'ait-ad-test-banner-id';

const INTERSTITIAL_AD_GROUP_ID = import.meta.env.DEV
  ? TEST_INTERSTITIAL_AD_GROUP_ID
  : import.meta.env.VITE_TOSS_INTERSTITIAL_AD_GROUP_ID?.trim();

const BANNER_AD_GROUP_ID = import.meta.env.DEV
  ? TEST_BANNER_AD_GROUP_ID
  : import.meta.env.VITE_TOSS_BANNER_AD_GROUP_ID?.trim();

function isSupported(api: { isSupported?: () => boolean }): boolean {
  try {
    return typeof api.isSupported === 'function' && api.isSupported();
  } catch {
    return false;
  }
}

function reportAdError(scope: string, error: unknown): void {
  console.warn(`[mongjin:ads] ${scope}`, error);
}

let bannerInitialization: Promise<boolean> | null = null;

function initializeBannerAds(): Promise<boolean> {
  if (bannerInitialization) return bannerInitialization;
  bannerInitialization = new Promise((resolve) => {
    if (!isSupported(TossAds.initialize) || !isSupported(TossAds.attachBanner)) {
      resolve(false);
      return;
    }

    try {
      TossAds.initialize({
        callbacks: {
          onInitialized: () => resolve(true),
          onInitializationFailed: (error) => {
            reportAdError('배너 SDK 초기화 실패', error);
            resolve(false);
          },
        },
      });
    } catch (error) {
      reportAdError('배너 SDK 초기화 실패', error);
      resolve(false);
    }
  });
  return bannerInitialization;
}

/** 메인 화면 전용 고정 높이 리스트형 배너. */
export function HomeBannerAd() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(
    () => Boolean(BANNER_AD_GROUP_ID) && isSupported(TossAds.attachBanner),
  );

  useEffect(() => {
    if (!available || !BANNER_AD_GROUP_ID) return;
    let active = true;
    let attached: TossAdsAttachBannerResult | undefined;

    void initializeBannerAds().then((initialized) => {
      if (!active || !initialized || !containerRef.current) {
        if (active && !initialized) setAvailable(false);
        return;
      }

      try {
        attached = TossAds.attachBanner(BANNER_AD_GROUP_ID, containerRef.current, {
          theme: 'light',
          tone: 'blackAndWhite',
          variant: 'expanded',
          callbacks: {
            onNoFill: () => setAvailable(false),
            onAdFailedToRender: ({ error }) => {
              reportAdError('배너 렌더링 실패', error);
              setAvailable(false);
            },
          },
        });
      } catch (error) {
        reportAdError('배너 부착 실패', error);
        setAvailable(false);
      }
    });

    return () => {
      active = false;
      attached?.destroy();
    };
  }, [available]);

  if (!available) return null;
  return <div className="ait-home-banner" ref={containerRef} aria-label="광고" />;
}

interface InterstitialAdHandle {
  showAfterGame: () => void;
  cancelPending: () => void;
}

/**
 * 전면 광고를 게임 화면에서만 미리 불러오고 결과가 확정될 때 한 번 소비한다.
 * 로드가 늦으면 결과 화면에 머무는 동안 준비되는 즉시 표시한다.
 */
export function useGameInterstitialAd(enabled: boolean): InterstitialAdHandle {
  const enabledRef = useRef(enabled);
  const mountedRef = useRef(true);
  const loadedRef = useRef(false);
  const loadingRef = useRef(false);
  const pendingRef = useRef(false);
  const loadUnregisterRef = useRef<(() => void) | null>(null);
  const showUnregisterRef = useRef<(() => void) | null>(null);
  const [loadedVersion, setLoadedVersion] = useState(0);

  enabledRef.current = enabled;

  const showLoadedAd = useCallback(() => {
    if (
      !enabledRef.current ||
      !pendingRef.current ||
      !loadedRef.current ||
      !INTERSTITIAL_AD_GROUP_ID ||
      !isSupported(showFullScreenAd)
    ) {
      return;
    }

    pendingRef.current = false;
    loadedRef.current = false;
    showUnregisterRef.current?.();

    try {
      showUnregisterRef.current = showFullScreenAd({
        options: { adGroupId: INTERSTITIAL_AD_GROUP_ID },
        onEvent: (event) => {
          if (event.type === 'failedToShow') {
            reportAdError('전면 광고 표시 실패', event);
          }
          if (event.type === 'dismissed' || event.type === 'failedToShow') {
            showUnregisterRef.current?.();
            showUnregisterRef.current = null;
          }
        },
        onError: (error) => {
          reportAdError('전면 광고 표시 실패', error);
          showUnregisterRef.current?.();
          showUnregisterRef.current = null;
        },
      });
    } catch (error) {
      reportAdError('전면 광고 표시 실패', error);
    }
  }, []);

  const loadAd = useCallback(() => {
    if (
      !enabledRef.current ||
      loadedRef.current ||
      loadingRef.current ||
      !INTERSTITIAL_AD_GROUP_ID ||
      !isSupported(loadFullScreenAd)
    ) {
      return;
    }

    loadingRef.current = true;
    loadUnregisterRef.current?.();

    try {
      loadUnregisterRef.current = loadFullScreenAd({
        options: { adGroupId: INTERSTITIAL_AD_GROUP_ID },
        onEvent: (event) => {
          if (event.type !== 'loaded') return;
          loadingRef.current = false;
          loadedRef.current = true;
          if (mountedRef.current) setLoadedVersion((value) => value + 1);
        },
        onError: (error) => {
          loadingRef.current = false;
          reportAdError('전면 광고 로드 실패', error);
        },
      });
    } catch (error) {
      loadingRef.current = false;
      reportAdError('전면 광고 로드 실패', error);
    }
  }, []);

  useEffect(() => {
    if (enabled) loadAd();
    else pendingRef.current = false;
  }, [enabled, loadAd]);

  useEffect(() => {
    showLoadedAd();
  }, [loadedVersion, showLoadedAd]);

  useEffect(
    () => () => {
      mountedRef.current = false;
      pendingRef.current = false;
      loadUnregisterRef.current?.();
      showUnregisterRef.current?.();
    },
    [],
  );

  const showAfterGame = useCallback(() => {
    if (!enabledRef.current) return;
    pendingRef.current = true;
    showLoadedAd();
    if (!loadedRef.current) loadAd();
  }, [loadAd, showLoadedAd]);

  const cancelPending = useCallback(() => {
    pendingRef.current = false;
  }, []);

  return useMemo(
    () => ({ showAfterGame, cancelPending }),
    [cancelPending, showAfterGame],
  );
}
