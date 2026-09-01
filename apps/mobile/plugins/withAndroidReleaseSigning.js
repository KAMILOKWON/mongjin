const { withAppBuildGradle } = require('@expo/config-plugins');

const MARKER = '// mongjin: release signing is supplied by the macOS keychain';

module.exports = function withAndroidReleaseSigning(config) {
  return withAppBuildGradle(config, (mod) => {
    if (mod.modResults.contents.includes(MARKER)) return mod;

    const signingInputs = `
    ${MARKER}
    def mongjinKeystorePath = System.getenv('MONGJIN_ANDROID_KEYSTORE_PATH')
    def mongjinKeystorePassword = System.getenv('MONGJIN_ANDROID_KEYSTORE_PASSWORD')
    def mongjinKeyAlias = System.getenv('MONGJIN_ANDROID_KEY_ALIAS')
    def mongjinKeyPassword = System.getenv('MONGJIN_ANDROID_KEY_PASSWORD')
    def mongjinSigningReady = [
        mongjinKeystorePath,
        mongjinKeystorePassword,
        mongjinKeyAlias,
        mongjinKeyPassword,
    ].every { value -> value != null && !value.isBlank() }
`;

    const signingConfig = `        release {
            storeFile file(mongjinKeystorePath)
            storePassword mongjinKeystorePassword
            keyAlias mongjinKeyAlias
            keyPassword mongjinKeyPassword
        }
`;

    let contents = mod.modResults.contents.replace(
      'android {\n',
      `android {\n${signingInputs}`,
    );

    contents = contents.replace(
      '    signingConfigs {\n',
      `    signingConfigs {\n        if (mongjinSigningReady) {\n${signingConfig}        }\n`,
    );

    contents = contents.replace(
      /(    buildTypes \{\n        debug \{[\s\S]*?\n        \}\n        release \{[\s\S]*?            signingConfig )signingConfigs\.debug/,
      '$1(mongjinSigningReady ? signingConfigs.release : signingConfigs.debug)',
    );

    mod.modResults.contents = contents;
    return mod;
  });
};
