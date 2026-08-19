const { withProjectBuildGradle } = require('@expo/config-plugins');

const MARKER = '// mongjin: allow the AdMob 25.x Kotlin metadata with the Expo 57 compiler';

module.exports = function withKotlinMetadataCompatibility(config) {
  return withProjectBuildGradle(config, (mod) => {
    if (mod.modResults.language !== 'groovy' || mod.modResults.contents.includes(MARKER)) return mod;

    mod.modResults.contents += `

${MARKER}
allprojects {
  tasks.withType(org.jetbrains.kotlin.gradle.tasks.KotlinCompile).configureEach {
    kotlinOptions {
      freeCompilerArgs += ['-Xskip-metadata-version-check']
    }
  }
}
`;
    return mod;
  });
};
