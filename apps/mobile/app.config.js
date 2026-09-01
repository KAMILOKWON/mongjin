const TEST_ANDROID_APP_ID = 'ca-app-pub-3940256099942544~3347511713';
const TEST_IOS_APP_ID = 'ca-app-pub-3940256099942544~1458002511';

module.exports = ({ config }) => {
  const plugins = (config.plugins ?? []).filter((plugin) => {
    const name = Array.isArray(plugin) ? plugin[0] : plugin;
    return name !== 'react-native-google-mobile-ads';
  });

  return {
    ...config,
    plugins: [
      ...plugins,
      [
        'react-native-google-mobile-ads',
        {
          androidAppId: process.env.ADMOB_ANDROID_APP_ID || TEST_ANDROID_APP_ID,
          iosAppId: process.env.ADMOB_IOS_APP_ID || TEST_IOS_APP_ID,
          delayAppMeasurementInit: true,
          optimizeInitialization: true,
          optimizeAdLoading: true,
        },
      ],
    ],
    extra: {
      ...config.extra,
      admob: {
        androidBannerUnitId: process.env.ADMOB_ANDROID_BANNER_UNIT_ID || '',
        androidInterstitialUnitId: process.env.ADMOB_ANDROID_INTERSTITIAL_UNIT_ID || '',
        iosBannerUnitId: process.env.ADMOB_IOS_BANNER_UNIT_ID || '',
        iosInterstitialUnitId: process.env.ADMOB_IOS_INTERSTITIAL_UNIT_ID || '',
      },
    },
  };
};
