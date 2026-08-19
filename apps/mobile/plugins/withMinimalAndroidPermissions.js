const { withAndroidManifest } = require('@expo/config-plugins');

const UNUSED_PERMISSIONS = new Set([
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.SYSTEM_ALERT_WINDOW',
]);

module.exports = function withMinimalAndroidPermissions(config) {
  return withAndroidManifest(config, (mod) => {
    const permissions = mod.modResults.manifest['uses-permission'] ?? [];
    mod.modResults.manifest['uses-permission'] = permissions.filter(
      (permission) => !UNUSED_PERMISSIONS.has(permission.$?.['android:name']),
    );
    return mod;
  });
};
