# Design QA — Armored Ops Detail Pass

## Evidence

- Source visual truth: `/Users/kwon-oin/.codex/generated_images/019ff235-5b24-75b1-bc38-f960a4167cef/exec-76498655-3959-4c14-b01a-4843c59cd2a7.png`
- Normalized source: `/Volumes/Studio ZZG/3hp/도지건/qa-source-option2-normalized.png`
- Implementation URL: `http://localhost:8000/도지건/`
- Implementation screenshot: `/Volumes/Studio ZZG/3hp/도지건/implementation-final.png`
- Full-view comparison: `/Volumes/Studio ZZG/3hp/도지건/qa-comparison-final.png`
- Focused character comparison: `/Volumes/Studio ZZG/3hp/도지건/qa-character-comparison.png`
- Viewport and CSS size: 884 × 583 CSS px
- Source pixels: 1536 × 1024, normalized to 884 × 583
- Implementation pixels: 884 × 583 screenshot; WebGL canvas rendered internally at DPR 2
- State: neutral combat state, Player 1 aiming northeast, both players at 3 HP and 6 rounds
- Browser: Codex in-app browser

## Findings

No actionable P0, P1, or P2 differences remain.

- [P3] Source uses denser photoreal surface wear and more complex exterior vehicle meshes.
  - Location: floor microtexture and arena exterior.
  - Evidence: the source has baked grime, drains, track details, and several high-poly vehicles; the implementation uses low-poly floor wear decals, two armored vehicles, a tank, barrels, and crates.
  - Impact: the implementation is slightly cleaner at close inspection, but the requested armored military direction, scene density, and gameplay readability are preserved.
  - Follow-up: add optimized texture maps or imported low-poly GLTF vehicles if a more cinematic finish becomes necessary.

## Required Fidelity Surfaces

- Fonts and typography: `Black Ops One` preserves the stencil display weight and `IBM Plex Mono` keeps the bottom guide compact. PLAYER 1/2 remain single-line and optically balanced.
- Spacing and layout rhythm: opposing HUDs, three HP segments, six-round racks, fixed arena overview, and empty center match the selected hierarchy without overlap.
- Colors and tokens: graphite floor plates, concrete wall caps, muted blue/red factions, brass rounds, olive military props, and black equipment match the source palette.
- Image quality and asset fidelity: the generated alpha cartridge asset remains sharp and halo-free. The game world uses native real-time Three.js meshes rather than CSS/SVG stand-ins.
- Copy and content: persistent top chrome contains only player names, HP, and ammunition. The compact bottom control guide remains the only secondary copy.
- Map detail: 48 individually shaded steel panels, instanced floor rivets, wear marks, segmented wall caps, wall face joints, bolt heads, hazard plates, utility rails, armored vehicles, tank, barrels, and crates are implemented outside combat lanes.
- Character detail: both fighters now have separated full-body silhouettes, faction-striped helmets, visors, headsets, armor vests, chest plates, pouches, belts, backpacks, bedrolls, shoulder armor, gloves, knee pads, boots, and detailed lever-action rifles.
- Accessibility and resilience: HUD groups remain semantically labeled, status updates use `role="status"`, decorative ammunition images use empty alt text, and the compact media query prevents top-HUD overlap below 800 px.

## Interaction And Runtime Verification

- Canvas and HUD rendered at the intended viewport.
- Both players show exactly three HP segments and six ammunition icons at reset.
- Primary fire tested in the in-app browser: Player 1 ammunition changed from 6 to 5.
- Muzzle flash and elongated projectile visuals are attached to both player and AI fire paths.
- Existing movement, mouse aim, lever cooldown, AI, per-round reload, immediate knockback, red hit flash, and respawn logic remain connected.
- Final browser console logs: none.

## Comparison History

1. Baseline before this detail pass
   - Earlier findings: P2 floor read as a single flat surface; P2 concrete walls lacked panel construction; P2 exterior military context and character equipment were too sparse.
   - Fixes: added tiled steel panels, instanced rivets, wall seams and bolts, hazard hardware, military props, exterior vehicles, and detailed character equipment.
   - Evidence: `/Volumes/Studio ZZG/3hp/도지건/implementation-pass-4.png`

2. Detail pass 1
   - Earlier findings: P2 camera remained too vertical for the character torso to read, and the floor was darker than the source.
   - Fixes: increased camera tilt, added fill lighting, and lifted panel material values.
   - Evidence: `/Volumes/Studio ZZG/3hp/도지건/detail-pass-1.png`

3. Character silhouette pass
   - Earlier findings: P2 helmet, torso, and legs overlapped into one white/red mass in the focused crop.
   - Fixes: separated head, torso, legs, and boots along the aiming axis; reduced helmet size; changed shoulder color; enlarged the faction stripe; and expanded the collision radius with the visual body.
   - Evidence before fix: `/Volumes/Studio ZZG/3hp/도지건/qa-character-comparison.png` was regenerated after the fix; the prior state remains visible in `/Volumes/Studio ZZG/3hp/도지건/detail-pass-3.png`.

4. Final pass
   - Post-fix full evidence: `/Volumes/Studio ZZG/3hp/도지건/qa-comparison-final.png`
   - Post-fix focused evidence: `/Volumes/Studio ZZG/3hp/도지건/qa-character-comparison.png`
   - No actionable P0/P1/P2 findings remain.

## Follow-up Polish

- Optional P3: import optimized GLTF armored vehicles for richer tracks and wheel assemblies.
- Optional P3: add one shared subtle grunge texture atlas if the game later gains an asset pipeline.

final result: passed
