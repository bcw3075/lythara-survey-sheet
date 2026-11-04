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
  const style = { ...STYLE, ...(land.style ?? {}) }, relief = style.hills === "relief" || style.hills === "both", shallows = style.water === "shallows";
  const SHALLOW = [u32(104, 152, 160), u32(130, 172, 172)], SAND = h2("#d9cba0");
  const mix = (col, c2, a) => u32(cl((col & 255) * (1 - a) + c2[0] * a), cl(((col >> 8) & 255) * (1 - a) + c2[1] * a), cl(((col >> 16) & 255) * (1 - a) + c2[2] * a));
  const T = land.terrain, E = land.elev, WET = land.wet, GW = land.gw, GH = land.gh, inv = 1 / CELL, lastT = new Int16Array(w + 1).fill(-1), fine = V.ppm > 70;
  if (!land.shade) { const S = land.shade = new Float32Array(GW * GH); for (let j = 1; j < GH - 1; j++) for (let i = 1; i < GW - 1; i++) { const k = j * GW + i; S[k] = (E[k + 1] - E[k - 1] + E[k + GW] - E[k - GW]) * 115; } }
  const shade = land.shade;
  for (let py = 0; py < h; py++) {
    const wy = V.wy(py + .5); let leftT = -1;
    for (let px = 0; px < w; px++) {
      const wx = V.wx(px + .5), a1 = (wx * 5.1 * 25.6) | 0, b1 = (wy * 5.1 * 25.6) | 0, n1 = TBL[(b1 & 255) << 8 | (a1 & 255)], a2 = (wy * 4.3 * 25.6 + 71) | 0, b2 = (wx * 4.3 * 25.6 + 13) | 0, n2 = TBL[(b2 & 255) << 8 | (a2 & 255)];
      let dx = (n1 - .5) * .34, dy = (n2 - .5) * .34;
      if (fine) { const a3 = (wx * 61) | 0, b3 = (wy * 61) | 0, n3 = TBL[(b3 & 255) << 8 | (a3 & 255)]; dx += (n3 - .5) * .05; dy += (n1 - .5) * .03 + (n3 - .5) * .03; }
      const fi = (wx + dx) * inv - land.i0, fj = land.j1 - (wy + dy) * inv, i = Math.floor(fi), j = Math.floor(fj);
      if (i < 1 || j < 1 || i >= GW - 2 || j >= GH - 2) { buf[py * w + px] = PAPER; leftT = -1; lastT[px] = -1; continue; }
      const k = j * GW + i, t = T[k], u = fi - i, v = fj - j, a4 = (wx * 23) | 0, b4 = (wy * 23) | 0, m1 = TBL[(b4 & 255) << 8 | (a4 & 255)], a5 = (wx * 83) | 0, b5 = (wy * 83) | 0, m2 = TBL[(b5 & 255) << 8 | (a5 & 255)];
      const hs = (shade[k] * (1 - u) + shade[k + 1] * u) * (1 - v) + (shade[k + GW] * (1 - u) + shade[k + GW + 1] * u) * v;
      const rough = t === 6 || t === 8 || t === 9, hs2 = rough ? hs * 2.4 : hs;
      let col = PAL[t * 16 + Math.max(0, Math.min(15, (7.5 + hs2 + (m1 - .5) * 5 + (m2 - .5) * 2.4) | 0))];
      if ((contours && t !== 5) || (relief && rough)) { const e = (E[k] * (1 - u) + E[k + 1] * u) * (1 - v) + (E[k + GW] * (1 - u) + E[k + GW + 1] * u) * v, q = rough ? 22 : 34; if (((e * q) | 0) !== ((E[k] * q) | 0)) col = (col & 0xff000000) | ((col >> 1) & 0x7f7f7f); }
      if (shallows && WET) {
        const wt = (WET[k] * (1 - u) + WET[k + 1] * u) * (1 - v) + (WET[k + GW] * (1 - u) + WET[k + GW + 1] * u) * v;
        if (t === 5) { if (wt < .6) col = SHALLOW[1]; else if (wt < .72) col = SHALLOW[0]; }
        else if (wt > .28 && t !== 8 && t !== 9) col = mix(col, SAND, Math.min(1, (wt - .28) / .18) * .8);
      }
      if ((leftT >= 0 && t !== leftT && (t === 5 || leftT === 5)) || (lastT[px] >= 0 && t !== lastT[px] && (t === 5 || lastT[px] === 5))) col = WATER;
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
