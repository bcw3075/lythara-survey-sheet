/* Land generation from world position. The same code runs in the module and in the Survey Sheet, so the same
   seed, survey and paint give the same land in both. Coordinates are world miles from the world origin, x east,
   y north. Cells sit on one fixed lattice (CELL miles), so sheets that overlap agree exactly.
   Terrain codes: 0 fields, 1 open rough, 2 woods, 3 old growth, 4 low damp, 5 water, 6 hills, 7 bad ground. */
export const CELL = 0.125;
export const T = { fields: 0, rough: 1, woods: 2, old: 3, damp: 4, water: 5, hills: 6, bad: 7, crag: 8, snow: 9 };

export function hash(ix, iy, s) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(s, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967296;
}
export function vnoise(x, y, s) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, s), b = hash(ix + 1, iy, s), c = hash(ix, iy + 1, s), d = hash(ix + 1, iy + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm(x, y, o, s) { let t = 0, a = .5, n = 0; for (let i = 0; i < o; i++) { t += a * vnoise(x, y, s + i * 17); n += a; x *= 2.03; y *= 2.03; a *= .5; } return t / n; }
export const ss = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export function strHash(str) { let h = 7; for (let i = 0; i < str.length; i++) h = (Math.imul(h, 31) + str.charCodeAt(i)) | 0; return h; }

/** Bend a line between its anchor points. Deterministic for a seed, so every sheet draws the same course. */
export function meander(pts, rough, depth, seed) {
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
const LINE_STYLE = { creek: [.2, 6], river: [.12, 6], road: [.06, 4], track: [.1, 4] };
export function lineCourse(line, seed) { const [rough, depth] = LINE_STYLE[line.kind] ?? LINE_STYLE.track; return meander(line.pts, rough, depth, (seed | 0) + strHash(line.id)); }

/* Paint is kept world-wide and sparse: "j:i*len*v,i*len*v;j:..." where i, j are lattice cells and v a terrain code. */
export function decodePaint(text) {
  const rows = new Map();
  if (!text) return rows;
  for (const row of text.split(";")) {
    if (!row) continue;
    const [j, runs] = row.split(":"); const list = [];
    for (const r of runs.split(",")) { const [i, n, v] = r.split("*").map(Number); if (Number.isInteger(i) && n > 0 && n < 1e6 && v >= 0 && v <= 7) list.push([i, n, v]); }
    if (list.length) rows.set(+j, list);
  }
  return rows;
}
export function encodePaint(rows) {
  const out = [];
  for (const j of [...rows.keys()].sort((a, b) => a - b)) { const list = rows.get(j); if (list.length) out.push(j + ":" + list.map(r => r.join("*")).join(",")); }
  return out.join(";");
}
/** Set one lattice cell in a sparse paint map (v = -1 clears it). */
export function paintSet(rows, i, j, v) {
  const list = rows.get(j) ?? [];
  const cells = new Map(); for (const [a, n, val] of list) for (let k = 0; k < n; k++) cells.set(a + k, val);
  if (v < 0) cells.delete(i); else cells.set(i, v);
  const keys = [...cells.keys()].sort((a, b) => a - b), runs = [];
  for (const k of keys) { const last = runs[runs.length - 1]; if (last && last[0] + last[1] === k && last[2] === cells.get(k)) last[1]++; else runs.push([k, 1, cells.get(k)]); }
  if (runs.length) rows.set(j, runs); else rows.delete(j);
}

/** Build the land of a frame. slice: survey slice reader (openAt, classAt). lines: [{id, kind, pts}]. pins: [{kind, x, y, home}]. */
export function buildLand({ seed = 1147, frame, slice, paint = "", lines = [], pins = [] }) {
  const s = seed | 0, i0 = Math.floor(frame.x0 / CELL), i1 = Math.ceil(frame.x1 / CELL), j0 = Math.floor(frame.y0 / CELL), j1 = Math.ceil(frame.y1 / CELL);
  const gw = i1 - i0, gh = j1 - j0, x0 = i0 * CELL, x1 = i1 * CELL, y0 = j0 * CELL, y1 = j1 * CELL;
  const terrain = new Uint8Array(gw * gh), elev = new Float32Array(gw * gh), wet = new Float32Array(gw * gh), near = new Uint8Array(gw * gh), r = Math.ceil(.3 / CELL);
  const frac = slice.fracAt ? (c, x, y) => slice.fracAt(c, x, y) : (c, x, y) => (slice.classAt(x, y) === c ? 1 : 0);
  const courses = lines.map(l => ({ ...l, course: lineCourse(l, s) }));
  for (const l of courses) if (l.kind === "creek" || l.kind === "river") for (const p of l.course) {
    const ci = Math.floor(p.x / CELL) - i0, cj = j1 - 1 - Math.floor(p.y / CELL);
    for (let j = cj - r; j <= cj + r; j++) for (let i = ci - r; i <= ci + r; i++) if (i >= 0 && j >= 0 && i < gw && j < gh && (i - ci) ** 2 + (j - cj) ** 2 <= r * r) near[j * gw + i] = 1;
  }
  const villages = pins.filter(p => p.kind === "village");
  for (let j = 0; j < gh; j++) {
    const y = (j1 - j - .5) * CELL;
    for (let i = 0; i < gw; i++) {
      const x = (i0 + i + .5) * CELL, k = j * gw + i;
      const wx = x + (fbm(x / 1.7, y / 1.7, 2, s + 21) - .5) * 1.5, wy = y + (fbm(x / 1.7, y / 1.7, 2, s + 27) - .5) * 1.5;
      /* the survey's mile squares become soft shapes: each class is read as a share of the ground, warped by noise, and wins past a half */
      const fw = frac(2, wx, wy), fr = frac(3, wx, wy), fs = frac(4, wx, wy), fh = frac(5, wx, wy);
      wet[k] = fw;
      /* higher ground where the map shows rock, snow and hills, so the shading and the trees follow it */
      const e = fbm(x / 6, y / 6, 3, s + 11) * (1 - .55 * (fr + fs + .6 * fh)) + .25 * fh + .45 * fr + .55 * fs; elev[k] = Math.min(1, e);
      if (fw > .5) { terrain[k] = T.water; continue; }
      if (fs > .5) { terrain[k] = T.snow; continue; }
      if (fr > .5 || fr + fs > .62) { terrain[k] = T.crag; continue; }
      let o = slice.openAt(wx, wy), fieldsNear = false;
      const cls = fh > .5 ? 5 : slice.classAt(x, y);
      for (const v of villages) {
        const dx = wx - v.x, dy = wy - v.y;
        if (v.home) {
          /* the home village: the notes put the tree line just north of it, which overrides the painted edge */
          o -= ss(.05, .6, dy) * ss(17, 10, Math.abs(dx)) * 1.15;
          o += ss(1.1, .15, Math.hypot(x - v.x, (y - v.y) > 0 ? (y - v.y) * 2.6 : (y - v.y) * .8)) * 1.3;
        } else o += ss(1.4, .25, Math.hypot(x - v.x, y - v.y)) * 1.3;
        if (Math.hypot(x - v.x, y - v.y) < 9) fieldsNear = true;
      }
      let t;
      if (cls === 5 && o > .5) t = T.hills;
      else if (fh > .5 && o <= .5) { t = fbm(x / 2.2, y / 2.2, 2, s + 71) > .45 ? T.woods : T.hills; }
      else if (o > .5) {
        t = T.rough;
        if (fieldsNear) { const n = fbm(x / .9, y / .9, 2, s + 31); let D = 99; for (const v of villages) D = Math.min(D, Math.hypot(x - v.x, y - v.y)); if ((D < 3 + 3 * n && n > .36) || (D < 9 && n > .63)) t = T.fields; }
      } else {
        const age = fbm(x / 2.6, y / 2.6, 3, s + 41) + .016 * Math.min(60, villages.reduce((m, v) => Math.min(m, Math.hypot(x - v.x, y - v.y)), 60)), damp = fbm(x / 1.1, y / 1.1, 2, s + 51);
        if (e < .32 || (near[k] && damp > .5)) t = T.damp; else if (age > .67) t = T.old; else t = T.woods;
      }
      terrain[k] = t;
    }
  }
  const rows = typeof paint === "string" ? decodePaint(paint) : paint;
  for (const [j, list] of rows) { const jj = j1 - 1 - j; if (jj < 0 || jj >= gh) continue; for (const [a, n, v] of list) for (let i = Math.max(a, i0); i < Math.min(a + n, i1); i++) terrain[jj * gw + i - i0] = v; }
  const idx = (x, y) => { const i = Math.floor(x / CELL) - i0, j = j1 - 1 - Math.floor(y / CELL); return (i < 0 || j < 0 || i >= gw || j >= gh) ? -1 : j * gw + i; };
  const land = {
    s, i0, j1, gw, gh, x0, x1, y0, y1, terrain, elev, wet, lines: courses,
    tAt: (x, y) => { const k = idx(x, y); return k < 0 ? T.rough : terrain[k]; },
    elevAt: (x, y) => { const k = idx(x, y); return k < 0 ? .5 : elev[k]; },
    wetAt: (x, y) => { const k = idx(x, y); return k < 0 ? 0 : wet[k]; },
    waterPoints: courses.filter(l => l.kind === "creek" || l.kind === "river").flatMap(l => l.course)
  };
  land.fingerprint = landFingerprint(land);
  return land;
}

/** Fingerprint of a frame's land, to confirm the module and the sheet agree. */
export function landFingerprint(land, frame = land) {
  let hv = 0;
  for (let y = frame.y0 + .25; y < frame.y1; y += .5) for (let x = frame.x0 + .25; x < frame.x1; x += .5) hv = (hv * 31 + land.tAt(x, y)) | 0;
  return hv;
}
