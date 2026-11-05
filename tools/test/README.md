# Local tests for encounter maps

Renders `scripts/encounter.mjs` in headless Chromium (Playwright), outside Foundry.

- `data/` (git-ignored) holds sheet exports from `api.exportSheet(scene)` as `sheetA.json`, `sheetB.json`, … plus `spots.json` (named test spots). Exports contain the world's pins, so they never go in this public repo. Point `TEST_DATA` elsewhere if you keep them outside.
- `node render.js '<jobs JSON>' [outDir]` renders jobs (see the header of render.js).
- `node find.js sheetA.json` lists solid spots of each terrain type.
- `python3 contact.py seasons 0.02,0.55` and `python3 contact.py slider rocks` build contact sheets in `out/`.

Look at every contact sheet scaled down and a close crop before calling a visual change done.
