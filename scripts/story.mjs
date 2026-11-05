import { CELL, hash, fbm, snowlineAt } from "./land.mjs";

/* ---------- storybook trees: same code in the module and the Survey Sheet ----------
   Tree types are a best guess from real temperate woods: terrain, ground height, wetness,
   forest age and edges decide them. The colours come from the World Map's canopy. */
export const STORY_GROUND = ["#c6b670", "#b0ac62", "#747c44", "#48522e", "#8a965e", "#508696", "#b9ad7a", "#6e625c", "#8f8a7e", "#e6e8e4"];
/* Art choices for rough country. hills: "marks" (small rock marks, the first version) | "hummocks" (sparse rounded hills) | "relief" (shading and contour lines only) | "both".
   water: "plain" | "shallows" | "depth" (deeper blue away from shore, with depth bands) | "ripples" | "hatch" | "paper". peaks: "classic" | "shaded" | "none" (contours only). */
export const STYLE = { hills: "contours", water: "depth", peaks: "none" };
/* hills also: "contours" (hillshade + contour lines every 100 ft, labelled every 500 ft, on open and rough ground) | "tinted" (contours plus colour by height on rough ground).
   peaks also: "none". water also: "ripples" (shore lines echoing out), "depth" (bands darkening offshore), "hatch" (ink hatching along the shore), "paper" (bare paper with an inked edge and ripples).
   Elevation is invented but fixed: 2,400 ft at the highest point a sheet can reach; contour values read from that. */
const STORY_HOLLOW = .41, STORY_RIDGE = .64;
export function makeStory(land) {
  const { tAt, elevAt, riseAt, reliefAt } = land, creekPts = land.waterPoints, seed = land.s, GW = land.gw, GH = land.gh, i0 = land.i0, j1 = land.j1;
  const P = { oak: ["#616531", "#717436", "#535a2d", "#6a6e33"], old: ["#3c4324", "#474e2d", "#303623"], beech: ["#94993f", "#838a41", "#a8ad48"], birch: ["#b0b54e", "#a8ad48", "#bdbf5a"], hemlock: ["#2f4232", "#36493a", "#2a3b2e"], pine: ["#465a2e", "#506433", "#3e5230"], willow: ["#8d9a58", "#7c8e55", "#9aa562"] };
  const style = { ...STYLE, ...(land.style ?? {}) };
  const INKT = "#20190f", s0 = seed | 0, near = new Float32Array(GW * GH).fill(9), rr = Math.ceil(.32 / CELL);
  for (const p of creekPts) {
    const ci = Math.floor(p.x / CELL) - i0, cj = j1 - 1 - Math.floor(p.y / CELL);
    for (let j = cj - rr; j <= cj + rr; j++) for (let i = ci - rr; i <= ci + rr; i++) if (i >= 0 && j >= 0 && i < GW && j < GH) { const d = Math.hypot(i - ci, j - cj) * CELL, k = j * GW + i; if (d < near[k]) near[k] = d; }
  }
  const creekDist = (x, y) => { const i = Math.floor(x / CELL) - i0, j = j1 - 1 - Math.floor(y / CELL); return (i < 0 || j < 0 || i >= GW || j >= GH) ? 9 : near[j * GW + i]; };
  const forest = t => t === 2 || t === 3, open = t => t === 0 || t === 1;
  const isEdge = (x, y, n = .42) => forest(tAt(x + n, y)) || forest(tAt(x - n, y)) || forest(tAt(x, y + n)) || forest(tAt(x, y - n));
  const openNear = (x, y, n = .8) => open(tAt(x + n, y)) || open(tAt(x - n, y)) || open(tAt(x, y + n)) || open(tAt(x, y - n));
  /* altitude: woods turn from broadleaf to mixed to conifer as the ground climbs into the mountains (HEIGHTS.mtnMin is 2,000 ft;
     snow-capped crags here stand near 3,400 ft). 0 at 1,800 ft, 1 at 2,600 ft, at Stoneclaim's latitude; the bands fall going north with the snowline. */
  const montane = (x, y) => { const k = snowlineAt(y) / 7000; return (elevAt(x, y) - 1800 * k) / (800 * Math.max(.3, k)); };
  function speciesAt(x, y, t) {
    const base = speciesLow(x, y, t); if (!base) return base;
    const z = montane(x, y); if (z <= 0) return base;
    const k = Math.round(x * 97), m = Math.round(y * 97), h2 = hash(k, m, 34), h3 = hash(k, m, 35), pick = (kind, pal) => ({ kind, col: P[pal || kind][(h3 * P[pal || kind].length) | 0] });
    const conifer = Math.min(.96, z * .92);   /* share of evergreens: a mixed band, then mostly fir and pine, birch the last broadleaf */
    if (h2 < conifer) return reliefAt(x, y) > STORY_RIDGE - .08 || hash(k, m, 36) < .45 ? pick("pine") : pick("hemlock");   /* pine on the ridges, fir-like hemlock in the folds */
    if (base.kind === "willow" && z > .5) return pick("birch");
    if (z > .8 && base.kind !== "birch") return pick("birch");
    return base;
  }
  function speciesLow(x, y, t) {
    const k = Math.round(x * 97), m = Math.round(y * 97), h = hash(k, m, 31), h2 = hash(k, m, 32), h3 = hash(k, m, 33), pick = (kind, pal) => ({ kind, col: P[pal || kind][(h3 * P[pal || kind].length) | 0] });
    if (t === 4) { if (h < .25) return null; return h < .78 ? pick("willow") : pick("birch"); }
    if (open(t)) { if (isEdge(x, y) && h < .1) return pick("birch"); if (creekDist(x, y) < .2 && h < .18) return pick("willow"); if (t === 1 && h < .012) return pick("oakS", "oak"); return null; }
    if (t === 6) { if (isEdge(x, y) && h < .12) return pick("birch"); if (h < .03) return riseAt(x, y) > 600 ? pick("pine") : pick("oakS", "oak"); return null; }
    if (!forest(t)) return null;
    if (creekDist(x, y) < .3 && h < .55) return pick("willow");
    if (t === 2 && h2 < .3) return null;
    const e = reliefAt(x, y), beechy = fbm(x / 3.2, y / 3.2, 2, s0 + 61);
    if (e < STORY_HOLLOW && t === 3) return h < .72 ? pick("hemlock") : pick("dark", "old");
    if (e < STORY_HOLLOW - .05 && h < .25) return pick("hemlock");
    if (e > STORY_RIDGE && h < .55) return pick("pine");
    if (openNear(x, y) && h < .55) return pick("birch");
    if (t === 3) { if (beechy > .52) return h < .8 ? pick("beech") : pick("oak"); return h < .75 ? pick("oak") : pick("beech"); }
    if (h < (Math.hypot(x, y) < 8 ? .42 : .22)) return pick("birch");
    return h < .72 ? pick("oakS", "oak") : pick("beechS", "beech");
  }
  let LW = 1;
  const shadeCol = (col, a) => { const n = parseInt(col.slice(1), 16), q = v => Math.max(0, Math.min(255, Math.round(v + a))); return "rgb(" + q(n >> 16) + "," + q(n >> 8 & 255) + "," + q(n & 255) + ")"; };
  function lobes(c, px, cy, W, H, col, n, sd) {
    const pts = [[0, 0, .74]], key = Math.round(sd * 999);
    for (let i = 0; i < n; i++) { const an = i / n * 6.283 + sd * 6, r = .5 + hash(i, key, 51) * .14; pts.push([Math.cos(an) * r, Math.sin(an) * r * .92, .42 + hash(i, key, 52) * .14]); }
    const path = (scale, ox, oy, skip) => { c.beginPath(); pts.forEach((p, i) => { if (skip && p[1] > .1 && i) return; const r = p[2] * W * scale, a = px + p[0] * W + ox * r, b = cy + p[1] * H + oy * r; c.moveTo(a + r, b); c.arc(a, b, r, 0, 6.3); }); };
    c.strokeStyle = INKT; c.lineWidth = 1.5 * LW; path(1, 0, 0); c.stroke();
    c.fillStyle = col; path(1, 0, 0); c.fill();
    c.fillStyle = shadeCol(col, 26); path(.52, -.3, -.45, true); c.fill();
  }
  function trunk(c, px, py, w, h) { c.fillStyle = "#4a3520"; c.strokeStyle = INKT; c.lineWidth = .8 * LW; c.beginPath(); c.moveTo(px - w, py); c.lineTo(px - w * .65, py - h); c.lineTo(px + w * .65, py - h); c.lineTo(px + w, py); c.closePath(); c.fill(); c.stroke(); }
  function foot(c, px, py, W) { c.fillStyle = "rgba(20,24,10,.32)"; c.beginPath(); c.ellipse(px + W * .15, py + .6, W * .9, W * .26, 0, 0, 6.3); c.fill(); }
  const sd = (px, py, a, b) => { const v = (px * a + py * b) % 1; return v < 0 ? v + 1 : v; };
  const TREE = {
    oak(c, px, py, k, col) { const W = 16 * k, H = 13 * k; foot(c, px, py, W); trunk(c, px, py, 3.2 * k, 13 * k); lobes(c, px, py - 19 * k, W, H, col, 6, sd(px, py, .013, .007)); },
    oakS(c, px, py, k, col) { TREE.oak(c, px, py, k * .72, col); },
    dark(c, px, py, k, col) { const W = 19 * k, H = 15 * k; foot(c, px, py, W); trunk(c, px, py, 4.4 * k, 14 * k); lobes(c, px, py - 22 * k, W, H, col, 7, sd(px, py, .011, .009)); },
    beech(c, px, py, k, col) { const W = 13 * k, H = 17 * k; foot(c, px, py, W); c.fillStyle = "#8d8a78"; c.strokeStyle = INKT; c.lineWidth = .8 * LW; c.beginPath(); c.rect(px - 2.1 * k, py - 14 * k, 4.2 * k, 14 * k); c.fill(); c.stroke(); lobes(c, px, py - 25 * k, W * .92, H * .92, col, 7, sd(px, py, .017, .005)); },
    beechS(c, px, py, k, col) { TREE.beech(c, px, py, k * .72, col); },
    birch(c, px, py, k, col) { const W = 6.6 * k, H = 10 * k; foot(c, px, py, W); c.fillStyle = "#e8e4d2"; c.strokeStyle = INKT; c.lineWidth = .8 * LW; c.beginPath(); c.rect(px - 1.1 * k, py - 15 * k, 2.2 * k, 15 * k); c.fill(); c.stroke(); c.lineWidth = .7 * LW; c.beginPath(); [3, 6, 9.5, 12].forEach(a => { c.moveTo(px - k, py - a * k); c.lineTo(px + .5 * k, py - a * k); }); c.stroke(); lobes(c, px, py - 20 * k, W, H, col, 4, sd(px, py, .019, .003)); },
    hemlock(c, px, py, k, col) { const H = 33 * k, W = 10.5 * k; foot(c, px, py, W); trunk(c, px, py, 1.9 * k, 5 * k); c.strokeStyle = INKT; c.lineWidth = 1.1 * LW; for (let i = 0; i < 4; i++) { const top = py - H + i * H * .2, base = py - H * .52 + i * H * .16, w = W * (.5 + i * .2); c.fillStyle = i % 2 ? shadeCol(col, 10) : col; c.beginPath(); c.moveTo(px, top); c.quadraticCurveTo(px + w * .45, base - (base - top) * .25, px + w, base); c.quadraticCurveTo(px, base - H * .04, px - w, base); c.quadraticCurveTo(px - w * .45, base - (base - top) * .25, px, top); c.closePath(); c.fill(); c.stroke(); } },
    pine(c, px, py, k, col) { const W = 10 * k; foot(c, px, py, W * .8); c.fillStyle = "#6b4427"; c.strokeStyle = INKT; c.lineWidth = .8 * LW; c.beginPath(); c.moveTo(px - 1.7 * k, py); c.lineTo(px - .8 * k, py - 24 * k); c.lineTo(px + .8 * k, py - 24 * k); c.lineTo(px + 1.7 * k, py); c.closePath(); c.fill(); c.stroke();
      [[0, -13, 1, .42], [.6, -19.5, .76, .42], [-.4, -25, .5, .42]].forEach(([dx, dy, a, b]) => { c.fillStyle = col; c.strokeStyle = INKT; c.lineWidth = 1.1 * LW; c.beginPath(); c.ellipse(px + dx * k, py + dy * k, W * a, W * b, 0, 0, 6.3); c.fill(); c.stroke(); c.fillStyle = shadeCol(col, 18); c.beginPath(); c.ellipse(px + (dx - 1.2) * k, py + (dy - 1) * k, W * a * .55, W * b * .42, 0, 0, 6.3); c.fill(); }); },
    willow(c, px, py, k, col) { const W = 10.5 * k, H = 6.2 * k, cy = py - 15 * k; foot(c, px, py, W); trunk(c, px, py, 1.9 * k, 13 * k); const st = [[-1, .55], [-.72, .95], [-.42, .72], [-.14, 1.05], [.16, .78], [.45, 1], [.74, .7], [1, .5]];
      const hang = (w, sty) => { c.strokeStyle = sty; c.lineWidth = w; c.beginPath(); st.forEach(([a, l]) => { const X = px + a * W; c.moveTo(X, cy - H * .1); c.quadraticCurveTo(X + a * 1.6 * k, cy + H * .9 * l, X + a * .8 * k, cy + H * 2 * l); }); c.stroke(); };
      hang(3.5 * k, INKT); hang(2.5 * k, shadeCol(col, -16)); lobes(c, px, cy - H * .15, W * .92, H, col, 5, sd(px, py, .021, .004)); } };
  function scrub(c, px, py, k, col) { c.strokeStyle = INKT; c.lineWidth = .8 * LW; c.fillStyle = col; [[-3, 0, 2.8], [2.6, .6, 3.1], [0, -2, 3.1]].forEach(p => { c.beginPath(); c.arc(px + p[0] * k, py + p[1] * k, p[2] * k, 0, 6.3); c.fill(); c.stroke(); }); }
  function reeds(c, px, py, k) { c.strokeStyle = "#3f5236"; c.lineWidth = 1.1 * LW; c.beginPath(); c.moveTo(px - 3 * k, py); c.lineTo(px - 4 * k, py - 5 * k); c.moveTo(px, py); c.lineTo(px, py - 7 * k); c.moveTo(px + 3 * k, py); c.lineTo(px + 4 * k, py - 5 * k); c.stroke(); }
  function understory(c, wx, wy, t, px, py, r3, r4, K) {
    const k = Math.max(K, .7);
    if (t === 0 && r3 < .4) { c.strokeStyle = "rgba(96,76,34,.34)"; c.lineWidth = 1.1 * LW; c.beginPath(); c.moveTo(px - 6 * K, py); c.lineTo(px + 6 * K, py + K); c.stroke(); }
    else if (t === 4 && r3 < .3) reeds(c, px, py, k);
    else if (open(t) && isEdge(wx, wy) && r3 < .34) scrub(c, px, py, k, P.oak[(r4 * 4) | 0]);
    else if (t === 1 && r3 < .05) scrub(c, px, py, k, P.oak[(r4 * 4) | 0]);
    else if (t === 6 && r3 < .16 && (style.hills === "marks" || style.hills === "both")) { const q = 9 * K; c.fillStyle = "#d8c9a3"; c.strokeStyle = "#4d4231"; c.lineWidth = LW; c.beginPath(); c.moveTo(px - q, py + q * .6); c.lineTo(px, py - q * .7); c.lineTo(px + q, py + q * .6); c.closePath(); c.fill(); c.stroke(); }
    else if (t === 6 && r3 < .07) { c.strokeStyle = "rgba(80,66,40,.45)"; c.lineWidth = 1.1 * LW; c.beginPath(); c.moveTo(px - 5 * K, py); c.lineTo(px + 5 * K, py - K); c.stroke(); }
    else if (t === 5 && style.water === "paper" && r3 < .05 && land.shoreAt(wx, wy) > .9) { const q = 6 * K; c.strokeStyle = style.water === "paper" ? "rgba(60,80,90,.5)" : "rgba(220,236,240,.45)"; c.lineWidth = 1.1 * LW; c.beginPath(); c.moveTo(px - 2 * q, py); c.quadraticCurveTo(px - q, py - q * .5, px, py); c.quadraticCurveTo(px + q, py + q * .5, px + 2 * q, py); c.stroke(); }
    else if (t === 5 && (style.water === "shallows" || style.water === "plain") && r3 < .07 && land.shoreAt(wx, wy) > .6) { const q = 5 * K; c.strokeStyle = "rgba(220,236,240,.55)"; c.lineWidth = 1.2 * LW; c.beginPath(); c.moveTo(px - 2 * q, py); c.quadraticCurveTo(px - q, py - q * .7, px, py); c.quadraticCurveTo(px + q, py + q * .7, px + 2 * q, py); c.stroke(); }
    else if (t === 8 && style.peaks === "shaded" && r3 < .18) { const q = 7 * K; c.strokeStyle = "#3a3632"; c.lineWidth = 1.2 * LW; c.beginPath(); c.moveTo(px - q, py + q * .5); c.lineTo(px - q * .3, py - q * .6); c.lineTo(px + q * .2, py + q * .1); c.lineTo(px + q, py - q * .4); c.stroke(); }
    else if (t === 7 && r3 < .4) { const q = 8 * K; c.strokeStyle = "#2d262a"; c.lineWidth = 1.2 * LW; c.beginPath(); c.moveTo(px, py + q); c.lineTo(px, py - q); c.moveTo(px, py - q * .2); c.lineTo(px - q * .6, py - q * .7); c.moveTo(px, py); c.lineTo(px + q * .6, py - q * .6); c.stroke(); }
  }
  /* Rounded hills, drawn far apart on hill country: an outline with a shaded flank, like a child's drawing of a hill. */
  function hummock(c, px, py, k, r3, r4) {
    const W = (46 + r3 * 30) * k, H = W * (.3 + r4 * .12);
    c.strokeStyle = "#564a36"; c.lineWidth = 1.3 * LW; c.fillStyle = "#c9bd8c";
    c.beginPath(); c.moveTo(px - W, py); c.quadraticCurveTo(px - W * .5, py - H * 1.9, px + W * .08, py - H * .4); c.quadraticCurveTo(px + W * .55, py - H * 1.15, px + W, py); c.fill(); c.stroke();
    c.strokeStyle = "rgba(86,74,54,.6)"; c.lineWidth = LW; c.beginPath();
    for (let i = 1; i <= 5; i++) { const a = px + W * (.1 + i * .15), b = py - H * (1.05 - i * .19); c.moveTo(a, b); c.lineTo(a + W * .09, py - 1); }
    c.stroke();
  }
  /* Storybook mountains: a jagged peak with a dark flank, a white cap on snow country. */
  function peak(c, px, py, k, r3, r4, snowy, scale = 1) {
    const W = (46 + r3 * 40) * k * scale, H = W * (.85 + r4 * .55);
    const R = [[-1, 0], [-.58, -.5], [-.34, -.38], [0, -1], [.2, -.66], [.38, -.78], [.66, -.36], [1, 0]].map(([a, b]) => [px + a * W, py + b * H]);
    c.strokeStyle = "#2d2925"; c.lineWidth = 1.5 * LW; c.lineJoin = "round";
    c.fillStyle = "#a8a39a"; c.beginPath(); R.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])); c.closePath(); c.fill(); c.stroke();
    /* the flank away from the light */
    c.fillStyle = "rgba(58,52,48,.5)"; c.beginPath(); c.moveTo(R[3][0], R[3][1]); c.lineTo(px + .14 * W, py); c.lineTo(px + W, py); for (let i = 6; i >= 4; i--) c.lineTo(R[i][0], R[i][1]); c.closePath(); c.fill();
    c.strokeStyle = "rgba(45,41,37,.55)"; c.lineWidth = .9 * LW; c.beginPath(); for (let i = 1; i <= 3; i++) { c.moveTo(R[3][0] + i * W * .06, R[3][1] + i * H * .2); c.lineTo(R[3][0] + i * W * .2, R[3][1] + i * H * .27); } c.stroke();
    if (snowy) {
      const cap = [[0, -1], [.14, -.77], [.09, -.68], [.03, -.72], [-.03, -.64], [-.1, -.7], [-.16, -.62], [-.24, -.68], [-.3, -.6], [-.2, -.72], [-.26, -.67]].map(([a, b]) => [px + a * W, py + b * H]);
      c.fillStyle = "#f4f5f2"; c.strokeStyle = "#2d2925"; c.lineWidth = 1.1 * LW; c.beginPath(); c.moveTo(R[3][0], R[3][1]); c.lineTo(cap[1][0], cap[1][1]); for (let i = 2; i < 9; i++) c.lineTo(cap[i][0], cap[i][1]); c.lineTo(R[2][0] + .02 * W, R[2][1]); c.closePath(); c.fill(); c.stroke();
      c.fillStyle = "rgba(120,124,128,.35)"; c.beginPath(); c.moveTo(R[3][0], R[3][1]); c.lineTo(cap[1][0], cap[1][1]); c.lineTo(cap[2][0], cap[2][1]); c.lineTo(px + .02 * W, py - .7 * H); c.closePath(); c.fill();
      c.fillStyle = "#eceeea"; c.beginPath(); c.moveTo(R[5][0], R[5][1]); c.lineTo(px + .5 * W, py - .58 * H); c.lineTo(px + .4 * W, py - .62 * H); c.lineTo(px + .3 * W, py - .55 * H); c.lineTo(px + .26 * W, py - .62 * H); c.closePath(); c.fill(); c.stroke();
    }
  }
  /* Draw every tree in a view. sp is grid spacing in miles; K scales the art. Trees keep fixed places on the land. */
  function draw(c, V, sp, K, lw) {
    LW = lw; c.lineJoin = "round"; c.lineCap = "round";
    const gs = s0 + 101, grid = (spacing, seedOff, fn) => {
      const n0 = Math.floor(V.x0 / spacing) - 1, n1 = Math.ceil(V.x1 / spacing) + 1, m0 = Math.floor(V.y0 / spacing) - 1, m1 = Math.ceil(V.y1 / spacing) + 1;
      for (let m = m1; m >= m0; m--) for (let n = n0; n <= n1; n++) {
        const a = Math.round(n * spacing * 64), b = Math.round(m * spacing * 64), wx = (n + hash(a, b, gs + seedOff)) * spacing, wy = (m + hash(a, b, gs + seedOff + 1)) * spacing;
        if (wx < land.x0 || wx > land.x1 || wy < land.y0 || wy > land.y1) continue;
        fn(wx, wy, tAt(wx, wy), V.X(wx), V.Y(wy), hash(a, b, gs + seedOff + 2), hash(a, b, gs + seedOff + 3));
      }
    };
    grid(sp * .64, 20, (wx, wy, t, px, py, r3, r4) => understory(c, wx, wy, t, px, py, r3, r4, K));
    if (style.hills === "hummocks" || style.hills === "both") grid(sp * 2.8, 40, (wx, wy, t, px, py, r3, r4) => { if (t === 6 && r3 < .75 && tAt(wx - .35, wy) === 6 && tAt(wx + .35, wy) === 6) hummock(c, px, py, K, r3, r4); });
    if (style.hills === "contours" || style.hills === "tinted") {
      /* contour labels: every 500 ft line gets a number where it crosses open ground */
      const lv = 500, pxm = (V.X(1) - V.X(0));
      c.font = `600 ${Math.max(10, 11 * K)}px "Barlow", "Segoe UI", sans-serif`; c.textAlign = "center"; c.textBaseline = "middle";
      grid(sp * 9, 90, (wx, wy, t, px, py, r3) => {
        if (t === 2 || t === 3 || t === 4 || t === 5 || r3 > .55) return;
        const e0 = elevAt(wx, wy), e1 = elevAt(wx + .6, wy); if (e0 === e1) return;
        const lo = Math.min(e0, e1), hi = Math.max(e0, e1), n = Math.ceil(lo / lv); if (n * lv > hi || n === 0) return;
        const f = (n * lv - e0) / (e1 - e0), lx = wx + .6 * f, ly = wy, ft = n * 500;
        const gx = elevAt(lx + .3, ly) - elevAt(lx - .3, ly), gy = elevAt(lx, ly + .3) - elevAt(lx, ly - .3), ang = Math.atan2(-gy, gx) + Math.PI / 2;
        const X = V.X(lx), Y = V.Y(ly);
        c.save(); c.translate(X, Y); c.rotate(ang > Math.PI / 2 || ang < -Math.PI / 2 ? ang + Math.PI : ang);
        const tw = c.measureText(String(ft)).width; c.fillStyle = "rgba(232,226,200,.85)"; c.fillRect(-tw / 2 - 2 * K, -7 * K, tw + 4 * K, 14 * K);
        c.fillStyle = "#4a3f2e"; c.fillText(String(ft), 0, 0); c.restore();
      });
    }
    if (style.hills === "contours" || style.hills === "tinted") {
      /* spot heights on summits: a small triangle and the height in feet */
      grid(sp * 5, 95, (wx, wy, t, px, py) => {
        if (t === 5) return; const e = elevAt(wx, wy); if (riseAt(wx, wy) < 250) return;
        for (const [dx, dy] of [[.5, 0], [-.5, 0], [0, .5], [0, -.5], [.35, .35], [-.35, .35], [.35, -.35], [-.35, -.35]]) if (elevAt(wx + dx, wy + dy) > e) return;
        const ft = Math.round(e / 10) * 10, label = ft.toLocaleString("en-US"), q = 5 * K;
        c.fillStyle = "#2d2925"; c.beginPath(); c.moveTo(px, py - q); c.lineTo(px + q * .9, py + q * .6); c.lineTo(px - q * .9, py + q * .6); c.closePath(); c.fill();
        c.font = `600 ${Math.max(10, 11 * K)}px "Barlow", "Segoe UI", sans-serif`; c.textAlign = "left"; c.textBaseline = "middle";
        const tw = c.measureText(label).width; c.fillStyle = "rgba(240,236,220,.85)"; c.fillRect(px + q * 1.3, py - 7 * K, tw + 4 * K, 14 * K);
        c.fillStyle = "#2d2925"; c.fillText(label, px + q * 1.3 + 2 * K, py);
      });
    }
    if (style.peaks === "classic") {
      const mtn = t => t === 8 || t === 9;
      /* peaks stand where the ground is high: big ones near crests, small ones on the flanks, none in the valleys */
      const crest = (x, y, d) => { const e = elevAt(x, y); return e >= elevAt(x + d, y) && e >= elevAt(x - d, y) && e >= elevAt(x, y + d) && e >= elevAt(x, y - d); };
      grid(sp * 2.2, 80, (wx, wy, t, px, py, r3, r4) => { const e = elevAt(wx, wy); if (mtn(t) && r3 < .5 && riseAt(wx, wy) > 2500 && riseAt(wx, wy) < 4500) peak(c, px, py, K, r3 * 2, r4, t === 9 || e > 7000, .5); });
      grid(sp * 3.2, 60, (wx, wy, t, px, py, r3, r4) => { const e = elevAt(wx, wy); if (mtn(t) && riseAt(wx, wy) > 4000 && crest(wx, wy, .3)) peak(c, px, py, K, r3, r4, t === 9 || e > 7000); });
    }
    grid(sp, 0, (wx, wy, t, px, py, r3) => { const s = speciesAt(wx, wy, t); if (s) TREE[s.kind](c, px, py, K * (.86 + r3 * .32), s.col); });
  }
  return { draw, speciesAt };
}

