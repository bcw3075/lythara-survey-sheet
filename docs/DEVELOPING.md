# Developing the Survey Sheet module

How the code works and why it is built this way, for anyone changing it. User-facing instructions are in the README.

## Layout

| File | Role | Foundry globals? |
|---|---|---|
| `scripts/land.mjs` | World generation: lattice, terrain codes, heights, noise, line courses, paint, `buildLand`, `landFingerprint` | no |
| `scripts/survey.mjs` | Reads the painted world map into one byte per mile; slices for a sheet | no |
| `scripts/story.mjs` | Storybook trees for sheets; `speciesAt` (tree species by terrain, wetness, forest age and altitude) | no |
| `scripts/render.mjs` | `paintGround` and `renderMap` for sheet images | no |
| `scripts/encounter.mjs` | Encounter maps: `planEncounter` (pure data), `drawEncounter`/`drawReal` (canvas) | no |
| `scripts/explore.mjs` | Exploration carry-over between scenes (FogExploration) | yes |
| `scripts/main.mjs` | Everything Foundry: settings, hooks, sheets, pins, gates, party sync, tools, dialogs, encounter scenes, API | yes |
| `tools/build-sheet.py` | Copies the shared files into the companion web page between `/*SHARED-BEGIN*/` and `/*SHARED-END*/` | — |

The first five files are pure so they run in a plain browser: generation and drawing are tested with Playwright outside Foundry, and the companion page uses the same code (land parity).

## Coordinates and determinism
- World coordinates are **miles** from the world origin (a pin set with `setWorldOrigin`), x east, y north.
- Land cells sit on one absolute lattice (`CELL` = .125 mi, `i = floor(x / CELL)`), so overlapping sheets agree exactly. Land is built a mile past each frame so edges have neighbours.
- Encounter features are placed on **world-foot lattices** (trees 18 ft, brush 6, logs 55, rocks 26, boulder fields 9, ground detail 3) with hashed positions. The same spot always gives the same map, and growing a map at an edge never moves what is already there.
- `landFingerprint` is the guard that a change didn't alter the land: the module and the companion page must produce the same number for the same data.

## Data the module stores
- World settings: `world` (seed, origin, pins, lines, paint), `survey` (survey metadata; the survey itself is a PNG in `assets/map-tools/`), `explored` (exploration store), `heading` (party's last travel direction, unit vector), `sheetNav`.
- Scene flags (`flags["lythara-survey-sheet"]`): `state` (sheets: frame, hexes, slice, render key, fingerprint), `encounter` (encounter maps: centre, size, source scene, sliders, features, notes, crown mask `cover`), `gate` (edge gate regions).
- Every document the module creates carries a module flag (e.g. `enc`), so a rebuild deletes only the module's own documents, never the GM's.

## Heights and climate
Heights are in feet above the sea. The ocean is 0. The lowland base rises inland as 1500·(1 − e^(−miles/150)). Hills add 350–1,250 ft, and mountains add 2,000 ft at a range's edge, rising to +7,000 ft ten miles in. `snowlineAt(y)` is 7,000 ft at the origin and falls to sea level 1,150 miles north, so snow in the far north is cold lowland and snow elsewhere is high ground. Seasons (`seasonState`) combine the calendar date with warmth from latitude and height. Day length uses latitude 45° at the origin, +25° per 1,150 mi north.

## Sheets
Picked hexes plus a 3-mile margin, at 150 px per mile, capped near 16,000 px (WebGL's texture limit is 16,384). Trees are drawn side-on (storybook), so crowns stand north of their ground. Creeks, rivers and roads are drawn as overlays below the fog, so players see them only where explored. Bump `RENDER_VERSION` in `main.mjs` whenever the sheet image would change, or existing sheets won't redraw.

## Encounter maps
- **Input:** `encounterInput` builds a survey slice 1.5 mi around the spot, plus the world's seed, paint, lines and pins. `planEncounter` reads terrain with the same warp the sheet uses, adds close-range raggedness, and uses bicubic heights (bilinear left visible creases in the shading).
- **What you see is what you get:** at creation the module reads the sheet *picture* around the spot into a crown mask (`sheetCover`), so trees grow where the sheet shows crowns, even where the land grid says rough ground or snow. Lines aren't in the picture, so a click within 300 ft of a creek, river or road snaps to that line (`nearestWater` uses `lineCourse`, the exact course the sheet draws). The dialog compares the picture's ground mix around the cursor with nearby map centres (`groundAt`).
- **Lines:** use the sheet's `lineCourse` plus only a gentle extra meander and Chaikin rounding. Keep line points by segment-to-box distance, not point distance.
- **Trees:** species come from `speciesAt`, which is altitude-aware. Trees added by the Tree cover slider where the land names no species copy the nearest real tree's species.
- **Sliders** (−1..1, 0 = the land as it is):
  - `trees`.
  - `brush`, shown as "Rough going": undergrowth, plus drifts, mud, scree or stones by terrain, through `goingF`.
  - `rocks`.
  - `water`, which sets width and swamp pools.
  - `relief`: rises and hollows. It must never multiply the land's own slope.
  - `decay`, shown as "Growth" and flipped in the dialog: blighted ↔ lush.
- **Scene:**
  - Ground image as the level background.
  - Canopy as one overhead tile at elevation 20 with RADIAL occlusion. FADE fades the whole tile, and the tile's x/y is its centre.
  - Trunk walls graded by thickness: medium trunks block movement and give LIMITED sight; thick trunks block sight fully. Each is a one-way hexagon ring, so a sight line counts it once.
  - Feature walls for stones, outcrops, ruins and caves.
  - Difficult terrain as PF2e `modifyMovementCost` regions with **walk and travel** set. PF2e tokens use travel outside combat.
  - Campfire lights.
  - Darkness follows the world clock (active GM, `updateWorldTime`).
- **Tools:** the left-bar group "Lythara Maps" holds Pick Hexes, Fight Here (centred on the party; places them at the edge they came in by, from `heading`), Encounter Map Here (any spot), Extend, Back to the overland, and the Survey Sheet window. If an encounter map already covers a spot, the dialog offers to reuse it.

## Foundry v14 behaviour the code relies on
- `updateToken` fires before the token's position changes, and the dragging client sees the old x/y. Use the update's `change`, or the `moveToken` hook's `origin`/`destination`.
- Hooks that change documents run on the active GM only. The module's own updates carry `{ "lythara-survey-sheet": { sync: true } }` and are ignored by its hooks.
- DialogV2 strips `<style>` from dialog content, so dialog styles are injected into `document.head` (`encStyle`). Browsers cache module CSS across releases.
- Scripted moves stop at walls even for the GM.

## Performance
- Blur tree shadows on a small scratch canvas and multiply them in. A blur filter on the full canvas cost a whole-canvas pass per tree.
- Batch leaves per tone into Path2D passes, and cache per-map seed points.
- Chrome defers canvas work: time a stage with `getImageData(0,0,1,1)` after it.
- The noise table `tbl` has features about 23 units across, so `tbl(x * 23 / F)` gives features F feet wide.
- Avoid per-pixel random texture (it reads as static); build texture from shapes.

## Testing
- **Local:** `tools/test/` (see its README) renders encounter maps in headless Chromium from sheet exports kept in the git-ignored `tools/test/data/`. Check every terrain, season, and each slider at both ends, at full view and close up.
- **In Foundry, after installing:** use the real buttons and clicks. Check as GM and as a player in a second tab, run an ordinary build as a regression test, and check land parity after land changes.

## Releasing
Bump `version` in `module.json`, then rebuild `dist/lythara-survey-sheet.zip`; the manifest downloads this committed zip:

```sh
rm dist/lythara-survey-sheet.zip && zip -qr dist/lythara-survey-sheet.zip module.json styles scripts icons
```

Then push.

## Keep out of this repo
Campaign content: place names, plot, the companion page's source. The repo is public.
