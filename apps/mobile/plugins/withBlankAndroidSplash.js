const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('@expo/config-plugins');

module.exports = function withBlankAndroidSplash(config) {
  return withDangerousMod(config, [
    'android',
    async (mod) => {
      const drawableDirectory = path.join(
        mod.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'res',
        'drawable',
      );
      await fs.promises.mkdir(drawableDirectory, { recursive: true });
      await fs.promises.writeFile(
        path.join(drawableDirectory, 'splashscreen_logo.xml'),
        '<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="1dp" android:height="1dp" android:viewportWidth="1" android:viewportHeight="1"><path android:fillColor="@android:color/transparent" android:pathData="M0,0h1v1h-1z" /></vector>\n',
      );
      return mod;
    },
  ]);
};
