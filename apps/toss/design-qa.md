# Design QA

## Scope

- Layout reference: `/Users/kwon-oin/.codex/generated_images/01a002b0-6b85-7cd3-98db-e816792c3572/exec-ffd50f90-7a52-44ec-bb31-7e93833cf498.png`
- Game HUD reference: `/var/folders/hp/mw9d948n2_q3gc4yjdtttfjm0000gn/T/codex-clipboard-54b1f28e-199e-4eae-ab54-265fb700c5ad.png`
- Palette reference: `https://kamilokwon.github.io/mongjin/`
- Implementation: Apps-in-Toss React app at `http://127.0.0.1:5174/`
- Implementation viewport: 390 × 844
- Screens checked: home, computer setup, local game, guest profile, tutorial

## Visual comparison

- Final side-by-side guard HUD check: `.codex/qa/guard-tray-comparison.png` (supplied reference on the left, live implementation on the right).
- The reference palette was captured directly from the linked site and applied as tokens: canvas `#f1eee8`, app panel `#fbfaf7`, surface `#ffffff`, ink `#202a33`, muted text `#647480`, primary `#315f89`, line `#d8d4cc`, board `#d7c5a8`, and board edge `#b5a284`.
- The final home capture and reference capture were reviewed together. Background warmth, pale wood, dark ink, muted blue-gray copy, and the slate-blue selected/CTA state visually match the linked source while retaining the selected mobile layout.
- The board and pieces use the project’s real raster assets; no CSS-drawn pieces, emoji, or placeholder artwork remain.
- Home and game boards both render exactly 81 cells. Rank labels sit in the top-left corner of the first cell in each row, while file labels sit in the bottom-right corner of the final-row cells, matching the supplied board reference without adding a coordinate row.
- Home hierarchy now follows title/profile → board → mode → primary action. The previous Hunminjeongeum wordmark and subtitle treatment were removed.
- Setup and profile content are vertically balanced. Tutorial navigation sits with the tutorial content instead of leaving an oversized gap above the actions.
- Setup, profile, tutorial, and game HUD now use white or warm off-white surfaces with dark text and the same slate-blue selection language.
- The game HUD uses paired 4 × 2 guard trays based on the supplied reference: a warm ivory tray for white on the left and a dark slate tray for black on the right. Counts and piece images update from live game state without changing the tray layout.
- Turn direction is explicit: white uses a left-to-right arrow with `백 차례`, while black uses a right-to-left arrow with `흑 차례`. The arrow comes from the installed TDS icon asset set.

## Interaction and accessibility

- Mode, difficulty, and color selections expose `aria-pressed` state.
- Profile and back controls have accessible names.
- Home mode selection routes correctly to matchmaking, computer setup, or local play.
- Computer setup controls update selection state and start a game.
- A local board move updates the turn and renders a new real piece asset.
- A local black move changes the black guard tray from 8 to 7, highlights the white tray, and changes the turn indicator to the requested right-pointing `백 차례` state.
- Tutorial previous/next states and profile navigation remain functional.

## Regression checks

- `npm run build`: passed
- TypeScript `--noEmit`: passed
- Vite production build: passed
- Source scan found no remaining Hunminjeongeum wordmark or generic gradient decoration in app UI styles.
- Known non-blocking build note: the existing production bundle exceeds Vite’s 500 kB chunk advisory threshold.

final result: passed
