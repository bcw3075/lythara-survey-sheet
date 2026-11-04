/* Encounter maps: the land at 5-ft squares, read from the same world as the sheets.
   Everything is placed on fixed world lattices (feet from the world origin), so the same spot always gives the same map,
   and a map that grows keeps everything already on it. Coordinates: world miles (x east, y north) as everywhere else;
   inside this file, local feet from the map's top-left corner (u east, v south). */
import { CELL, T, buildLand, hash, fbm, meander } from "./land.mjs";
import { STORY_GROUND, makeStory } from "./story.mjs";
import { makeSliceReader } from "./survey.mjs";

export const FT_PER_MI = 5280, SQ_FT = 5;

/* smooth value noise from the shared sine table, read bilinearly so it has no steps at close range */
const TBL = new Float32Array(65536);
for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
  const a = x / 256 * Math.PI * 2, b = y / 256 * Math.PI * 2;
  TBL[y << 8 | x] = .5 + .17 * (Math.sin(a * 3 + 1.3 * Math.sin(b * 2)) + Math.sin(b * 5 + a) + .6 * Math.sin(a * 11 + b * 7) + .5 * Math.sin(a * 7 - b * 13));
}
const tbl = (x, y) => { const i = Math.floor(x), j = Math.floor(y), u = x - i, v = y - j, g = (a, b) => TBL[(b & 255) << 8 | (a & 255)];
  return (g(i, j) * (1 - u) + g(i + 1, j) * u) * (1 - v) + (g(i, j + 1) * (1 - u) + g(i + 1, j + 1) * u) * v; };

/* Tree sizes in feet: canopy radius range and trunk radius. */
const SPECIES = {
  oak: [15, 21, 1.6], oakS: [10, 14, 1.0], dark: [20, 27, 2.4], beech: [13, 18, 1.3], beechS: [9, 12, .9],
  birch: [7, 10, .6], hemlock: [9, 13, 1.1], pine: [8, 11, .9], willow: [12, 16, 1.2]
};
const PAL = { oak: ["#616531", "#717436", "#535a2d", "#6a6e33"], old: ["#3c4324", "#474e2d", "#303623"], beech: ["#94993f", "#838a41", "#a8ad48"], birch: ["#b0b54e", "#a8ad48", "#bdbf5a"], hemlock: ["#2f4232", "#36493a", "#2a3b2e"], pine: ["#465a2e", "#506433", "#3e5230"], willow: ["#8d9a58", "#7c8e55", "#9aa562"] };

/** Read the land for an encounter map and lay out every feature. Pure data; drawing is separate. */
export function planEncounter(data, { cx, cy, cols = 40, rows = 40 }) {
  const Wft = cols * SQ_FT, Hft = rows * SQ_FT, wmi = Wft / FT_PER_MI, hmi = Hft / FT_PER_MI;
  const x0 = cx - wmi / 2, y1 = cy + hmi / 2;
  /* land a mile around the map, so edges and lines have context */
  const slice = makeSliceReader(data.slice), land = buildLand({ seed: data.seed, frame: { x0: x0 - 1, x1: x0 + wmi + 1, y0: y1 - hmi - 1, y1: y1 + 1 }, slice, paint: data.paint, lines: data.lines, pins: data.pins });
  const story = makeStory(land), s = land.s;
  const W = (u, v) => ({ x: x0 + u / FT_PER_MI, y: y1 - v / FT_PER_MI });       /* local feet -> world miles */
  const L = (x, y) => ({ u: (x - x0) * FT_PER_MI, v: (y1 - y) * FT_PER_MI });     /* world miles -> local feet */
  const T_ = land.terrain, E = land.elev, GW = land.gw, GH = land.gh, inv = 1 / CELL;
  /* terrain as the sheet paints it (same warp, read smoothly), with a close-range ragged edge on top */
  function terrainAt(wx, wy) {
    /* same warp as the sheet's paintGround: n1 at (x,y)*5.1, n2 at (y,x)*4.3 offset, n3 at 61/mi */
    const n1 = tbl(wx * 5.1 * 25.6, wy * 5.1 * 25.6), n2 = tbl(wy * 4.3 * 25.6 + 71, wx * 4.3 * 25.6 + 13), n3 = tbl(wx * 61, wy * 61);
    let dx = (n1 - .5) * .34, dy = (n2 - .5) * .34;
    dx += (n3 - .5) * .05; dy += (n1 - .5) * .03 + (n3 - .5) * .03;
    const fx = wx * FT_PER_MI, fy = wy * FT_PER_MI;
    dx += (fbm(fx / 38, fy / 38, 3, s + 301) - .5) * 24 / FT_PER_MI; dy += (fbm(fx / 38, fy / 38, 3, s + 307) - .5) * 24 / FT_PER_MI;
    const i = Math.floor((wx + dx) * inv) - land.i0, j = Math.floor(land.j1 - (wy + dy) * inv);
    if (i < 0 || j < 0 || i >= GW || j >= GH) return T.rough;
    return T_[j * GW + i];
  }
  /* height in feet: the land model, plus small hummocks */
  const elevAt = (wx, wy) => { const fi = wx * inv - land.i0 - .5, fj = land.j1 - wy * inv - .5, i = Math.floor(fi), j = Math.floor(fj); if (i < 0 || j < 0 || i >= GW - 1 || j >= GH - 1) return 0;
    const u = fi - i, v = fj - j, k = j * GW + i; return (E[k] * (1 - u) + E[k + 1] * u) * (1 - v) + (E[k + GW] * (1 - u) + E[k + GW + 1] * u) * v; };
  /* lines that pass near the map, bent a little more at close range */
  const pad = 60, lines = [];
  for (const l of land.lines) {
    const pts = l.course.map(p => L(p.x, p.y)), near = pts.some((p, i) => i && segBoxDist(pts[i - 1], p, -pad, -pad, Wft + pad, Hft + pad) <= 0);
    if (!near) continue;
    const fine = meander(l.course, l.kind === "road" || l.kind === "track" ? .04 : .16, 3, s + 900 + l.id.length).map(p => L(p.x, p.y));
    lines.push({ id: l.id, kind: l.kind, pts: fine.filter((p, i, a) => { const q = a[Math.max(0, i - 1)], r = a[Math.min(a.length - 1, i + 1)]; return [p, q, r].some(z => z.u > -400 && z.u < Wft + 400 && z.v > -400 && z.v < Hft + 400); }) });
  }
  const water = lines.filter(l => l.kind === "creek" || l.kind === "river"), roads = lines.filter(l => l.kind === "road" || l.kind === "track");
  const halfWidth = (l, u, v) => { const n = fbm((x0 * FT_PER_MI + u) / 55, (y1 * FT_PER_MI - v) / 55, 3, s + 333); return l.kind === "river" ? 14 + 10 * n : 2.5 + 6 * n * n; };
  /* close-range wander: the line is read through a slow warp, so creeks and tracks bend every few dozen feet */
  const wob = (u, v, amp, sc, k) => { const gx = x0 * FT_PER_MI + u, gy = y1 * FT_PER_MI - v; return [u + (fbm(gx / sc, gy / sc, 3, s + k) - .5) * 2 * amp, v + (fbm(gx / sc, gy / sc, 3, s + k + 5) - .5) * 2 * amp]; };
  const lineDist = (l, u, v) => { let best = 1e9; for (let i = 1; i < l.pts.length; i++) best = Math.min(best, segDist(u, v, l.pts[i - 1], l.pts[i])); return best; };
  /* water depth signal: <0 dry; 0..1 shallow edge to channel */
  function waterAt(u, v) { let w = -1; const [a, b] = wob(u, v, 9, 70, 351); for (const l of water) { const hw = halfWidth(l, u, v), d = lineDist(l, a, b); w = Math.max(w, 1 - d / hw); } return w; }
  function roadAt(u, v) { let r = 1e9; const [a, b] = wob(u, v, 4, 90, 361); for (const l of roads) r = Math.min(r, lineDist(l, a, b)); return r; }

  /* features on world lattices (feet from the world origin) */
  const feats = { trees: [], brush: [], logs: [], rocks: [] }, m = 30;
  const lattice = (S, seedOff, fn) => {
    const fx0 = Math.floor((x0 * FT_PER_MI - m) / S), fx1 = Math.ceil((x0 * FT_PER_MI + Wft + m) / S), fy0 = Math.floor((y1 * FT_PER_MI - Hft - m) / S), fy1 = Math.ceil((y1 * FT_PER_MI + m) / S);
    for (let gy = fy1; gy >= fy0; gy--) for (let gx = fx0; gx <= fx1; gx++) {
      const r1 = hash(gx, gy, s + seedOff), r2 = hash(gx, gy, s + seedOff + 1), r3 = hash(gx, gy, s + seedOff + 2), r4 = hash(gx, gy, s + seedOff + 3);
      const wx = (gx + r1) * S / FT_PER_MI, wy = (gy + r2) * S / FT_PER_MI, p = L(wx, wy);
      fn(wx, wy, p.u, p.v, r3, r4, gx, gy);
    }
  };
  const forest = t => t === T.woods || t === T.old, clearOf = (u, v, ft) => waterAt(u, v) < -ft / 6 && roadAt(u, v) > 6 + ft;
  /* trees: one chance per 18-ft square of the world */
  lattice(18, 501, (wx, wy, u, v, r3, r4) => {
    const t = terrainAt(wx, wy);
    const p = t === T.old ? .62 : t === T.woods ? .7 : t === T.damp ? .45 : t === T.rough ? .035 : t === T.hills ? .05 : t === T.fields ? .006 : 0;
    if (r3 >= p) return;
    let sp = story.speciesAt(wx, wy, t);
    for (let k = 1; !sp && forest(t) && k < 6; k++) sp = story.speciesAt(wx + k * .004, wy - k * .003, t);
    if (!sp) sp = { kind: t === T.damp ? "willow" : "oakS", col: (t === T.damp ? PAL.willow : PAL.oak)[(r4 * 3) | 0] };
    const [rMin, rMax, tr] = SPECIES[sp.kind] ?? SPECIES.oak, R = (rMin + (rMax - rMin) * r4) * .72;
    if (!clearOf(u, v, Math.max(2, tr * 2))) return;
    feats.trees.push({ u, v, R, trunk: tr * (.8 + r4 * .5), kind: sp.kind, col: sp.col, seed: r3 * 997 + r4 });
  });
  /* undergrowth: patches where a slow noise runs high; denser on damp ground and at forest edges */
  lattice(6, 611, (wx, wy, u, v, r3) => {
    const t = terrainAt(wx, wy), fx = wx * FT_PER_MI, fy = wy * FT_PER_MI, n = fbm(fx / 34, fy / 34, 3, s + 613);
    const th = t === T.damp ? .5 : t === T.woods ? .58 : t === T.old ? .64 : t === T.rough ? .66 : t === T.hills ? .7 : 1;
    if (n < th || r3 > .8 || !clearOf(u, v, 2)) return;
    feats.brush.push({ u, v, r: 2.2 + r3 * 2.4, t });
  });
  /* deadfall in the woods */
  lattice(55, 701, (wx, wy, u, v, r3, r4) => {
    const t = terrainAt(wx, wy); if (!(forest(t) && r3 < (t === T.old ? .3 : .16)) || !clearOf(u, v, 8)) return;
    feats.logs.push({ u, v, len: 12 + r4 * 16, ang: r3 * 37 % Math.PI, w: 1.4 + r4 * 1.4 });
  });
  /* stones and boulders on rough and hill ground, and a few on the creek bed */
  lattice(26, 801, (wx, wy, u, v, r3, r4) => {
    const t = terrainAt(wx, wy), wa = waterAt(u, v);
    const p = t === T.hills ? .2 : t === T.rough ? .08 : t === T.crag ? .5 : forest(t) ? .04 : wa > -.6 && wa < .2 ? .25 : 0;
    if (r3 >= p || roadAt(u, v) < 8) return;
    feats.rocks.push({ u, v, r: (t === T.crag || t === T.hills ? 2 : 1) + r4 * 3, seed: r4 });
  });
  /* ground detail: grass tufts, flowers, leaf litter, ferns, on a 3-ft lattice */
  feats.tufts = [];
  lattice(3, 901, (wx, wy, u, v, r3, r4) => {
    if (u < -4 || v < -4 || u > Wft + 4 || v > Hft + 4) return;
    const t = terrainAt(wx, wy), wa = waterAt(u, v); if (wa > -.15 || roadAt(u, v) < 6) return;
    const kind = forest(t) ? (r3 < (t === T.old ? .16 : .1) ? "fern" : r3 < .38 ? "leaf" : null) : (t === T.fields || t === T.rough || t === T.hills || t === T.damp) ? (r3 < .34 ? "tuft" : r3 < (t === T.fields ? .37 : .355) ? "flower" : null) : null;
    if (kind) feats.tufts.push({ u, v, kind, r: r4, t });
  });
  return { cols, rows, Wft, Hft, x0, y1, cx, cy, land, terrainAt, elevAt, waterAt, roadAt, W, L, lines, feats };
}

function segDist(px, py, a, b) { const dx = b.u - a.u, dy = b.v - a.v, l2 = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((px - a.u) * dx + (py - a.v) * dy) / l2)); return Math.hypot(px - a.u - t * dx, py - a.v - t * dy); }
function segBoxDist(a, b, x0, y0, x1, y1) { /* <=0 when the segment touches the box (coarse) */
  const minx = Math.min(a.u, b.u), maxx = Math.max(a.u, b.u), miny = Math.min(a.v, b.v), maxy = Math.max(a.v, b.v);
  return Math.max(x0 - maxx, minx - x1, y0 - maxy, miny - y1);
}

/* ---------- drawing ---------- */
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const shade = (c, d) => `rgb(${Math.max(0, Math.min(255, c[0] + d)) | 0},${Math.max(0, Math.min(255, c[1] + d)) | 0},${Math.max(0, Math.min(255, c[2] + d)) | 0})`;

export const ENC_STYLES = {
  /* storybook: the overland palette, inked outlines, flat shading */
  story: { ground: { [T.fields]: "#c9bc78", [T.rough]: "#b4b066", [T.woods]: "#7c8048", [T.old]: "#5c6236", [T.damp]: "#8f9a62", [T.hills]: "#bdb07e", [T.bad]: "#7a6e66", [T.crag]: "#9a958a", [T.snow]: "#eceee8" },
    ink: "#20190f", water: ["#8fb8b4", "#4f8a96", "#3c7280"], bank: "#a4946a", road: "#b39a6c", outline: true, soft: 0, grid: "rgba(40,32,20,.14)", tex: .9 },
  /* painted: no outlines, layered soft canopies, deeper shadows */
  painted: { ground: { [T.fields]: "#b8ad6a", [T.rough]: "#9fa05a", [T.woods]: "#5f6a36", [T.old]: "#465029", [T.damp]: "#7f8c56", [T.hills]: "#aa9f72", [T.bad]: "#6a5e58", [T.crag]: "#8d887e", [T.snow]: "#e6e8e3" },
    ink: null, water: ["#7aa6a2", "#3f7480", "#2c5866"], bank: "#8f7f58", road: "#a48b5f", outline: false, soft: 1, grid: "rgba(20,20,10,.12)", tex: 1.7 },
  /* tactical: pale and clear; canopies see-through so the ground and trunks always read */
  tactical: { ground: { [T.fields]: "#e4dcb4", [T.rough]: "#d6d6a8", [T.woods]: "#b9c09a", [T.old]: "#a3ad86", [T.damp]: "#c2cca6", [T.hills]: "#dcd2b0", [T.bad]: "#bdb3ab", [T.crag]: "#c8c4bc", [T.snow]: "#f4f5f2" },
    ink: "#3b3a30", water: ["#bcd8de", "#7fb0c0", "#5e98ad"], bank: "#d2c49c", road: "#d8c7a0", outline: true, soft: 0, grid: "rgba(40,40,30,.32)", tex: .45, seeThrough: true }
};

/** Draw a planned encounter map. pxSq: pixels per 5-ft square. Returns the canvas. */
export function drawEncounter(plan, styleName = "story", pxSq = 100) {
  const st = ENC_STYLES[styleName], ppf = pxSq / SQ_FT, w = Math.round(plan.Wft * ppf), h = Math.round(plan.Hft * ppf);
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h; const c = cv.getContext("2d");
  const img = c.createImageData(w, h), buf = new Uint32Array(img.data.buffer);
  const GC = {}; for (const k in st.ground) GC[k] = hex(st.ground[k]);
  const WC = st.water.map(hex), BANK = hex(st.bank), ROAD = hex(st.road);
  /* coarse fields every 1 ft: terrain, height, water, road */
  const fw = Math.ceil(plan.Wft) + 2, fh = Math.ceil(plan.Hft) + 2, TF = new Uint8Array(fw * fh), EF = new Float32Array(fw * fh), WF = new Float32Array(fw * fh), RF = new Float32Array(fw * fh);
  for (let j = 0; j < fh; j++) for (let i = 0; i < fw; i++) { const k = j * fw + i, p = plan.W(i, j); TF[k] = plan.terrainAt(p.x, p.y); WF[k] = plan.waterAt(i, j); RF[k] = plan.roadAt(i, j);
    const fx = p.x * FT_PER_MI, fy = p.y * FT_PER_MI; EF[k] = plan.elevAt(p.x, p.y) + (fbm(fx / 30, fy / 30, 3, plan.land.s + 41) - .5) * 5 - Math.max(0, WF[k] + 1) * 2.4; }
  const bil = (A, u, v) => { const i = Math.max(0, Math.min(fw - 2, Math.floor(u))), j = Math.max(0, Math.min(fh - 2, Math.floor(v))), a = u - i, b = v - j, k = j * fw + i; return (A[k] * (1 - a) + A[k + 1] * a) * (1 - b) + (A[k + fw] * (1 - a) + A[k + fw + 1] * a) * b; };
  const ox = plan.x0 * FT_PER_MI, oy = plan.y1 * FT_PER_MI;
  for (let py = 0; py < h; py++) {
    const v = py / ppf;
    for (let px = 0; px < w; px++) {
      const u = px / ppf, i0 = Math.min(fw - 2, Math.floor(u)), j0 = Math.min(fh - 2, Math.floor(v)), fa = u - i0, fb = v - j0, k0 = j0 * fw + i0;
      /* the class with the most bilinear weight among the four corners: boundaries become smooth curves */
      const q0 = TF[k0], q1 = TF[k0 + 1], q2 = TF[k0 + fw], q3 = TF[k0 + fw + 1], w0 = (1 - fa) * (1 - fb), w1 = fa * (1 - fb), w2 = (1 - fa) * fb, w3 = fa * fb;
      let t = q0, best = -1; for (const q of [q0, q1, q2, q3]) { const wq = (q === q0 ? w0 : 0) + (q === q1 ? w1 : 0) + (q === q2 ? w2 : 0) + (q === q3 ? w3 : 0); if (wq > best) { best = wq; t = q; } }
      const gx = ox + u, gy = oy - v, n1 = tbl(gx / 9, gy / 9), n2 = tbl(gx / 2.3 + 40, gy / 2.3 + 17), n3 = tbl(gx / .7 + 9, gy / .7 + 3);
      let col = GC[t] ?? GC[T.rough];
      /* hillshade: light from the north-west */
      const sl = (bil(EF, u - 1.5, v) - bil(EF, u + 1.5, v) + bil(EF, u, v - 1.5) - bil(EF, u, v + 1.5)) * 1.4;
      let d = (n1 - .5) * 26 * st.tex + (n2 - .5) * 18 * st.tex + (n3 - .5) * 12 * st.tex + sl * 7;
      const wa = bil(WF, u, v), rd = bil(RF, u, v);
      if (rd < 6) { const edge = Math.max(0, Math.min(1, (6 - rd) / 1.4)); col = mixc(col, ROAD, edge); if (Math.abs(rd - 2.6) < .55) d -= 16; }
      if (wa > -.7 && wa <= 0) { col = mixc(col, BANK, Math.min(1, (wa + .7) / .4)); if (wa > -.4) { const gv = Math.max(0, Math.min(1, (n2 - .5) * 6)) * Math.min(1, (wa + .4) / .2); col = mixc(col, [176, 168, 150], .6 * gv); d += (n3 - .5) * 30 * gv; } }
      if (wa > 0) { col = wa < .35 ? mixc(WC[0], WC[1], wa / .35) : mixc(WC[1], WC[2], Math.min(1, (wa - .35) / .5)); d = (n2 - .5) * 10 + (n3 - .5) * 8;
        if (st.soft) { if (wa < .12) d += 22; const rp = tbl(gx / 1.6 + gy / 3.1, gy / 1.6 - gx / 5); if (rp > .78) d += (rp - .78) * 120; } }
      buf[py * w + px] = (255 << 24 | (Math.max(0, Math.min(255, col[2] + d)) << 16) | (Math.max(0, Math.min(255, col[1] + d)) << 8) | Math.max(0, Math.min(255, col[0] + d))) >>> 0;
    }
  }
  c.putImageData(img, 0, 0);
  c.lineJoin = "round"; c.lineCap = "round";
  const P = (u, v) => [u * ppf, v * ppf], ink = st.ink, lw = Math.max(1, ppf * .22);
  /* creek edge line */
  if (st.outline) for (const l of plan.lines) if (l.kind === "creek" || l.kind === "river") {
    c.strokeStyle = styleName === "tactical" ? "rgba(60,100,120,.7)" : "rgba(40,70,80,.55)"; c.lineWidth = lw;
    /* trace the 0-contour of the water field */
    traceZero(c, WF, fw, fh, ppf);
  }
  /* ground detail */
  for (const q of plan.feats.tufts) {
    const [x, y] = P(q.u, q.v), k = ppf;
    if (q.kind === "tuft") { c.strokeStyle = styleName === "tactical" ? "rgba(110,120,70,.35)" : st.soft ? "rgba(60,70,25,.5)" : "rgba(70,62,24,.55)"; c.lineWidth = Math.max(1, k * .14); c.beginPath(); c.moveTo(x - .5 * k, y); c.lineTo(x - .8 * k, y - .9 * k); c.moveTo(x, y); c.lineTo(x + .05 * k, y - 1.1 * k); c.moveTo(x + .5 * k, y); c.lineTo(x + .85 * k, y - .85 * k); c.stroke(); }
    else if (q.kind === "flower") { c.fillStyle = q.r < .4 ? "#f0ecd8" : q.r < .7 ? "#e8c64a" : "#b88ac8"; c.beginPath(); c.arc(x, y, k * .28, 0, 7); c.fill(); }
    else if (q.kind === "leaf") { c.fillStyle = q.r < .5 ? "rgba(140,96,40,.35)" : "rgba(170,130,50,.3)"; c.beginPath(); c.ellipse(x, y, k * .5, k * .28, q.r * 6, 0, 7); c.fill(); }
    else if (q.kind === "fern") { c.strokeStyle = styleName === "tactical" ? "rgba(80,110,60,.5)" : "#4b6a2c"; c.lineWidth = Math.max(1, k * .16); c.beginPath(); for (let a = 0; a < 5; a++) { const an = a / 5 * 6.283 + q.r * 3; c.moveTo(x, y); c.quadraticCurveTo(x + Math.cos(an) * k * .9, y + Math.sin(an) * k * .9, x + Math.cos(an + .4) * k * 1.6, y + Math.sin(an + .4) * k * 1.6); } c.stroke(); }
  }
  /* brush */
  for (const b of plan.feats.brush) {
    const [x, y] = P(b.u, b.v), r = b.r * ppf, base = hex(b.t === T.damp ? "#6f8048" : "#55602f");
    if (styleName === "tactical") { c.fillStyle = "rgba(90,110,60,.35)"; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); continue; }
    if (st.soft) { c.fillStyle = "rgba(10,14,4,.25)"; c.beginPath(); c.arc(x + r * .25, y + r * .25, r, 0, 7); c.fill(); }
    blob(c, x, y, r, base, ink, lw * .8, b.u * 13 + b.v * 7, st.soft);
  }
  /* logs */
  for (const g of plan.feats.logs) {
    const [x, y] = P(g.u, g.v), L = g.len * ppf / 2, W = g.w * ppf, dx = Math.cos(g.ang) * L, dy = Math.sin(g.ang) * L;
    c.strokeStyle = ink ?? "#2a1e12"; c.lineWidth = W + lw * 2; c.beginPath(); c.moveTo(x - dx, y - dy); c.lineTo(x + dx, y + dy); c.stroke();
    c.strokeStyle = styleName === "tactical" ? "#8b7355" : "#6b4c2e"; c.lineWidth = W; c.beginPath(); c.moveTo(x - dx, y - dy); c.lineTo(x + dx, y + dy); c.stroke();
    c.strokeStyle = "rgba(255,240,210,.25)"; c.lineWidth = W * .3; c.beginPath(); c.moveTo(x - dx - W * .15, y - dy - W * .2); c.lineTo(x + dx - W * .15, y + dy - W * .2); c.stroke();
  }
  /* rocks */
  for (const r of plan.feats.rocks) {
    const [x, y] = P(r.u, r.v), R = r.r * ppf;
    if (st.soft) { c.fillStyle = "rgba(10,10,6,.3)"; c.beginPath(); c.ellipse(x + R * .3, y + R * .3, R, R * .8, 0, 0, 7); c.fill(); }
    c.fillStyle = styleName === "tactical" ? "#b4ada2" : "#8e8a80"; c.strokeStyle = ink ?? "transparent"; c.lineWidth = lw;
    c.beginPath(); for (let k = 0; k < 7; k++) { const a = k / 7 * 6.283 + r.seed * 3, rr = R * (.8 + .25 * hash(k, Math.round(r.seed * 999), 3)); k ? c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr * .85) : c.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr * .85); } c.closePath(); c.fill(); if (ink) c.stroke();
    c.fillStyle = "rgba(255,255,250,.25)"; c.beginPath(); c.ellipse(x - R * .25, y - R * .25, R * .4, R * .3, -.5, 0, 7); c.fill();
  }
  /* tree shadows, trunks, then canopies (biggest last so small trees peek out beneath) */
  const trees = plan.feats.trees.slice().sort((a, b) => a.R - b.R);
  if (styleName === "story") for (const t of trees) { const [x, y] = P(t.u, t.v); c.fillStyle = st.soft ? "rgba(8,12,4,.38)" : "rgba(20,24,10,.25)"; c.beginPath(); c.arc(x + t.R * ppf * .28, y + t.R * ppf * .32, t.R * ppf * .95, 0, 7); c.fill(); }
  for (const t of trees) {
    const [x, y] = P(t.u, t.v), R = t.R * ppf, col = hex(t.col);
    if (styleName === "tactical") {
      c.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},.30)`; c.strokeStyle = `rgba(${col[0] * .6 | 0},${col[1] * .6 | 0},${col[2] * .6 | 0},.85)`; c.lineWidth = lw; c.setLineDash([ppf * 1.2, ppf * .8]);
      c.beginPath(); c.arc(x, y, R, 0, 7); c.fill(); c.stroke(); c.setLineDash([]);
      c.fillStyle = "#5a4630"; c.strokeStyle = ink; c.beginPath(); c.arc(x, y, Math.max(t.trunk * ppf, ppf * .7), 0, 7); c.fill(); c.stroke();
      continue;
    }
    if (t.kind === "pine" || t.kind === "hemlock") conifer(c, x, y, R, col, ink, lw, t.seed, st.soft);
    else if (t.kind === "willow") { blob(c, x, y, R, col, ink, lw, t.seed, st.soft, 9, .3); }
    else blob(c, x, y, R, col, ink, lw, t.seed, st.soft, t.kind === "birch" ? 5 : 7);
  }
  /* grid */
  c.strokeStyle = st.grid; c.lineWidth = Math.max(1, pxSq / 60); c.beginPath();
  for (let i = 0; i <= plan.cols; i++) { c.moveTo(i * pxSq + .5, 0); c.lineTo(i * pxSq + .5, h); }
  for (let j = 0; j <= plan.rows; j++) { c.moveTo(0, j * pxSq + .5); c.lineTo(w, j * pxSq + .5); }
  c.stroke();
  return cv;
}

/* a canopy seen from above: lobes around a centre, ink outline drawn first so only the outside edge shows */
function blob(c, x, y, R, col, ink, lw, seed, soft, n = 7, jag = .18) {
  const pts = [[0, 0, .62]]; const key = Math.round(seed * 97) | 0;
  for (let i = 0; i < n; i++) { const a = i / n * 6.283 + seed, r = .5 + hash(i, key, 61) * jag; pts.push([Math.cos(a) * r, Math.sin(a) * r, .38 + hash(i, key, 62) * .16]); }
  const path = (sc, ox, oy) => { c.beginPath(); for (const p of pts) { const rr = p[2] * R * sc, a = x + p[0] * R * sc + ox * R, b = y + p[1] * R * sc + oy * R; c.moveTo(a + rr, b); c.arc(a, b, rr, 0, 7); } };
  if (ink) { c.strokeStyle = ink; c.lineWidth = lw * 2; path(1, 0, 0); c.stroke(); }
  if (soft) {
    /* painted: a dark body with a soft cast shadow, then many leaf clusters, lit from the north-west */
    c.save(); c.shadowColor = "rgba(8,12,4,.55)"; c.shadowBlur = R * .35; c.shadowOffsetX = R * .22; c.shadowOffsetY = R * .26;
    c.fillStyle = shade(col, -34); path(1, 0, 0); c.fill(); c.restore();
    const N = Math.round(18 + R / 3);
    for (let i = 0; i < N; i++) {
      const a = hash(i, key, 81) * 6.283, rr = Math.sqrt(hash(i, key, 82)) * .78, cxp = x + Math.cos(a) * rr * R, cyp = y + Math.sin(a) * rr * R, lit = (-(Math.cos(a) + Math.sin(a)) * rr) * 22;
      const r = R * (.16 + hash(i, key, 83) * .14);
      c.fillStyle = shade(col, -14 + lit + (hash(i, key, 84) - .5) * 18); c.beginPath(); c.arc(cxp, cyp, r, 0, 7); c.fill();
      c.fillStyle = shade(col, 14 + lit); c.beginPath(); c.arc(cxp - r * .3, cyp - r * .3, r * .45, 0, 7); c.fill();
    }
    return;
  }
  c.fillStyle = shade(col, 0); path(1, 0, 0); c.fill();
  c.fillStyle = shade(col, 24); path(.55, -.16, -.2); c.fill();
}
function conifer(c, x, y, R, col, ink, lw, seed, soft) {
  const n = 9, outer = [], key = Math.round(seed * 97) | 0;
  for (let i = 0; i < n * 2; i++) { const a = i / (n * 2) * 6.283 + seed, r = i % 2 ? .62 + hash(i, key, 71) * .08 : .98; outer.push([x + Math.cos(a) * R * r, y + Math.sin(a) * R * r]); }
  const poly = () => { c.beginPath(); outer.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])); c.closePath(); };
  if (ink) { c.strokeStyle = ink; c.lineWidth = lw * 1.4; poly(); c.stroke(); }
  c.fillStyle = shade(col, soft ? -12 : 0); poly(); c.fill();
  c.fillStyle = shade(col, soft ? 10 : 16); c.beginPath(); c.arc(x - R * .12, y - R * .14, R * .5, 0, 7); c.fill();
  c.fillStyle = shade(col, soft ? 26 : 30); c.beginPath(); c.arc(x - R * .1, y - R * .12, R * .2, 0, 7); c.fill();
}
/* marching-squares outline of where a field crosses zero */
function traceZero(c, F, fw, fh, ppf) {
  c.beginPath();
  for (let j = 0; j < fh - 1; j++) for (let i = 0; i < fw - 1; i++) {
    const a = F[j * fw + i], b = F[j * fw + i + 1], d = F[(j + 1) * fw + i], e = F[(j + 1) * fw + i + 1], pts = [];
    if ((a > 0) !== (b > 0)) pts.push([i + a / (a - b), j]);
    if ((b > 0) !== (e > 0)) pts.push([i + 1, j + b / (b - e)]);
    if ((d > 0) !== (e > 0)) pts.push([i + d / (d - e), j + 1]);
    if ((a > 0) !== (d > 0)) pts.push([i, j + a / (a - d)]);
    if (pts.length >= 2) { c.moveTo(pts[0][0] * ppf, pts[0][1] * ppf); c.lineTo(pts[1][0] * ppf, pts[1][1] * ppf); }
    if (pts.length === 4) { c.moveTo(pts[2][0] * ppf, pts[2][1] * ppf); c.lineTo(pts[3][0] * ppf, pts[3][1] * ppf); }
  }
  c.stroke();
}
