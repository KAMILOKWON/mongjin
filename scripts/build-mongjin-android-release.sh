#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MOBILE_DIR="$ROOT_DIR/apps/mobile"
ANDROID_DIR="$MOBILE_DIR/android"
KEYSTORE_PATH_SERVICE='mongjin.android.keystore.path'
KEYSTORE_PASSWORD_SERVICE='mongjin.android.keystore.password'
KEY_ALIAS_SERVICE='mongjin.android.key.alias'
KEY_PASSWORD_SERVICE='mongjin.android.key.password'
ADMOB_APP_ID_SERVICE='mongjin.admob.app.id'
ADMOB_BANNER_UNIT_ID_SERVICE='mongjin.admob.banner.unit.id'
ADMOB_INTERSTITIAL_UNIT_ID_SERVICE='mongjin.admob.interstitial.unit.id'

keychain_value() {
  local service_name="$1"
  security find-generic-password -s "$service_name" -w 2>/dev/null
}

export MONGJIN_ANDROID_KEYSTORE_PATH="$(keychain_value "$KEYSTORE_PATH_SERVICE")"
export MONGJIN_ANDROID_KEYSTORE_PASSWORD="$(keychain_value "$KEYSTORE_PASSWORD_SERVICE")"
export MONGJIN_ANDROID_KEY_ALIAS="$(keychain_value "$KEY_ALIAS_SERVICE")"
export MONGJIN_ANDROID_KEY_PASSWORD="$(keychain_value "$KEY_PASSWORD_SERVICE")"
export ADMOB_ANDROID_APP_ID="$(keychain_value "$ADMOB_APP_ID_SERVICE")"
export ADMOB_ANDROID_BANNER_UNIT_ID="$(keychain_value "$ADMOB_BANNER_UNIT_ID_SERVICE")"
export ADMOB_ANDROID_INTERSTITIAL_UNIT_ID="$(keychain_value "$ADMOB_INTERSTITIAL_UNIT_ID_SERVICE")"

if [[ -z "$MONGJIN_ANDROID_KEYSTORE_PATH" || ! -f "$MONGJIN_ANDROID_KEYSTORE_PATH" ]]; then
  echo "Mongjin Android keystore was not found in the macOS keychain." >&2
  exit 1
fi

if [[ -z "$ADMOB_ANDROID_APP_ID" || -z "$ADMOB_ANDROID_BANNER_UNIT_ID" || -z "$ADMOB_ANDROID_INTERSTITIAL_UNIT_ID" ]]; then
  echo "Mongjin Android AdMob IDs were not found in the macOS keychain." >&2
  exit 1
fi

if [[ -z "${JAVA_HOME:-}" ]]; then
  JAVA_HOME="$(/usr/libexec/java_home -v 21 2>/dev/null || true)"
  if [[ -z "$JAVA_HOME" && -x "$(brew --prefix openjdk@21 2>/dev/null)/libexec/openjdk.jdk/Contents/Home/bin/java" ]]; then
    JAVA_HOME="$(brew --prefix openjdk@21)/libexec/openjdk.jdk/Contents/Home"
  fi
  export JAVA_HOME
fi

export ANDROID_HOME="${ANDROID_HOME:-/Users/kwon-oin/Library/Android/sdk}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"

APP_VERSION="$(node -e "console.log(require('$MOBILE_DIR/app.json').expo.version)")"
VERSION_CODE="$(node -e "console.log(require('$MOBILE_DIR/app.json').expo.android.versionCode)")"
OUTPUT_PATH="$ROOT_DIR/artifacts/android/Mongjin-${APP_VERSION}-${VERSION_CODE}.aab"

mkdir -p "$(dirname "$OUTPUT_PATH")"
(cd "$MOBILE_DIR" && npx expo prebuild --clean --no-install --platform android)
(cd "$ANDROID_DIR" && ./gradlew bundleRelease)
cp "$ANDROID_DIR/app/build/outputs/bundle/release/app-release.aab" "$OUTPUT_PATH"

echo "Created $OUTPUT_PATH"
