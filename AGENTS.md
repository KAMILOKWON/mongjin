# Mongjin workspace rules

- Treat `src`, `bot`, and `assets` as the canonical shared TypeScript game source for web, Apps in Toss, Android, and Steam.
- Keep the submitted native iOS implementation under `apps/ios`; do not replace or delete it without a migration release plan.
- Run both `npm test` and `npm run test:ios` after changing rules, AI, results, coordinates, or replay formats.
- Never edit generated folders such as `dist`, `.ait`, `.build`, `DerivedData`, or `node_modules` directly.
- Run releases through `/Volumes/Studio ZZG/studio-release/bin/studio-release.mjs`.
- Preserve the submitted iOS `1.0 (5)` baseline. Production publication always requires explicit user approval.
- Add Android and Steam wrappers under `apps/android` and `apps/steam`; they must consume the canonical shared TypeScript source.
