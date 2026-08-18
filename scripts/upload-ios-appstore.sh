#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
archive_path="$repo_root/artifacts/ios/Mongjin-1.0.0-51.xcarchive"
upload_path="$repo_root/artifacts/ios/upload"

xcodebuild \
  -project "$repo_root/apps/ios/Mongjin.xcodeproj" \
  -scheme Mongjin \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$archive_path" \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY='Apple Distribution' \
  PROVISIONING_PROFILE_SPECIFIER='Mongjin App Store Distribution' \
  clean archive

xcodebuild \
  -exportArchive \
  -archivePath "$archive_path" \
  -exportPath "$upload_path" \
  -exportOptionsPlist "$repo_root/apps/ios/ExportOptionsUpload.plist" \
  -allowProvisioningUpdates
