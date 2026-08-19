# Visual QA — 동양식 장풍 아레나

source visual truth path: `/var/folders/hp/mw9d948n2_q3gc4yjdtttfjm0000gn/T/codex-clipboard-81f1a11d-2f0f-46b7-8732-83e9ef44a31b.png`
implementation screenshot path: `/Volumes/Studio ZZG/3hp/도지뿡/qa-implementation.jpg`
combined comparison path: `/Volumes/Studio ZZG/3hp/도지뿡/qa-comparison.jpg`
energy-wave implementation capture: `/Volumes/Studio ZZG/3hp/도지뿡/qa-energy-wave.jpg`
wall/hit-motion implementation capture: `/Volumes/Studio ZZG/3hp/도지뿡/qa-hit-wall.jpg`

## Comparison setup

- Source visual: 550 × 384 px pixel character reference.
- Implementation capture: 884 × 583 px browser screenshot at CSS viewport 884 × 583, reported device pixel ratio 2.
- State: initial arena, player and enemy visible, HP 100/100, no active charge.
- Focused comparison: character silhouette, full-body visibility, hard outline, stepped pixel edges, limited palette, and readable hands/feet. The reference's weapon was intentionally replaced by an energy-wave charging pose for the requested game concept.
- Full-view comparison: eastern garden background with rocks, pine trees, bamboo, stone paths, pond edge, and open combat lane.

## Findings

- No P0/P1/P2 findings remain.
- The implementation uses generated raster assets for the player sprite, enemy sprite, and eastern garden background rather than the previous code-drawn character approximation.
- Both fighters show their full bodies from head to boots, with a strong dark pixel outline and readable combat pose.
- The map now communicates an eastern garden/mountain arena through rocks, pines, bamboo, stone paths, water, and warm olive/tan colors.
- The existing HP, charge, input, collision, and damage behavior remains intact.

## Energy-wave iteration

- Source visual: 475 × 282 px energy-wave reference.
- Implementation capture: 884 × 583 px browser screenshot at CSS viewport 884 × 583, reported device pixel ratio 2.
- The projectile now uses a generated transparent pixel asset with a thin trailing beam, widening arrowhead, white-hot core, cyan/blue rim, and jagged electric arcs.
- Charge maps to rendered size: approximately 115–415 px wide and 54–128 px high in game coordinates. Short shots remain thin but travel to the arena edge; long shots become larger and more forceful.
- Pointer aim and click-release firing were tested; the projectile rendered in the live arena and enemy HP decreased.
- Browser console checked after firing: no error or warning entries.

## Wall and hit-motion iteration

- Character sprite display size was reduced from 230 to 155 game units while the collision radius remains 23, bringing visual scale and hitbox proportions closer together.
- The old metal bars were replaced by a generated eastern wall asset: dark outlined stacked stone, cedar cap, and pale fasteners. The thick dark backing keeps obstacles visually separate from the garden background.
- Hits now apply a short directional knockback, hit flash, tilt/kick motion, and square pixel impact particles. Knockback is stronger for higher-damage charged waves.
- The knockback response begins on the impact frame with an immediate 15–22 game-unit displacement plus a stronger short velocity impulse, so the reaction reads instantly instead of starting one frame later.
- Charging now swaps to dedicated generated full-body sprites with both cupped hands pulled back beside the waist. The previous procedural arm overlays and body wobble were removed; only the hand-centered energy core pulses.
- Live preview checks: eastern wall asset visible in straight and 45-degree barriers, character scale reduced, long wave visible, and browser console remained clean.

## Interaction and console checks

- Local page loaded at `/도지뿡/`.
- WASD movement input exercised.
- Pointer aim/click-release input exercised.
- Browser console checked: no error or warning entries.

## Follow-up polish

- Add 2–3 animation frames per character for idle, walk, charge, and hit states if the prototype moves toward production.
- Add a brief impact-frame sprite when the arrowhead hits a wall or fighter.

final result: passed
