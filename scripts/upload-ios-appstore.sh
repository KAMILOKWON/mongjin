#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
mobile_root="$repo_root/apps/mobile"
app_version="$(node -e 'const fs=require("fs"); const p=process.argv[1]; console.log(JSON.parse(fs.readFileSync(p, "utf8")).expo.version)' "$mobile_root/app.json")"
build_number="$(node -e 'const fs=require("fs"); const p=process.argv[1]; console.log(JSON.parse(fs.readFileSync(p, "utf8")).expo.ios.buildNumber)' "$mobile_root/app.json")"
archive_path="${IOS_ARCHIVE_PATH:-$repo_root/artifacts/ios/Mongjin-${app_version}-${build_number}.xcarchive}"
upload_path="$repo_root/artifacts/ios/upload"

bash "$repo_root/scripts/build-expo-ios.sh"

xcodebuild \
  -exportArchive \
  -archivePath "$archive_path" \
  -exportPath "$upload_path" \
  -exportOptionsPlist "$repo_root/apps/ios/ExportOptionsUpload.plist" \
  -allowProvisioningUpdates
