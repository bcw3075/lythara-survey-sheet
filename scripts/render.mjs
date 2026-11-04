/* Draws a sheet's land into a canvas for Foundry. The sheet artifact draws the same land with the same code. */
import { CELL, buildLand, landFingerprint } from "./land.mjs";
import { STORY_GROUND, STYLE, makeStory } from "./story.mjs";
import { makeSliceReader } from "./survey.mjs";

export const PPM = 150;

const TBL = new Float32Array(65536);
for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
  const a = x / 256 * Math.PI * 2, b = y / 256 * Math.PI * 2;
  TBL[y << 8 | x] = .5 + .17 * (Math.sin(a * 3 + 1.3 * Math.sin(b * 2)) + Math.sin(b * 5 + a) + .6 * Math.sin(a * 11 + b * 7) + .5 * Math.sin(a * 7 - b * 13));
}
const h2 = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const u32 = (r, g, b) => (255 << 24 | (b & 255) << 16 | (g & 255) << 8 | (r & 255)) >>> 0;

/** Paint one patch of land into an RGBA buffer. V maps pixels to world miles. Shared by the module and the sheet's tiles. */
export function paintGround(land, buf, w, h, V, contours) {
  const PAL = new Uint32Array(STORY_GROUND.length * 16), WATER = u32(44, 80, 92), PAPER = u32(238, 240, 226), cl = v => Math.max(0, Math.min(255, v));
  STORY_GROUND.forEach((C, t) => { const c = h2(C); for (let l = 0; l < 16; l++) { const f = .88 + l * .016; PAL[t * 16 + l] = u32(cl(c[0] * f), cl(c[1] * f), cl(c[2] * f)); } });
  const style = { ...STYLE, ...(land.style ?? {}) }, relief = style.hills === "relief" || style.hills === "both", contourMap = style.hills === "contours" || style.hills === "tinted", tinted = style.hills === "tinted";
  const W = style.water, shallows = W === "shallows", depth = W === "depth", ripples = W === "ripples", hatch = W === "hatch", paper = W === "paper";
  const SHALLOW = [u32(104, 152, 160), u32(130, 172, 172)], SAND = h2("#d9cba0"), DEEP = [u32(38, 70, 84), u32(44, 80, 92), u32(58, 98, 110), u32(84, 128, 140)], PAPERW = u32(226, 226, 206), INK = u32(60, 80, 90);
  const TINT = [h2("#9fa872"), h2("#c2b47c"), h2("#b6a98a"), h2("#9a948a"), h2("#dcdcd6")];  /* low to high, on rough ground only */
  /* contour interval by height: 100 ft in the lowland, 250 ft in the hills, 500 ft on the mountains; a contour never crosses these levels, so lines stay whole */
  const ivl = e => e < 2500 ? 100 : e < 5000 ? 250 : 500;
  /* smooth height at a true (unjittered) world point, for clean contour lines */
  const eAt = (x, y) => { const fi = x * inv - land.i0 - .5, fj = land.j1 - y * inv - .5, i = Math.floor(fi), j = Math.floor(fj); if (i < 0 || j < 0 || i >= GW - 1 || j >= GH - 1) return -1; const u = fi - i, v = fj - j, k = j * GW + i; return (E[k] * (1 - u) + E[k + 1] * u) * (1 - v) + (E[k + GW] * (1 - u) + E[k + GW + 1] * u) * v; };
  const prevRow = contourMap ? new Int16Array(w).fill(-1) : null;
  const mix = (col, c2, a) => u32(cl((col & 255) * (1 - a) + c2[0] * a), cl(((col >> 8) & 255) * (1 - a) + c2[1] * a), cl(((col >> 16) & 255) * (1 - a) + c2[2] * a));
  const T = land.terrain, E = land.elev, B = land.base, WET = land.wet, SH = land.shore, GW = land.gw, GH = land.gh, inv = 1 / CELL, lastT = new Int16Array(w + 1).fill(-1), fine = V.ppm > 70;
  /* hillshade from the slope in feet per cell; 40 ft across a cell (320 ft per mile) is a full shade step */
  if (!land.shade) { const S = land.shade = new Float32Array(GW * GH); for (let j = 1; j < GH - 1; j++) for (let i = 1; i < GW - 1; i++) { const k = j * GW + i; S[k] = Math.max(-5, Math.min(5, (E[k + 1] - E[k - 1] + E[k + GW] - E[k - GW]) / 40)); } }
  const shade = land.shade;
  for (let py = 0; py < h; py++) {
    const wy = V.wy(py + .5); let leftT = -1, leftL = -1;
    for (let px = 0; px < w; px++) {
      const wx = V.wx(px + .5), a1 = (wx * 5.1 * 25.6) | 0, b1 = (wy * 5.1 * 25.6) | 0, n1 = TBL[(b1 & 255) << 8 | (a1 & 255)], a2 = (wy * 4.3 * 25.6 + 71) | 0, b2 = (wx * 4.3 * 25.6 + 13) | 0, n2 = TBL[(b2 & 255) << 8 | (a2 & 255)];
      let dx = (n1 - .5) * .34, dy = (n2 - .5) * .34;
      if (fine) { const a3 = (wx * 61) | 0, b3 = (wy * 61) | 0, n3 = TBL[(b3 & 255) << 8 | (a3 & 255)]; dx += (n3 - .5) * .05; dy += (n1 - .5) * .03 + (n3 - .5) * .03; }
      const fi = (wx + dx) * inv - land.i0, fj = land.j1 - (wy + dy) * inv, i = Math.floor(fi), j = Math.floor(fj);
      if (i < 1 || j < 1 || i >= GW - 2 || j >= GH - 2) { buf[py * w + px] = PAPER; leftT = -1; lastT[px] = -1; continue; }
      const k = j * GW + i, t = T[k], u = fi - i, v = fj - j, a4 = (wx * 23) | 0, b4 = (wy * 23) | 0, m1 = TBL[(b4 & 255) << 8 | (a4 & 255)], a5 = (wx * 83) | 0, b5 = (wy * 83) | 0, m2 = TBL[(b5 & 255) << 8 | (a5 & 255)];
      const hs = (shade[k] * (1 - u) + shade[k + 1] * u) * (1 - v) + (shade[k + GW] * (1 - u) + shade[k + GW + 1] * u) * v;
      const rough = t === 6 || t === 8 || t === 9, open = t === 0 || t === 1, hs2 = rough ? hs * (contourMap ? 3.2 : 2.4) : (contourMap && open ? hs * 1.3 : hs);
      let col = PAL[t * 16 + Math.max(0, Math.min(15, (7.5 + hs2 + (m1 - .5) * 5 + (m2 - .5) * 2.4) | 0))];
      const e = (E[k] * (1 - u) + E[k + 1] * u) * (1 - v) + (E[k + GW] * (1 - u) + E[k + GW + 1] * u) * v;
      if (tinted && rough) { const z = Math.max(0, Math.min(3.999, (e - B[k] - 300) / 1500)), a = z | 0, f = z - a, c1 = TINT[a], c2 = TINT[a + 1]; col = mix(col, [c1[0] + (c2[0] - c1[0]) * f, c1[1] + (c2[1] - c1[1]) * f, c1[2] + (c2[2] - c1[2]) * f], .55); }
      if ((contours && t !== 5) || (relief && rough)) { const q = rough ? 1 / 110 : 1 / 70; if (((e * q) | 0) !== ((E[k] * q) | 0)) col = (col & 0xff000000) | ((col >> 1) & 0x7f7f7f); }
      if (contourMap) {
        /* contour lines every 100 ft, every 500 ft darker: a pixel is on a line when its level differs from the pixel left or above it */
        const ee = t === 5 ? -1 : eAt(wx, wy), L = ee < 0 ? -1 : Math.floor(ee / ivl(ee)), up = prevRow[px];
        if (L >= 0 && ((leftL >= 0 && leftL !== L) || (up >= 0 && up !== L))) { const top = Math.max(L, leftL, up), idx = (top * ivl(ee)) % 500 === 0, w = (rough || open) ? 1 : .75; col = mix(col, [58, 48, 34], (idx ? .7 : .38) * w); }
        leftL = L; prevRow[px] = L;
      }
      if (SH && t === 5) {
        /* d: miles out from the shore, smoothed and wobbled a little so the bands aren't ruler-straight */
        const d0 = Math.max(0, (SH[k] * (1 - u) + SH[k + 1] * u) * (1 - v) + (SH[k + GW] * (1 - u) + SH[k + GW + 1] * u) * v), d = Math.max(0, d0 + (m1 - .5) * .05);
        if (shallows) { if (d < .14) col = SHALLOW[1]; else if (d < .34) col = SHALLOW[0]; }
        else if (depth) { const z = Math.min(1, d / 2.2), c1 = [148, 196, 196], c2 = [22, 52, 70]; col = mix(col, [c1[0] + (c2[0] - c1[0]) * Math.sqrt(z), c1[1] + (c2[1] - c1[1]) * Math.sqrt(z), c1[2] + (c2[2] - c1[2]) * Math.sqrt(z)], .9);
          const band = Math.floor(Math.sqrt(d / 2.2) * 6), bandL = Math.floor(Math.sqrt(Math.max(0, d - .012) / 2.2) * 6); if (band !== bandL && d < 2.2) col = mix(col, [230, 240, 240], .35); }
        else if (ripples) { if (d0 < .8) { const r = d0 / .12, f = r - Math.floor(r); if (f < .2) col = mix(col, [232, 242, 244], .85 * (1 - d0 / .8)); } }
        else if (hatch) { if (d < .42) { const sp = (wx - wy) * 22, f = sp - Math.floor(sp); if (f < .2 + .25 * (1 - d / .42) && (m2 > .35 || d < .15)) col = mix(col, [30, 52, 62], .55 * (1 - d / .42) + .15); } }
        else if (paper) { col = PAPERW; if (d0 < .55) { const r = d0 / .13, f = r - Math.floor(r); if (f < .18) col = mix(col, [60, 80, 90], .75 * (1 - d0 / .55)); } }
      }
      if (WET && t !== 5 && (shallows || depth || hatch || ripples) && t !== 8 && t !== 9) {
        const wt = (WET[k] * (1 - u) + WET[k + 1] * u) * (1 - v) + (WET[k + GW] * (1 - u) + WET[k + GW + 1] * u) * v;
        if (wt > .28) col = mix(col, SAND, Math.min(1, (wt - .28) / .18) * .8);
      }
      const edge = (leftT >= 0 && t !== leftT && (t === 5 || leftT === 5)) || (lastT[px] >= 0 && t !== lastT[px] && (t === 5 || lastT[px] === 5));
      if (edge) col = paper ? INK : WATER;
      buf[py * w + px] = col; leftT = t; lastT[px] = t;
    }
  }
}

/** Render a whole sheet at PPM pixels per mile. data: {seed, frame, slice, paint, lines, pins}. */
export function renderMap(data) {
  /* The land is built one mile past the frame on every side, so the drawn edge has neighbours to blend with. */
  const slice = makeSliceReader(data.slice), f = data.frame, land = buildLand({ seed: data.seed, frame: { x0: f.x0 - 1, x1: f.x1 + 1, y0: f.y0 - 1, y1: f.y1 + 1 }, slice, paint: data.paint, lines: data.lines, pins: data.pins });
  if (data.style) land.style = data.style;   /* art choices for rough country, see STYLE in story.mjs */
  const x0 = Math.floor(f.x0 / CELL) * CELL, x1 = Math.ceil(f.x1 / CELL) * CELL, y0 = Math.floor(f.y0 / CELL) * CELL, y1 = Math.ceil(f.y1 / CELL) * CELL, ppm = PPM, w = Math.round((x1 - x0) * ppm), h = Math.round((y1 - y0) * ppm);
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  const c = cv.getContext("2d"), img = c.createImageData(w, h);
  paintGround(land, new Uint32Array(img.data.buffer), w, h, { ppm, wx: px => x0 + px / ppm, wy: py => y1 - py / ppm }, false);
  c.putImageData(img, 0, 0);
  const sp = .25, K = sp * ppm / 22;
  makeStory(land).draw(c, { x0, x1, y0, y1, X: x => (x - x0) * ppm, Y: y => (y1 - y) * ppm }, sp, K, K);
  return { canvas: cv, w, h, x0, y0, x1, y1, fingerprint: landFingerprint(land, { x0, x1, y0, y1 }), lines: land.lines };
}
