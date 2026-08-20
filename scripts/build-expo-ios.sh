#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
mobile_root="$repo_root/apps/mobile"
app_json="$mobile_root/app.json"

keychain_value() {
  local service_name="$1"
  security find-generic-password -s "$service_name" -w 2>/dev/null
}

export ADMOB_IOS_APP_ID="$(keychain_value 'mongjin.admob.ios.app.id')"
export ADMOB_IOS_BANNER_UNIT_ID="$(keychain_value 'mongjin.admob.ios.banner.unit.id')"
export ADMOB_IOS_INTERSTITIAL_UNIT_ID="$(keychain_value 'mongjin.admob.ios.interstitial.unit.id')"

if [[ -z "$ADMOB_IOS_APP_ID" || -z "$ADMOB_IOS_BANNER_UNIT_ID" || -z "$ADMOB_IOS_INTERSTITIAL_UNIT_ID" ]]; then
  echo "Mongjin iOS AdMob IDs were not found in the macOS keychain." >&2
  exit 1
fi

app_version="$(node -e 'const fs=require("fs"); const p=process.argv[1]; console.log(JSON.parse(fs.readFileSync(p, "utf8")).expo.version)' "$app_json")"
build_number="$(node -e 'const fs=require("fs"); const p=process.argv[1]; console.log(JSON.parse(fs.readFileSync(p, "utf8")).expo.ios.buildNumber)' "$app_json")"
archive_path="${IOS_ARCHIVE_PATH:-$repo_root/artifacts/ios/Mongjin-${app_version}-${build_number}.xcarchive}"
export_path="$(mktemp -d "${TMPDIR:-/tmp}/mongjin-ios-export.XXXXXX")"
ipa_path="$repo_root/artifacts/ios/Mongjin-${app_version}-${build_number}.ipa"
export_options="$(mktemp -t mongjin-export-options).plist"

cleanup() {
  rm -f "$export_options"
  rm -rf "$export_path"
}
trap cleanup EXIT

mkdir -p "$(dirname "$archive_path")"

if [[ "${IOS_SKIP_ARCHIVE:-0}" != "1" ]]; then
  (
    cd "$mobile_root"
    npx expo prebuild --clean --no-install --platform ios
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
elif [[ ! -d "$archive_path" ]]; then
  echo "Existing iOS archive was not found: $archive_path" >&2
  exit 1
fi

cat > "$export_options" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>destination</key>
  <string>export</string>
  <key>method</key>
  <string>app-store-connect</string>
  <key>manageAppVersionAndBuildNumber</key>
  <false/>
  <key>signingStyle</key>
  <string>manual</string>
  <key>teamID</key>
  <string>M9RZNRX9T4</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>com.studiozzg.mongjin</key>
    <string>Mongjin App Store Distribution</string>
  </dict>
  <key>uploadSymbols</key>
  <true/>
</dict>
</plist>
PLIST

xcodebuild \
  -exportArchive \
  -archivePath "$archive_path" \
  -exportPath "$export_path" \
  -exportOptionsPlist "$export_options" \
  -allowProvisioningUpdates

exported_ipa="$(find "$export_path" -maxdepth 1 -name '*.ipa' -print -quit)"
if [[ -z "$exported_ipa" ]]; then
  echo "Export completed without an IPA." >&2
  exit 1
fi
cp "$exported_ipa" "$ipa_path"

printf 'Expo iOS archive: %s\n' "$archive_path"
printf 'Created %s\n' "$ipa_path"
