# App Store Connect — App Review Information

The App Store Connect App Review Information Notes field was updated for Expo build `1.0.0 (52)`, bundle ID `com.studiozzg.mongjin`. The physical-device recording was attached as `ScreenRecording_08-19-2026 13-34-47_1_review.mov`.

## 1. Screen recording

The attached recording starts on the iPhone Home Screen, launches Mongjin, shows Quick Match searching, the game board and a live match flow, and then the Profile screen. It is 57 seconds long. The source recording was converted to H.264/AAC MOV without changing its content.

The app does not include account registration, login, account deletion, paid content, subscriptions, purchases, chat, user-generated posts, content reporting, or blocking.

## 2. Devices and operating systems tested

- Physical iPhone used for the attached recording — latest public iOS installed on the test device on August 19, 2026.
- iPhone 17 Pro Simulator — iOS 26.5, for local simulator smoke testing only.

The simulator result is not a substitute for the required physical-device recording.

## 3. App functions, audience, problem, and value

Mongjin is an original two-player strategy board game for players who enjoy short, thoughtful matches. Players move a King toward the opponent's goal while placing and moving Guard pieces to protect the King, block routes, capture the opposing King, or surround it. The app provides Tutorial, Computer matches with three difficulty levels, Local two-player play on one device, and Quick Match online play. It solves the problem of wanting a compact strategy game that is easy to learn but still rewards planning, positioning, and defense. The value is a complete match in a few minutes, with a tutorial for first-time players and optional online ratings for repeat play.

## 4. Setup and access

No account or login is required. On first launch, tap Tutorial to learn the rules, Computer to choose difficulty and side, or 같이 두기 (Local) to play on one device. Quick Match creates an anonymous online identity automatically; the user may optionally edit a 2–12 character nickname in Profile. If the online server or another player is unavailable, the app falls back to a built-in Ghost challenge after 15 seconds. No credentials or sample files are required.

## 5. External services, tools, and platforms

- Render-hosted WebSocket service: `wss://mongjin-api.onrender.com`, used only for anonymous profile synchronization, matchmaking, and online move/result synchronization.
- Expo / React Native are the app build/runtime technologies, not user-facing data providers.
- The Computer opponent and Ghost challenges run locally on the device.
- The submitted Expo target contains no advertising SDK, analytics SDK, payment processor, subscription system, AI cloud service, camera, contacts, location, or tracking-permission flow.

## 6. Regional differences

The game rules, screens, and functionality are consistent across regions. Online play depends on network availability and may fall back to a built-in Ghost challenge when no opponent is available. The current mobile UI is Korean; there is no region-specific content, pricing, or feature gating.

## 7. Regulated industry and third-party material

Mongjin does not operate in a regulated industry. The game rules, UI, and bundled game artwork are project materials supplied with the app, and the app does not provide protected third-party content or regulated services.
