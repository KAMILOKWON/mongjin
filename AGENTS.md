# Mongjin workspace rules

## Current development target

The active mobile app is **React Native + Expo** at `apps/mobile`. There is NO SwiftUI app under development — the legacy native Swift app was deleted (`apps/사용안함` is gone). Never judge or modify code based on the old SwiftUI screens; `apps/mobile/ios` only contains the Expo-generated native shell (`AppDelegate.swift` etc.), which is build output scaffolding, not app code. All screens and game features are written in TypeScript/TSX with React Native + Expo.

## Repository layout

```text
mongjin/
├── apps/
│   ├── mobile/        ← current mobile app (React Native + Expo, Expo Router)
│   ├── toss/          ← Apps-in-Toss target (web-based)
│   └── steam/         ← Steam web wrapper
├── src/               ← canonical shared TypeScript game source (web, Toss, Android, Steam)
├── packages/          ← boundary exposing shared logic to apps
│   ├── game-core/     ← rules, state, win/loss
│   ├── game-ai/       ← AI
│   └── game-data/     ← config, ghosts, records
├── server/            ← online match WebSocket server (index.ts)
├── assets/            ← shared images, fonts, tutorial resources
├── bot/               ← AI training, self-play, game records
└── dist/              ← build output
```

## Where to make changes

- Screen layout, buttons, copy: `apps/mobile/src/screens/`
- Board, stones, shared UI components: `apps/mobile/src/components.tsx`
- Screen state and match flow: `apps/mobile/src/store.ts` (Zustand)
- Mobile game session: `apps/mobile/src/game/engine.ts`
- Online matching (WebSocket client): `apps/mobile/src/online.ts`
- Local profile/ghost storage: `apps/mobile/src/storage.ts` (AsyncStorage)
- App flow / navigation shell: `apps/mobile/src/AppShell.tsx`, `apps/mobile/app/` (Expo Router)
- Game rules are NOT rewritten inside the mobile app — use the shared code:
  `src/core/rules.ts`, `src/core/apply.ts`, `src/core/result.ts` (consumed via `packages/game-core`)
- Server (quick match, friend codes, WebSocket, online profiles, Elo records, ghost fallback matching): `server/index.ts`

## Rules

- Treat `src`, `bot`, and `assets` as the canonical shared TypeScript game source for web, Apps in Toss, Android, and Steam.
- The Android native project lives under `apps/mobile/android` and the Steam wrapper under `apps/steam`; both must consume the canonical shared TypeScript source.
- Run `npm test` after changing rules, AI, results, coordinates, or replay formats.
- Mobile checks: `npm run typecheck:mobile`, `npm run build:mobile`; run Expo app via `npm run dev:mobile`.
- Never edit generated folders such as `dist`, `.ait`, `.build`, `DerivedData`, `node_modules`, or the Expo-generated `apps/mobile/ios` / `apps/mobile/android` internals directly.
- After completing each patch or change set, ask the user whether to increment the app version by one step. Do not change any version number until the user explicitly approves it.
- Run releases through `/Volumes/Studio ZZG/studio-release/bin/studio-release.mjs`. Production publication always requires explicit user approval.
- Android Play uploads for Mongjin use the macOS Keychain services `mongjin.android.keystore.path`, `mongjin.android.keystore.password`, `mongjin.android.key.alias`, and `mongjin.android.key.password`. The configured keystore is `/Volumes/Studio ZZG/.studio-secrets/mongjin-android-upload.p12`, alias `mongjin-upload`, with upload certificate SHA1 `74:F6:A8:02:9E:AF:48:D6:38:89:38:27:11:FE:67:5D:24:B1:6F:9E`. Never write the passwords to the repository; use `npm run build:android:release` to retrieve them from Keychain.
- Follow `apps/mobile/AGENTS.md` when working inside the Expo app (read the exact versioned Expo docs before writing code).
