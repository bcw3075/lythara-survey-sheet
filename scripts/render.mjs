/* Land generation and drawing. It must stay in step with the Survey Sheet page,
   so the same seed and paint give the same land in both. Coordinates are miles
   from the Stoneclaim pin: x east, y north. */
const OPEN = "0000000000000000000000014652000354443222100000000,0000000000000000000000026862001111222110000000000,0000000000000000000000135653454200000000000000000,0000000000000000000003322334786421000000000000000,0000000000000000000002200026986430000000000000000,0000000000000000000000000006995210000000000000000,0300000000000000000000010003773000000000000000000,4430000100000000000000001000231000000000000000000,5553002430000000000000000000010000000000000000000,5575334332000000000000000000011000000000000000000,4456676200000000000000000000010000000000000000000,2024685000000000000100000000000000000000000002100,1001343000000000000000000000000000000000000022200,2100121000000000000000000000000000000000001221000,3100012000000000000000000000000000000000003310000,0000110000000000000000000002100231000000012100000,0000000000000000000000000046643321000000011000000,0000000001300000000000000379975300000000000000000,0000000001310000000000002799995100000000000100000,0000000000110000000000004899996200000000000200000,0000000000001000000000025899997300000000000100000,0000000000000000245322368999998631000000000000000,0000000000000000478644799999999765200000000000000,0000000000000001478767999999998788410000000000000,0000000000000002346899999999999998521000000000000,0000000000000012235999999999999996321000000000000,0000000000000245558999999999999997553100000000000,0000000000002478999999999999999999985200000000011,0000000000003799999999999999999999997422000000112,0000011000015899999999999999999999999766531000011,0000002111135899999999999999999999999999864200000,0000000000134799999999999999989999999999974200000,0000000000013689999999999999977789999999985210000,0000000000003589999999999999865568999999997543210,0012221000014799999999999999865467888899999886433,0135554212346899999999999999876567878899999998766,0257776556789999999999999988886666678899999999988,1369998789999999999999999987766566667899999999999,2489999999999999999999999754544566667899999999999,6799999999999999999999998632234567778999889999999,9999999999999999999999999642345578999999999999999,9999999999999999999999999976667789999999999999999,9999999999999999999999999999999988999999999999999,9999999999999999999999999999999999999999999999999,9999999999989999999999999999999999999999999999999,9999999999989999999999999999999999999999999999999,9999999999989999999999999999999999999999999999999,9999999999999999999999999999999999999999999999999,9999999999999999999999999999999999999999999999999,9999999999999999999999999999999999999999999999999,9999999999999999999999999999999999999999999999999".split(",");

const X0 = -24, X1 = 24, Y0 = -28, Y1 = 22, CELL = 0.125, GW = 384, GH = 400, HEX_R = 11.547;
export const HEX_RADIUS = HEX_R;
export const MAP = { x0: -21, x1: 21, y0: -24, y1: 18, ppm: 150 };
export const HEXES = [{ cx: -10, cy: 5.736 }, { cx: 10, cy: 5.736 }, { cx: 0, cy: -11.585 }];
const CREEK = [{ x: -12, y: 21.9 }, { x: -9.5, y: 17 }, { x: -3.6, y: 9.2 }, { x: .9, y: 2.1 }, { x: .75, y: .15 }, { x: .1, y: -.65 }, { x: -2.2, y: -2.1 }, { x: -9, y: -8 }, { x: -23.9, y: -20.1 }];
/* Follows the forest edge on open ground, rounding the tongue of woods east of the village. */
const ROAD = [{ x: 0, y: 0 }, { x: .1, y: -.28 }, { x: .5, y: -.9 }, { x: 2, y: -1.7 }, { x: 6, y: -3.4 }, { x: 11, y: -6.4 }, { x: 15, y: -9.6 }, { x: 19, y: -12.4 }, { x: 23.9, y: -14.2 }];

function hash(ix, iy, s) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(s, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967296;
}
function vnoise(x, y, s) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, s), b = hash(ix + 1, iy, s), c = hash(ix, iy + 1, s), d = hash(ix + 1, iy + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, o, s) { let t = 0, a = .5, n = 0; for (let i = 0; i < o; i++) { t += a * vnoise(x, y, s + i * 17); n += a; x *= 2.03; y *= 2.03; a *= .5; } return t / n; }
const ss = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function openAt(x, y) {
  const fx = x - X0, fy = Y1 - y, i = Math.max(0, Math.min(47, Math.floor(fx))), j = Math.max(0, Math.min(49, Math.floor(fy))), u = Math.min(1, Math.max(0, fx - i)), v = Math.min(1, Math.max(0, fy - j));
  const g = (a, b) => OPEN[b].charCodeAt(a) - 48;
  return ((g(i, j) * (1 - u) + g(i + 1, j) * u) * (1 - v) + (g(i, j + 1) * (1 - u) + g(i + 1, j + 1) * u) * v) / 9;
}
function meander(pts, rough, depth, seed) {
  let cur = pts.slice();
  for (let d = 0; d < depth; d++) {
    const nx = [cur[0]];
    for (let i = 1; i < cur.length; i++) {
      const a = cur[i - 1], b = cur[i], mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, L = Math.hypot(b.x - a.x, b.y - a.y);
      const r = (hash(Math.round(mx * 100), Math.round(my * 100), seed + d) - .5) * 2 * rough * L;
      nx.push({ x: mx - (b.y - a.y) / (L || 1) * r, y: my + (b.x - a.x) / (L || 1) * r }, b);
    }
    cur = nx;
  }
  return cur;
}

/** The road and creek courses, drawn by the module at a constant screen width. */
export function linesFor(seed) {
  const s = seed | 0;
  return { road: meander(ROAD, .06, 4, s + 83), creek: meander(CREEK, .2, 6, s + 71) };
}

export function decodePaint(text) {
  const paint = new Int8Array(GW * GH).fill(-1);
  if (text) for (const r of text.split(";")) { const [a, n, v] = r.split(",").map(Number); if (a >= 0 && n >= 0 && a + n <= paint.length && v >= 0 && v <= 7) paint.fill(v, a, a + n); }
  return paint;
}

export function buildLand(seed, paintText = "") {
  const s = seed | 0, terrain = new Uint8Array(GW * GH), elev = new Float32Array(GW * GH), near = new Uint8Array(GW * GH), r = Math.ceil(.3 / CELL), creek = meander(CREEK, .2, 6, s + 71);
  for (const p of creek) {
    const ci = Math.floor((p.x - X0) / CELL), cj = Math.floor((Y1 - p.y) / CELL);
    for (let j = cj - r; j <= cj + r; j++) for (let i = ci - r; i <= ci + r; i++) if (i >= 0 && j >= 0 && i < GW && j < GH && (i - ci) ** 2 + (j - cj) ** 2 <= r * r) near[j * GW + i] = 1;
  }
  for (let j = 0; j < GH; j++) {
    const y = Y1 - (j + .5) * CELL;
    for (let i = 0; i < GW; i++) {
      const x = X0 + (i + .5) * CELL, k = j * GW + i, e = fbm(x / 6, y / 6, 3, s + 11); elev[k] = e;
      const wx = x + (fbm(x / 1.7, y / 1.7, 2, s + 21) - .5) * 1.5, wy = y + (fbm(x / 1.7, y / 1.7, 2, s + 27) - .5) * 1.5;
      let o = openAt(wx, wy);
      o -= ss(.05, .6, wy) * ss(17, 10, Math.abs(wx)) * 1.15;
      const d = Math.hypot(x, y > 0 ? y * 2.6 : y * .8);
      o += ss(1.1, .15, d) * 1.3;
      let t;
      if (o > .5) { const n = fbm(x / .9, y / .9, 2, s + 31), D = Math.hypot(x, y); t = ((D < 3 + 3 * n && n > .36) || (D < 9 && n > .63)) ? 0 : 1; }
      else { const age = fbm(x / 2.6, y / 2.6, 3, s + 41) + .016 * Math.hypot(x, y), damp = fbm(x / 1.1, y / 1.1, 2, s + 51); if (e < .32 || (near[k] && damp > .5)) t = 4; else if (age > .67) t = 3; else t = 2; }
      terrain[k] = t;
    }
  }
  const paint = decodePaint(paintText);
  for (let k = 0; k < terrain.length; k++) if (paint[k] >= 0) terrain[k] = paint[k];
  return { s, terrain, elev, creek, road: meander(ROAD, .06, 4, s + 83) };
}

/** Fingerprint used to confirm the module and the sheet made the same land. */
export function landFingerprint(land) {
  let hv = 0;
  for (let y = -17; y < 23; y += .5) for (let x = -20; x < 20; x += .5) {
    const i = Math.floor((x - X0) / CELL), j = Math.floor((Y1 - y) / CELL);
    hv = (hv * 31 + ((i < 0 || j < 0 || i >= GW || j >= GH) ? 1 : land.terrain[j * GW + i])) | 0;
  }
  return hv;
}

const TBL = new Float32Array(65536);
for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
  const a = x / 256 * Math.PI * 2, b = y / 256 * Math.PI * 2;
  TBL[y << 8 | x] = .5 + .17 * (Math.sin(a * 3 + 1.3 * Math.sin(b * 2)) + Math.sin(b * 5 + a) + .6 * Math.sin(a * 11 + b * 7) + .5 * Math.sin(a * 7 - b * 13));
}
const h2 = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const u32 = (r, g, b) => (255 << 24 | (b & 255) << 16 | (g & 255) << 8 | (r & 255)) >>> 0;

/* ---------- storybook trees: same code in the module and the Survey Sheet ----------
   Tree types are a best guess from real temperate woods: terrain, ground height, wetness,
   forest age and edges decide them. The colours come from the World Map's canopy. */
const STORY_GROUND = ["#c6b670", "#b0ac62", "#747c44", "#48522e", "#8a965e", "#508696", "#beac82", "#6e625c"];
const STORY_HOLLOW = .41, STORY_RIDGE = .64;
function makeStory(tAt, elevAt, creekPts, seed) {
  const P = { oak: ["#616531", "#717436", "#535a2d", "#6a6e33"], old: ["#3c4324", "#474e2d", "#303623"], beech: ["#94993f", "#838a41", "#a8ad48"], birch: ["#b0b54e", "#a8ad48", "#bdbf5a"], hemlock: ["#2f4232", "#36493a", "#2a3b2e"], pine: ["#465a2e", "#506433", "#3e5230"], willow: ["#8d9a58", "#7c8e55", "#9aa562"] };
  const INKT = "#20190f", s0 = seed | 0, near = new Float32Array(GW * GH).fill(9), rr = Math.ceil(.32 / CELL);
  for (const p of creekPts) {
    const ci = Math.floor((p.x - X0) / CELL), cj = Math.floor((Y1 - p.y) / CELL);
    for (let j = cj - rr; j <= cj + rr; j++) for (let i = ci - rr; i <= ci + rr; i++) if (i >= 0 && j >= 0 && i < GW && j < GH) { const d = Math.hypot(i - ci, j - cj) * CELL, k = j * GW + i; if (d < near[k]) near[k] = d; }
  }
  const creekDist = (x, y) => { const i = Math.floor((x - X0) / CELL), j = Math.floor((Y1 - y) / CELL); return (i < 0 || j < 0 || i >= GW || j >= GH) ? 9 : near[j * GW + i]; };
  const forest = t => t === 2 || t === 3, open = t => t === 0 || t === 1;
  const isEdge = (x, y, n = .42) => forest(tAt(x + n, y)) || forest(tAt(x - n, y)) || forest(tAt(x, y + n)) || forest(tAt(x, y - n));
  const openNear = (x, y, n = .8) => open(tAt(x + n, y)) || open(tAt(x - n, y)) || open(tAt(x, y + n)) || open(tAt(x, y - n));
  function speciesAt(x, y, t) {
    const k = Math.round(x * 97), m = Math.round(y * 97), h = hash(k, m, 31), h2 = hash(k, m, 32), h3 = hash(k, m, 33), pick = (kind, pal) => ({ kind, col: P[pal || kind][(h3 * P[pal || kind].length) | 0] });
    if (t === 4) { if (h < .25) return null; return h < .78 ? pick("willow") : pick("birch"); }
    if (open(t)) { if (isEdge(x, y) && h < .1) return pick("birch"); if (creekDist(x, y) < .2 && h < .18) return pick("willow"); if (t === 1 && h < .012) return pick("oakS", "oak"); return null; }
    if (!forest(t)) return null;
    if (creekDist(x, y) < .3 && h < .55) return pick("willow");
    if (t === 2 && h2 < .3) return null;
    const e = elevAt(x, y), beechy = fbm(x / 3.2, y / 3.2, 2, s0 + 61);
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
    else if (t === 6 && r3 < .5) { const q = 9 * K; c.fillStyle = "#d8c9a3"; c.strokeStyle = "#4d4231"; c.lineWidth = LW; c.beginPath(); c.moveTo(px - q, py + q * .6); c.lineTo(px, py - q * .7); c.lineTo(px + q, py + q * .6); c.closePath(); c.fill(); c.stroke(); }
    else if (t === 7 && r3 < .4) { const q = 8 * K; c.strokeStyle = "#2d262a"; c.lineWidth = 1.2 * LW; c.beginPath(); c.moveTo(px, py + q); c.lineTo(px, py - q); c.moveTo(px, py - q * .2); c.lineTo(px - q * .6, py - q * .7); c.moveTo(px, py); c.lineTo(px + q * .6, py - q * .6); c.stroke(); }
  }
  /* Draw every tree in a view. sp is grid spacing in miles; K scales the art. Trees keep fixed places on the land. */
  function draw(c, V, sp, K, lw) {
    LW = lw; c.lineJoin = "round"; c.lineCap = "round";
    const gs = s0 + 101, grid = (spacing, seedOff, fn) => {
      const n0 = Math.floor(V.x0 / spacing) - 1, n1 = Math.ceil(V.x1 / spacing) + 1, m0 = Math.floor(V.y0 / spacing) - 1, m1 = Math.ceil(V.y1 / spacing) + 1;
      for (let m = m1; m >= m0; m--) for (let n = n0; n <= n1; n++) {
        const a = Math.round(n * spacing * 64), b = Math.round(m * spacing * 64), wx = (n + hash(a, b, gs + seedOff)) * spacing, wy = (m + hash(a, b, gs + seedOff + 1)) * spacing;
        if (wx < X0 || wx > X1 || wy < Y0 || wy > Y1) continue;
        fn(wx, wy, tAt(wx, wy), V.X(wx), V.Y(wy), hash(a, b, gs + seedOff + 2), hash(a, b, gs + seedOff + 3));
      }
    };
    grid(sp * .64, 20, (wx, wy, t, px, py, r3, r4) => understory(c, wx, wy, t, px, py, r3, r4, K));
    grid(sp, 0, (wx, wy, t, px, py, r3) => { const s = speciesAt(wx, wy, t); if (s) TREE[s.kind](c, px, py, K * (.86 + r3 * .32), s.col); });
  }
  return { draw, speciesAt };
}

export function renderMap({ seed = 1147, paint = "" } = {}) {
  const { x0, x1, y0, y1, ppm } = MAP, B = buildLand(seed, paint), T = B.terrain, E = B.elev, inv = 1 / CELL;
  const w = Math.round((x1 - x0) * ppm), h = Math.round((y1 - y0) * ppm), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const cl = v => Math.max(0, Math.min(255, v)), PAL = new Uint32Array(128), WATER = u32(44, 80, 92), PAPER = u32(238, 240, 226);
  STORY_GROUND.forEach((C, t) => { const c = h2(C); for (let l = 0; l < 16; l++) { const f = .88 + l * .016; PAL[t * 16 + l] = u32(cl(c[0] * f), cl(c[1] * f), cl(c[2] * f)); } });
  const shade = new Float32Array(GW * GH);
  for (let j = 1; j < GH - 1; j++) for (let i = 1; i < GW - 1; i++) { const k = j * GW + i; shade[k] = (E[k + 1] - E[k - 1] + E[k + GW] - E[k - GW]) * 115; }
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  const c = cv.getContext("2d"), img = c.createImageData(w, h), buf = new Uint32Array(img.data.buffer), lastT = new Int16Array(w + 1).fill(-1);
  for (let py = 0; py < h; py++) {
    const wy = cy - (py + .5 - h / 2) / ppm; let leftT = -1;
    for (let px = 0; px < w; px++) {
      const wx = cx + (px + .5 - w / 2) / ppm, a1 = (wx * 5.1 * 25.6) | 0, b1 = (wy * 5.1 * 25.6) | 0, n1 = TBL[(b1 & 255) << 8 | (a1 & 255)], a2 = (wy * 4.3 * 25.6 + 71) | 0, b2 = (wx * 4.3 * 25.6 + 13) | 0, n2 = TBL[(b2 & 255) << 8 | (a2 & 255)];
      const a3 = (wx * 61) | 0, b3 = (wy * 61) | 0, n3 = TBL[(b3 & 255) << 8 | (a3 & 255)];
      const dx = (n1 - .5) * .34 + (n3 - .5) * .05, dy = (n2 - .5) * .34 + (n1 - .5) * .03 + (n3 - .5) * .03;
      const fi = (wx + dx - X0) * inv, fj = (Y1 - wy - dy) * inv, i = Math.floor(fi), j = Math.floor(fj);
      if (i < 1 || j < 1 || i >= GW - 2 || j >= GH - 2) { buf[py * w + px] = PAPER; leftT = -1; lastT[px] = -1; continue; }
      const k = j * GW + i, t = T[k], u = fi - i, v = fj - j, a4 = (wx * 23) | 0, b4 = (wy * 23) | 0, m1 = TBL[(b4 & 255) << 8 | (a4 & 255)], a5 = (wx * 83) | 0, b5 = (wy * 83) | 0, m2 = TBL[(b5 & 255) << 8 | (a5 & 255)];
      const hs = (shade[k] * (1 - u) + shade[k + 1] * u) * (1 - v) + (shade[k + GW] * (1 - u) + shade[k + GW + 1] * u) * v;
      let col = PAL[t * 16 + Math.max(0, Math.min(15, (7.5 + hs + (m1 - .5) * 5 + (m2 - .5) * 2.4) | 0))];
      if ((leftT >= 0 && t !== leftT && (t === 5 || leftT === 5)) || (lastT[px] >= 0 && t !== lastT[px] && (t === 5 || lastT[px] === 5))) col = WATER;
      buf[py * w + px] = col; leftT = t; lastT[px] = t;
    }
  }
  c.putImageData(img, 0, 0);
  const tAt = (x, y) => { const i = Math.floor((x - X0) / CELL), j = Math.floor((Y1 - y) / CELL); return (i < 0 || j < 0 || i >= GW || j >= GH) ? 1 : T[j * GW + i]; };
  const elevAt = (x, y) => { const i = Math.floor((x - X0) / CELL), j = Math.floor((Y1 - y) / CELL); return (i < 0 || j < 0 || i >= GW || j >= GH) ? .5 : E[j * GW + i]; };
  const sp = .25, K = sp * ppm / 22;
  makeStory(tAt, elevAt, B.creek, B.s).draw(c, { x0, x1, y0, y1, X: x => (x - cx) * ppm + w / 2, Y: y => (cy - y) * ppm + h / 2 }, sp, K, K);
  return { canvas: cv, w, h, fingerprint: landFingerprint(B) };
}
