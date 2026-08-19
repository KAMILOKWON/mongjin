#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
mobile_root="$repo_root/apps/mobile"
app_json="$mobile_root/app.json"

app_version="$(node -e 'const fs=require("fs"); const p=process.argv[1]; console.log(JSON.parse(fs.readFileSync(p, "utf8")).expo.version)' "$app_json")"
build_number="$(node -e 'const fs=require("fs"); const p=process.argv[1]; console.log(JSON.parse(fs.readFileSync(p, "utf8")).expo.ios.buildNumber)' "$app_json")"
archive_path="${IOS_ARCHIVE_PATH:-$repo_root/artifacts/ios/Mongjin-${app_version}-${build_number}.xcarchive}"

mkdir -p "$(dirname "$archive_path")"

(
  cd "$mobile_root"
  npx expo prebuild --clean --no-install
  cd ios
  pod install
)

xcodebuild \
  -workspace "$mobile_root/ios/app.xcworkspace" \
  -scheme app \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$archive_path" \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY='Apple Distribution' \
  DEVELOPMENT_TEAM='M9RZNRX9T4' \
  PROVISIONING_PROFILE_SPECIFIER='Mongjin App Store Distribution' \
  -allowProvisioningUpdates \
  clean archive

printf 'Expo iOS archive: %s\n' "$archive_path"
