/* Land generation and drawing. It must stay in step with the Survey Sheet page,
   so the same seed and paint give the same land in both. Coordinates are miles
   from the Stoneclaim pin: x east, y north. */
const OPEN = "0000000000000000000000014652000354443222100000000,0000000000000000000000026862001111222110000000000,0000000000000000000000135653454200000000000000000,0000000000000000000003322334786421000000000000000,0000000000000000000002200026986430000000000000000,0000000000000000000000000006995210000000000000000,0300000000000000000000010003773000000000000000000,4430000100000000000000001000231000000000000000000,5553002430000000000000000000010000000000000000000,5575334332000000000000000000011000000000000000000,4456676200000000000000000000010000000000000000000,2024685000000000000100000000000000000000000002100,1001343000000000000000000000000000000000000022200,2100121000000000000000000000000000000000001221000,3100012000000000000000000000000000000000003310000,0000110000000000000000000002100231000000012100000,0000000000000000000000000046643321000000011000000,0000000001300000000000000379975300000000000000000,0000000001310000000000002799995100000000000100000,0000000000110000000000004899996200000000000200000,0000000000001000000000025899997300000000000100000,0000000000000000245322368999998631000000000000000,0000000000000000478644799999999765200000000000000,0000000000000001478767999999998788410000000000000,0000000000000002346899999999999998521000000000000,0000000000000012235999999999999996321000000000000,0000000000000245558999999999999997553100000000000,0000000000002478999999999999999999985200000000011,0000000000003799999999999999999999997422000000112,0000011000015899999999999999999999999766531000011,0000002111135899999999999999999999999999864200000,0000000000134799999999999999989999999999974200000,0000000000013689999999999999977789999999985210000,0000000000003589999999999999865568999999997543210,0012221000014799999999999999865467888899999886433,0135554212346899999999999999876567878899999998766,0257776556789999999999999988886666678899999999988,1369998789999999999999999987766566667899999999999,2489999999999999999999999754544566667899999999999,6799999999999999999999998632234567778999889999999,9999999999999999999999999642345578999999999999999,9999999999999999999999999976667789999999999999999,9999999999999999999999999999999988999999999999999,9999999999999999999999999999999999999999999999999,9999999999989999999999999999999999999999999999999,9999999999989999999999999999999999999999999999999,9999999999989999999999999999999999999999999999999,9999999999999999999999999999999999999999999999999,9999999999999999999999999999999999999999999999999,9999999999999999999999999999999999999999999999999,9999999999999999999999999999999999999999999999999".split(",");

const X0 = -24, X1 = 24, Y0 = -28, Y1 = 22, CELL = 0.125, GW = 384, GH = 400, HEX_R = 11.547;
export const HEX_RADIUS = HEX_R;
export const MAP = { x0: -21, x1: 21, y0: -24, y1: 18, ppm: 150 };
export const HEXES = [{ cx: -10, cy: 5.736 }, { cx: 10, cy: 5.736 }, { cx: 0, cy: -11.585 }];
const COL = ["#e9e2b4", "#e2e5bf", "#bdd6a3", "#97c088", "#c6dccb", "#9ccbe0", "#dcc7a0", "#b9acb6"];
const CREEK = [{ x: -12, y: 21.9 }, { x: -9.5, y: 17 }, { x: -3.6, y: 9.2 }, { x: .9, y: 2.1 }, { x: .75, y: .15 }, { x: .1, y: -.65 }, { x: -2.2, y: -2.1 }, { x: -9, y: -8 }, { x: -23.9, y: -20.1 }];
const ROAD = [{ x: 0, y: 0 }, { x: .1, y: -.28 }, { x: .5, y: -.9 }, { x: 2, y: -1.35 }, { x: 6, y: -1.6 }, { x: 11, y: -2.2 }, { x: 15, y: -2.95 }, { x: 23.9, y: -4.65 }];

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

export function decodePaint(text) {
  const paint = new Int8Array(GW * GH).fill(-1);
  if (text) for (const r of text.split(";")) { const [a, n, v] = r.split(",").map(Number); paint.fill(v, a, a + n); }
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

export function renderMap({ seed = 1147, paint = "", creek = false, road = true } = {}) {
  const { x0, x1, y0, y1, ppm } = MAP, B = buildLand(seed, paint), T = B.terrain, E = B.elev;
  const w = Math.round((x1 - x0) * ppm), h = Math.round((y1 - y0) * ppm), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const PAL = new Uint32Array(64), PALC = new Uint32Array(64), PALE = new Uint32Array(8), cr = h2("#a67f52");
  COL.forEach((C, t) => {
    const c = h2(C);
    for (let l = 0; l < 8; l++) { const f = .965 + l * .01, r = c[0] * f, g = c[1] * f, b = c[2] * f; PAL[t * 8 + l] = u32(r, g, b); PALC[t * 8 + l] = u32(r * .55 + cr[0] * .45, g * .55 + cr[1] * .45, b * .55 + cr[2] * .45); }
    PALE[t] = u32(c[0] * .62, c[1] * .68, c[2] * .62);
  });
  const PAPER = u32(238, 240, 226), cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  const c = cv.getContext("2d"), img = c.createImageData(w, h), buf = new Uint32Array(img.data.buffer), lastT = new Int16Array(w + 1).fill(-1), lastB = new Int16Array(w + 1).fill(-999), inv = 1 / CELL, bands = 34;
  for (let py = 0; py < h; py++) {
    const wy = cy - (py + .5 - h / 2) / ppm; let leftT = -1, leftB = -999;
    for (let px = 0; px < w; px++) {
      const wx = cx + (px + .5 - w / 2) / ppm, a1 = (wx * 5.1 * 25.6) | 0, b1 = (wy * 5.1 * 25.6) | 0, n1 = TBL[(b1 & 255) << 8 | (a1 & 255)], a2 = (wy * 4.3 * 25.6 + 71) | 0, b2 = (wx * 4.3 * 25.6 + 13) | 0, n2 = TBL[(b2 & 255) << 8 | (a2 & 255)];
      const a3 = (wx * 61) | 0, b3 = (wy * 61) | 0, n3 = TBL[(b3 & 255) << 8 | (a3 & 255)];
      const dx = (n1 - .5) * .34 + (n3 - .5) * .05, dy = (n2 - .5) * .34 + (n1 - .5) * .03 + (n3 - .5) * .03;
      const fi = (wx + dx - X0) * inv, fj = (Y1 - wy - dy) * inv, i = Math.floor(fi), j = Math.floor(fj);
      if (i < 0 || j < 0 || i >= GW - 1 || j >= GH - 1) { buf[py * w + px] = PAPER; leftT = -1; lastT[px] = -1; lastB[px] = -999; continue; }
      const k = j * GW + i, t = T[k], a4 = (wx * 23) | 0, b4 = (wy * 23) | 0, lvl = Math.min(7, Math.max(0, (TBL[(b4 & 255) << 8 | (a4 & 255)] * 8) | 0));
      let col = PAL[t * 8 + lvl];
      if (t !== 5) {
        const u = fi - i, v = fj - j, e = (E[k] * (1 - u) + E[k + 1] * u) * (1 - v) + (E[k + GW] * (1 - u) + E[k + GW + 1] * u) * v, band = (e * bands) | 0;
        if ((leftB !== -999 && band !== leftB) || (lastB[px] !== -999 && band !== lastB[px])) col = PALC[t * 8 + lvl];
        leftB = band; lastB[px] = band;
      } else { leftB = -999; lastB[px] = -999; }
      if ((leftT >= 0 && t !== leftT && (t >= 2 || leftT >= 2)) || (lastT[px] >= 0 && t !== lastT[px] && (t >= 2 || lastT[px] >= 2))) col = PALE[Math.max(t, leftT >= 0 ? leftT : t)];
      buf[py * w + px] = col; leftT = t; lastT[px] = t;
    }
  }
  c.putImageData(img, 0, 0);
  const tAt = (x, y) => { const i = Math.floor((x - X0) / CELL), j = Math.floor((Y1 - y) / CELL); return (i < 0 || j < 0 || i >= GW || j >= GH) ? 1 : T[j * GW + i]; };
  const X = x => (x - cx) * ppm + w / 2, Y = y => (cy - y) * ppm + h / 2;
  let sp = 16; while (sp * ppm > 15 && sp > .01) sp /= 2;
  const A = new Path2D(), G = new Path2D(), F = new Path2D(), U = new Path2D(), D = new Path2D(), rt = Math.max(1.1, Math.min(5, sp * ppm * .27)), gs = B.s + 101;
  for (let m = Math.floor(y0 / sp) - 1; m <= Math.ceil(y1 / sp) + 1; m++) for (let n = Math.floor(x0 / sp) - 1; n <= Math.ceil(x1 / sp) + 1; n++) {
    const a = Math.round(n * sp * 64), b = Math.round(m * sp * 64), r1 = hash(a, b, gs), r2 = hash(a, b, gs + 1), r3 = hash(a, b, gs + 2), wx = (n + r1) * sp, wy = (m + r2) * sp, t = tAt(wx, wy), px = X(wx), py = Y(wy);
    if (t === 2) { if (r3 < .8) { A.moveTo(px + rt, py); A.arc(px, py, rt, 0, 6.3); } }
    else if (t === 3) { const R = rt * 1.35; G.moveTo(px + R, py); G.arc(px, py, R, 0, 6.3); }
    else if (t === 4) { if (r3 < .55) { const q = rt * 1.2; U.moveTo(px - q, py); U.lineTo(px - q * .2, py + q * .9); U.lineTo(px + q, py - q * .3); } }
    else if (t === 0) { if (r3 < .6) { const q = rt * 1.5, e = r1 < .5 ? 1 : -1; F.moveTo(px - q, py - e * q * .25); F.lineTo(px + q, py + e * q * .25); } }
    else if (t === 1) { if (r3 < .14) { D.moveTo(px + .9, py); D.arc(px, py, .9, 0, 6.3); } }
    else if (t === 6 && r3 < .5) { const q = rt * 1.3; U.moveTo(px - q, py + q * .5); U.lineTo(px, py - q * .6); U.lineTo(px + q, py + q * .5); }
    else if (t === 7 && r3 < .5) { const q = rt; F.moveTo(px - q, py - q); F.lineTo(px + q, py + q); F.moveTo(px + q, py - q); F.lineTo(px - q, py + q); }
  }
  c.lineWidth = .75;
  c.fillStyle = "#9dc283"; c.strokeStyle = "#5f8a55"; c.fill(A); c.stroke(A);
  c.fillStyle = "#6fa167"; c.strokeStyle = "#3f6d44"; c.fill(G); c.stroke(G);
  c.strokeStyle = "#6f9a86"; c.stroke(U);
  c.strokeStyle = "#b7a862"; c.stroke(F);
  c.fillStyle = "#a9a878"; c.fill(D);
  const hexPath = H => { for (let i = 0; i < 6; i++) { const a = Math.PI / 180 * (60 * i + 30), px = X(H.cx + Math.cos(a) * HEX_R), py = Y(H.cy + Math.sin(a) * HEX_R); i ? c.lineTo(px, py) : c.moveTo(px, py); } c.closePath(); };
  c.beginPath(); c.rect(0, 0, w, h); HEXES.forEach(hexPath); c.fillStyle = "rgba(238,240,226,.66)"; c.fill("evenodd");
  const line = (pts, lw, col) => { c.beginPath(); pts.forEach((p, i) => i ? c.lineTo(X(p.x), Y(p.y)) : c.moveTo(X(p.x), Y(p.y))); c.lineWidth = lw; c.strokeStyle = col; c.lineJoin = "round"; c.stroke(); };
  if (road) line(B.road, ppm * .022, "#6d5a44");
  if (creek) line(B.creek, ppm * .024, "#2f7ea6");
  return { canvas: cv, w, h, fingerprint: landFingerprint(B) };
}
