import { useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import Constants from 'expo-constants';
import mobileAds, {
  AdEventType,
  AdsConsent,
  BannerAd,
  BannerAdSize,
  InterstitialAd,
  TestIds,
  useForeground,
} from 'react-native-google-mobile-ads';

type AdMobConfig = {
  androidBannerUnitId?: string;
  androidInterstitialUnitId?: string;
  iosBannerUnitId?: string;
  iosInterstitialUnitId?: string;
};

const config = (Constants.expoConfig?.extra?.admob ?? {}) as AdMobConfig;
const bannerUnitId = __DEV__
  ? TestIds.ADAPTIVE_BANNER
  : Platform.select({
      android: config.androidBannerUnitId,
      ios: config.iosBannerUnitId,
      default: undefined,
    }) || TestIds.ADAPTIVE_BANNER;
const interstitialUnitId = __DEV__
  ? TestIds.INTERSTITIAL
  : Platform.select({
      android: config.androidInterstitialUnitId,
      ios: config.iosInterstitialUnitId,
      default: undefined,
    }) || TestIds.INTERSTITIAL;

let initialization: Promise<void> | null = null;
let sdkStart: Promise<boolean> | null = null;
let interstitial: InterstitialAd | null = null;
let interstitialLoaded = false;
let adsReady = false;
const readyListeners = new Set<(ready: boolean) => void>();

function notifyReady(ready: boolean) {
  adsReady = ready;
  readyListeners.forEach((listener) => listener(ready));
}

function prepareInterstitial() {
  if (interstitial) {
    interstitial.load();
    return;
  }

  interstitial = InterstitialAd.createForAdRequest(interstitialUnitId);
  interstitial.addAdEventListener(AdEventType.LOADED, () => {
    interstitialLoaded = true;
  });
  interstitial.addAdEventListener(AdEventType.CLOSED, () => {
    interstitialLoaded = false;
    interstitial?.load();
  });
  interstitial.addAdEventListener(AdEventType.ERROR, () => {
    interstitialLoaded = false;
    interstitial?.load();
  });
  interstitial.load();
}

async function startSdkIfAllowed(): Promise<boolean> {
  if (sdkStart) return sdkStart;

  sdkStart = (async () => {
    try {
      const { canRequestAds } = await AdsConsent.getConsentInfo();
      if (!canRequestAds) {
        sdkStart = null;
        return false;
      }

      await mobileAds().initialize();
      prepareInterstitial();
      notifyReady(true);
      return true;
    } catch {
      sdkStart = null;
      return false;
    }
  })();

  return sdkStart;
}

export function initializeAds(): Promise<void> {
  if (initialization) return initialization;

  initialization = (async () => {
    try {
      await AdsConsent.gatherConsent();
    } catch {
      // The SDK can still reuse a valid consent state from a prior launch.
    }
    await startSdkIfAllowed();
  })();

  return initialization;
}

export async function showGameOverInterstitial(): Promise<boolean> {
  await initializeAds();
  if (!interstitial || !interstitialLoaded) {
    interstitial?.load();
    return false;
  }

  interstitialLoaded = false;
  try {
    await interstitial.show();
    return true;
  } catch {
    interstitial.load();
    return false;
  }
}

export function HomeBannerAd() {
  const bannerRef = useRef<BannerAd>(null);
  const [ready, setReady] = useState(adsReady);

  useEffect(() => {
    const listener = (next: boolean) => setReady(next);
    readyListeners.add(listener);
    void initializeAds();
    return () => { readyListeners.delete(listener); };
  }, []);

  useForeground(() => {
    if (Platform.OS === 'ios') bannerRef.current?.load();
  });

  if (!ready) return null;

  return (
    <View style={{ minHeight: 50, alignItems: 'center', justifyContent: 'flex-end' }}>
      <BannerAd
        ref={bannerRef}
        unitId={bannerUnitId}
        size={BannerAdSize.ANCHORED_ADAPTIVE_BANNER}
      />
    </View>
  );
}
