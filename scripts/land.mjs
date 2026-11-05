/* Land generation from world position. The same code runs in the module and in the Survey Sheet, so the same
   seed, survey and paint give the same land in both. Coordinates are world miles from the world origin, x east,
   y north. Cells sit on one fixed lattice (CELL miles), so sheets that overlap agree exactly.
   Terrain codes: 0 fields, 1 open rough, 2 woods, 3 old growth, 4 low damp, 5 water, 6 hills, 7 bad ground. */
export const CELL = 0.125;
/* The height model, in feet. The ocean is 0 and everything is measured from it. Lowland climbs inland toward `inland`
   feet with a 1/e distance of `inlandMiles`, rolling by ±roll. Hills stand hillMin..hillMax over the lowland. Mountain rock
   stands mtnMin over the lowland at the edge of a range and up to mtnMax `massMiles` into it. Snow lies above the snowline. */
export const HEIGHTS = { inland: 1500, inlandMiles: 150, roll: 160, hillMin: 350, hillMax: 1250, mtnMin: 2000, mtnMax: 7000, massMiles: 10, snowline: 7000, polarMiles: 1150 };
/* Latitude: the snowline is `snowline` feet at the world origin (temperate with hard winters) and falls to the sea
   `polarMiles` north of it, where the world map's snow is cold ground rather than high ground; it rises the same way southward. */
export const snowlineAt = y => HEIGHTS.snowline * Math.max(0, Math.min(2, 1 - y / HEIGHTS.polarMiles));
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
    for (const r of runs.split(",")) { const [i, n, v] = r.split("*").map(Number); if (Number.isInteger(i) && n > 0 && n < 1e6 && v >= 0 && v <= 9) list.push([i, n, v]); }
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
  const terrain = new Uint8Array(gw * gh), elev = new Float32Array(gw * gh), base = new Float32Array(gw * gh), relief = new Float32Array(gw * gh), wet = new Float32Array(gw * gh), near = new Uint8Array(gw * gh), r = Math.ceil(.3 / CELL);
  const frac = slice.fracAt ? (c, x, y) => slice.fracAt(c, x, y) : (c, x, y) => (slice.classAt(x, y) === c ? 1 : 0);
  const seaAt = slice.seaAt ? (x, y) => slice.seaAt(x, y) : () => 60, massAt = slice.massAt ? (x, y) => slice.massAt(x, y) : () => 3;
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
      /* Height, in feet above the sea (see HEIGHTS). swell is the gentle 6-mile roll ordinary country always had;
         it still decides hollows and damp ground, so lowland terrain is unchanged by the height model. */
      const H = HEIGHTS, snowline = snowlineAt(y), cold = 1 - Math.min(1, snowline / H.snowline);                  /* 0 in temperate country, 1 where snow lies at sea level */
      const swell = fbm(x / 6, y / 6, 3, s + 11), mtn = Math.min(1, fr + fs * (1 - cold)), hill = fh * (1 - mtn);
      const knoll = fbm(x / 1.4, y / 1.4, 3, s + 91), rg = 1 - Math.abs(2 * fbm(x / 2.6, y / 2.6, 4, s + 81) - 1);
      const dsea = seaAt(wx, wy), mass = massAt(wx, wy);
      const b = H.inland * (1 - Math.exp(-dsea / H.inlandMiles));                                    /* lowland base: 0 at the shore, climbing inland */
      const roll = (swell - .5) * 2 * H.roll * Math.min(1, dsea / 4);                                 /* local rise and fall, flat right at the coast */
      const hillH = H.hillMin + (H.hillMax - H.hillMin) * knoll;                                      /* knolls over the base */
      const mtnH = H.mtnMin + (H.mtnMax - H.mtnMin) * Math.min(1, mass / H.massMiles) * (.35 + .65 * rg * rg); /* ridged, higher deep inside a wide range */
      let e = b + roll * (1 - mtn - hill) + hill * hillH + mtn * mtnH;
      /* snow lies above the snowline: in temperate country a lone snow mile is only a high crag and a field 3 miles across reaches
         the snowline; in the cold north the snowline is at the ground, so snow country is low rolling tundra */
      e += fs * Math.max(0, snowline * Math.min(1, (mass + 1) / 3) + (400 + 800 * rg) * (1 - cold) + 60 * cold - e);
      if (fw > .5) { terrain[k] = T.water; base[k] = b; relief[k] = swell; elev[k] = dsea < 1.5 ? 0 : b; wet[k] = fw; continue; }
      const lvl = dsea < 1.5 ? 0 : b;                                                                 /* shores run down to the water they touch */
      elev[k] = Math.max(1, lvl + (e - lvl) * Math.max(0, Math.min(1, 1 - 2 * fw))); base[k] = b; relief[k] = swell;
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
        if (swell < .32 || (near[k] && damp > .5)) t = T.damp; else if (age > .67) t = T.old; else t = T.woods;
      }
      terrain[k] = t;
    }
  }
  const rows = typeof paint === "string" ? decodePaint(paint) : paint;
  for (const [j, list] of rows) { const jj = j1 - 1 - j; if (jj < 0 || jj >= gh) continue; for (const [a, n, v] of list) for (let i = Math.max(a, i0); i < Math.min(a + n, i1); i++) terrain[jj * gw + i - i0] = v; }
  /* distance from shore across water, in miles (two-pass chamfer); land is 0. Water art reads depth bands and ripples from it. */
  const shore = new Float32Array(gw * gh), BIG = 1e6, d1 = CELL, d2 = CELL * Math.SQRT2;
  for (let k = 0; k < shore.length; k++) shore[k] = terrain[k] === T.water ? BIG : 0;
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) { const k = j * gw + i; if (!shore[k]) continue; let v = shore[k];
    if (i > 0) v = Math.min(v, shore[k - 1] + d1); if (j > 0) { v = Math.min(v, shore[k - gw] + d1); if (i > 0) v = Math.min(v, shore[k - gw - 1] + d2); if (i < gw - 1) v = Math.min(v, shore[k - gw + 1] + d2); } shore[k] = v; }
  for (let j = gh - 1; j >= 0; j--) for (let i = gw - 1; i >= 0; i--) { const k = j * gw + i; if (!shore[k]) continue; let v = shore[k];
    if (i < gw - 1) v = Math.min(v, shore[k + 1] + d1); if (j < gh - 1) { v = Math.min(v, shore[k + gw] + d1); if (i < gw - 1) v = Math.min(v, shore[k + gw + 1] + d2); if (i > 0) v = Math.min(v, shore[k + gw - 1] + d2); } shore[k] = v; }
  for (let k = 0; k < shore.length; k++) if (shore[k] >= BIG) shore[k] = 9;
  const idx = (x, y) => { const i = Math.floor(x / CELL) - i0, j = j1 - 1 - Math.floor(y / CELL); return (i < 0 || j < 0 || i >= gw || j >= gh) ? -1 : j * gw + i; };
  const land = {
    s, i0, j1, gw, gh, x0, x1, y0, y1, terrain, elev, base, relief, wet, shore, lines: courses, hasHeights: slice.hasHeights !== false,
    tAt: (x, y) => { const k = idx(x, y); return k < 0 ? T.rough : terrain[k]; },
    /** feet above the sea */
    elevAt: (x, y) => { const k = idx(x, y); return k < 0 ? 0 : elev[k]; },
    /** feet above the local lowland */
    riseAt: (x, y) => { const k = idx(x, y); return k < 0 ? 0 : elev[k] - base[k]; },
    /** the gentle lowland swell, 0..1, that decides hollows and ridges for the trees */
    reliefAt: (x, y) => { const k = idx(x, y); return k < 0 ? .5 : relief[k]; },
    wetAt: (x, y) => { const k = idx(x, y); return k < 0 ? 0 : wet[k]; },
    shoreAt: (x, y) => { const k = idx(x, y); return k < 0 ? 0 : shore[k]; },
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
