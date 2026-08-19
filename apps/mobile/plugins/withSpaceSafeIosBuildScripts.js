const { withPodfile, withXcodeProject } = require('@expo/config-plugins');

const PODFILE_MARKER = '# mongjin: support workspace paths containing spaces';
const BUNDLE_PHASE_NAME = '"Bundle React Native code and images"';
const LEGACY_BUNDLE_COMMAND =
  '`"$NODE_BINARY" --print "require(\'path\').dirname(require.resolve(\'react-native/package.json\')) + \'/scripts/react-native-xcode.sh\'"`';
const SAFE_BUNDLE_COMMAND = `RN_XCODE_SCRIPT="$("$NODE_BINARY" --print "require('path').dirname(require.resolve('react-native/package.json')) + '/scripts/react-native-xcode.sh'")"
/bin/bash "$RN_XCODE_SCRIPT"`;

function withSpaceSafePodfile(config) {
  return withPodfile(config, (mod) => {
    const contents = mod.modResults.contents;
    if (contents.includes(PODFILE_MARKER)) return mod;

    const targetClosing = '\n  end\nend\n';
    const insertionPoint = contents.lastIndexOf(targetClosing);
    if (insertionPoint === -1) {
      throw new Error('Could not find the iOS post_install block in the generated Podfile.');
    }

    const patch = `

    ${PODFILE_MARKER}
    installer.pods_project.targets.each do |target|
      next unless target.name == 'EXConstants'

      target.shell_script_build_phases.each do |phase|
        next unless phase.name == '[CP-User] Generate app.config for prebuilt Constants.manifest'

        phase.shell_script = <<~'SCRIPT'
          set -e
          unset npm_config_prefix

          # expo-constants' helper uses an unquoted basename(PROJECT_DIR), which
          # breaks when the workspace path contains spaces. Resolve every path
          # through quoted Xcode variables and invoke the config generator
          # directly.
          PROJECT_ROOT="$PODS_ROOT/../.."
          EXPO_CONSTANTS_PACKAGE_DIR="$PODS_TARGET_SRCROOT/.."
          RESOURCE_DEST="$CONFIGURATION_BUILD_DIR/EXConstants.bundle"
          if [ "\${BUNDLE_FORMAT:-shallow}" = "deep" ]; then
            RESOURCE_DEST="$RESOURCE_DEST/Contents/Resources"
          fi
          mkdir -p "$RESOURCE_DEST"
          "$EXPO_CONSTANTS_PACKAGE_DIR/scripts/with-node.sh" \
            "$EXPO_CONSTANTS_PACKAGE_DIR/scripts/getAppConfig.js" \
            "$PROJECT_ROOT" \
            "$RESOURCE_DEST"
        SCRIPT
      end
    end`;

    mod.modResults.contents =
      contents.slice(0, insertionPoint) + patch + contents.slice(insertionPoint);
    return mod;
  });
}

function withSpaceSafeBundlePhase(config) {
  return withXcodeProject(config, (mod) => {
    const phases = mod.modResults.hash.project.objects.PBXShellScriptBuildPhase ?? {};
    for (const phase of Object.values(phases)) {
      if (!phase || phase.name !== BUNDLE_PHASE_NAME || typeof phase.shellScript !== 'string') {
        continue;
      }

      const script = JSON.parse(phase.shellScript);
      if (script.includes(SAFE_BUNDLE_COMMAND)) continue;
      if (!script.includes(LEGACY_BUNDLE_COMMAND)) {
        throw new Error('Could not find the React Native iOS bundle command to make space-safe.');
      }
      phase.shellScript = JSON.stringify(script.replace(LEGACY_BUNDLE_COMMAND, SAFE_BUNDLE_COMMAND));
    }
    return mod;
  });
}

module.exports = function withSpaceSafeIosBuildScripts(config) {
  config = withSpaceSafePodfile(config);
  return withSpaceSafeBundlePhase(config);
};
