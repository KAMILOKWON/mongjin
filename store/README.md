# Mongjin store metadata

This directory is the source of truth for localized App Store and Google Play listing text.

- `app-store/<locale>` follows fastlane `deliver` metadata naming.
- `google-play/<locale>` follows fastlane `supply` metadata naming.
- `ko/` contains the original Korean submission notes kept for reference.

Supported search localizations:

- Korean
- English (U.S.)
- Japanese
- Chinese (Simplified)
- Chinese (Traditional)

Validate character and byte limits before upload:

```sh
npm run validate:store-metadata
```

The App Store indexes localized app names, subtitles, and keyword fields. Google Play does not have a dedicated keyword field, so localized titles and descriptions include the alternate names `Mongjin`, `モンジン`, `蒙塵`, and `蒙尘` naturally.

Metadata upload changes a public store listing. Use the dedicated fastlane lanes only after explicit production approval:

```sh
bundle exec fastlane ios metadata
bundle exec fastlane android metadata
```
