/* Encounter maps: the land at 5-ft squares, read from the same world as the sheets.
   Everything is placed on fixed world lattices (feet from the world origin), so the same spot always gives the same map,
   and a map that grows keeps everything already on it. Coordinates: world miles (x east, y north) as everywhere else;
   inside this file, local feet from the map's top-left corner (u east, v south). */
import { CELL, T, buildLand, hash, fbm, meander, snowlineAt } from "./land.mjs";
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
/* Tuning sliders, each -1..1 with 0 meaning "the land as it is": trees (cover), brush (undergrowth), rocks, water (width),
   relief (how hilly the ground is), decay (dead trees, grey grass, more deadfall). Same spot and same sliders, same map. */
/* Season at a spot. f = fraction of the year since the coldest day (0..1, from the calendar). How warm a spot is comes from
   how far it sits below the permanent snowline, which already folds in latitude and height. T is a rough "warmth" now:
   below ~.1 snow lies; leaves come out between .35 and .65 while warming and colour then fall between .78 and .5 while
   cooling. The origin's lowland (w ≈ .94) gets light snow in deep winter and leaves out in late spring. */
export function seasonState(f, elev, y) {
  const w = Math.max(-.5, Math.min(1.3, (snowlineAt(y) - elev) / 7000)), a = 2 * Math.PI * f;
  const T = w - .55 * Math.cos(a) - .35, rising = Math.sin(a) > 0;
  return { f, w, T, rising, leaf: leafAt(T, rising), autumn: autAt(T, rising), snow: sm(.15, -.05, T), fresh: rising ? sm(.4, .7, T) * (1 - sm(.85, 1.05, T)) : 0, dormant: sm(.55, .3, T) };
}
/* leaves come out between warmth .35 and .65 while warming; while cooling they colour from 1.05 down to .75 and fall between .6 and .4 */
const leafAt = (T, rising) => rising ? sm(.35, .65, T) : sm(.4, .6, T), autAt = (T, rising) => rising ? 0 : sm(1.05, .75, T);
export const SUMMER = { f: .5, w: 1, T: 1.2, rising: false, leaf: 1, autumn: 0, snow: 0, fresh: 0, dormant: 0 };
const EVERGREEN = new Set(["pine", "hemlock"]), OPEN_FEATS = ["clearing", "camp", "stones", "ruins", "cave", "outcrop", "lake", "pond"], BUILT = ["camp", "stones", "ruins", "cave", "outcrop", "fallen"];
/* ---------- placed features, from plain-language notes ----------
   "a pond in the north-east, a stand of dead trees, and a cave entrance on the west side". Each part is matched to a known
   feature and an optional place on the map; anything not recognised is returned so it can be passed to Claude. */
export const FEATURES = {
  lake: { r: 55, words: /\blakes?\b|\bmere\b|\bloch\b/ }, pond: { r: 24, words: /\bponds?\b|\bpools?\b|\btarns?\b|\bspring\b/ },
  stream: { r: 0, words: /\bstreams?\b|\bbrooks?\b|\bcreeks?\b|\brivulet\b|\bbeck\b/ },
  fallen: { r: 0, words: /\bfallen\b|\btoppled\b|\bgiant log\b|\bdowned tree\b|\bdeadfall\b/ },
  dead: { r: 42, words: /\bdead\b|\bsnags?\b|\bblight(ed)?\b|\bdying\b|\bwithered\b|\brotten\b/ },
  clearing: { r: 38, words: /\bclearing\b|\bglade\b|\bmeadow\b|\bopen ground\b/ },
  cave: { r: 26, words: /\bcaves?\b|\bcavern\b|\bden\b|\btunnel\b|\bgrotto\b|\bmine entrance\b/ },
  stones: { r: 28, words: /\bstanding stones?\b|\bstone circle\b|\bmenhirs?\b|\bmonoliths?\b|\bcairns?\b|\bdolmen\b/ },
  ruins: { r: 30, words: /\bruins?\b|\bruined\b|\bfoundations?\b|\bcrumbling\b|\bold walls?\b|\bwatchtower\b/ },
  camp: { r: 22, words: /\bcamp(site|fire)?\b|\bfire ?pit\b|\bbonfire\b/ },
  outcrop: { r: 20, words: /\boutcrop\b|\bcrag\b|\btor\b|\brock face\b|\bcliff\b|\bledge\b/ },
  boulders: { r: 32, words: /\bboulders?\b|\brock field\b|\bscree\b|\brocks\b|\bstones\b/ }
};
const PLACE_WORDS = [[/north[ -]?east|\bne\b/, [.78, .22]], [/north[ -]?west|\bnw\b/, [.22, .22]], [/south[ -]?east|\bse\b/, [.78, .78]], [/south[ -]?west|\bsw\b/, [.22, .78]],
  [/\bnorth/, [.5, .2]], [/\bsouth/, [.5, .8]], [/\beast/, [.8, .5]], [/\bwest/, [.2, .5]], [/\bcent(er|re)\b|\bmiddle\b/, [.5, .5]]];
const SPOTS = [[.3, .3], [.7, .7], [.7, .3], [.3, .7], [.5, .22], [.22, .5], [.78, .5], [.5, .78]];
const FACING = [[/facing north|opens? north|north[- ]facing/, -Math.PI / 2], [/facing south|opens? south|south[- ]facing/, Math.PI / 2], [/facing east|opens? east|east[- ]facing/, 0], [/facing west|opens? west|west[- ]facing/, Math.PI]];
/** Read notes into features placed by map fraction (fx east, fy south, 0..1). Returns { features, unknown }. */
export function parseNotes(text) {
  const parts = String(text ?? "").toLowerCase().split(/[;,\n]|\band\b|\bplus\b|\balso\b|\bwith\b/).map(t => t.trim()).filter(t => t.length > 1);
  const features = [], unknown = []; let spot = 0;
  for (const part of parts) {
    const kind = Object.keys(FEATURES).find(k => FEATURES[k].words.test(part));
    if (!kind) { unknown.push(part); continue; }
    const place = PLACE_WORDS.find(([re]) => re.test(part.replace(/facing \w+|opens? \w+|\w+[- ]facing/, "")));
    let [fx, fy] = place ? place[1] : SPOTS[spot++ % SPOTS.length];
    if (/\bedge\b|\bborder\b|\bfar\b/.test(part) && place) { fx = .5 + (fx - .5) * 1.5; fy = .5 + (fy - .5) * 1.5; }
    const size = /\bsmall\b|\blittle\b|\btiny\b/.test(part) ? .65 : /\bhuge\b|\bgiant\b|\bvast\b|\benormous\b/.test(part) && kind !== "fallen" ? 1.8 : /\blarge\b|\bbig\b|\bwide\b/.test(part) ? 1.4 : 1;
    const face = FACING.find(([re]) => re.test(part));
    const ang = face ? face[1] : /north[- ]?south|n-s|running north|running south/.test(part) ? Math.PI / 2 : /east[- ]?west|e-w|running east|running west/.test(part) ? 0 : null;
    features.push({ kind, fx: Math.max(.05, Math.min(.95, fx)), fy: Math.max(.05, Math.min(.95, fy)), size, ang, text: part });
  }
  return { features, unknown };
}
export const TUNE_KEYS = ["trees", "brush", "rocks", "water", "relief", "decay"];
const tuneOf = t => Object.fromEntries(TUNE_KEYS.map(k => [k, Math.max(-1, Math.min(1, Number(t?.[k]) || 0))]));
/* a chance p pushed up toward 1 or down toward 0 by a slider; open ground gains a little cover too when pushed up */
const nudge = (p, k, open = 0) => k >= 0 ? Math.min(1, p + (1 - p) * k * .85 + open * k) : p * (1 + k);
export function planEncounter(data, { cx, cy, cols = 40, rows = 40, tune, yearFrac, features, cover }) {
  tune = tuneOf(tune);
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
    dx += ((fbm(fx / 60, fy / 60, 3, s + 301) - .5) * 70 + (fbm(fx / 16, fy / 16, 3, s + 303) - .5) * 34 + (fbm(fx / 5, fy / 5, 2, s + 305) - .5) * 8) / FT_PER_MI; dy += ((fbm(fx / 60, fy / 60, 3, s + 307) - .5) * 70 + (fbm(fx / 16, fy / 16, 3, s + 309) - .5) * 34 + (fbm(fx / 5, fy / 5, 2, s + 311) - .5) * 8) / FT_PER_MI;
    const i = Math.floor((wx + dx) * inv) - land.i0, j = Math.floor(land.j1 - (wy + dy) * inv);
    if (i < 0 || j < 0 || i >= GW || j >= GH) return T.rough;
    return T_[j * GW + i];
  }
  /* where the sheet picture shows tree crowns (0..1, smoothed), so a click on the tree line gets the tree line */
  const coverAt = !cover?.b ? () => 0 : (wx, wy) => { const fi = (wx - cover.x0) * cover.ppm - .5, fj = (cover.y1 - wy) * cover.ppm - .5, i = Math.floor(fi), j = Math.floor(fj), n = cover.n;
    const at = (a, b) => a < 0 || b < 0 || a >= n || b >= n ? 0 : +(cover.b[b * n + a] === "1"), u = fi - i, v = fj - j;
    return (at(i, j) * (1 - u) + at(i + 1, j) * u) * (1 - v) + (at(i, j + 1) * (1 - u) + at(i + 1, j + 1) * u) * v; };
  /* rough going (the Undergrowth slider beyond the woods): what slows you down on this ground, in patches. Deep drifts on snow,
     sucking mud on damp ground, loose scree on crag and stony hills. 0..1 at a world foot; the same field is drawn and costed. */
  const GOING = t => t === T.snow ? "drift" : t === T.damp ? "mud" : t === T.crag || t === T.bad ? "scree" : t === T.hills || t === T.rough ? "stony" : null;
  const goingF = (gx, gy, t) => { const k = GOING(t); if (!k) return 0;
    const th = (k === "stony" ? .8 : .66) - tune.brush * .24, n = tbl(gx * .62 + 71, gy * .62 + 19) * .8 + tbl(gx * 2.3 + 5, gy * 2.3 + 44) * .2;   /* tbl features are ~23 units across: patches ~35 ft */
    return sm(th, th + .1, n); };
  const goingAt = (u, v) => { const w = W(u, v), t = terrainAt(w.x, w.y); return { kind: GOING(t), g: goingF(w.x * FT_PER_MI, w.y * FT_PER_MI, t) }; };
  /* height in feet: the land model, plus small hummocks */
  const relief = tune.relief >= 0 ? 1 + tune.relief * 4 : 1 + tune.relief * .9;   /* x5 at the top, flattened to a tenth at the bottom */
  /* bicubic (Catmull-Rom) through the land's height grid: bilinear has a crease at every cell edge, which the slope shading
     showed as a straight light/dark line across the map */
  const cr = (p0, p1, p2, p3, t) => p1 + .5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  const Eat = (i, j) => E[Math.max(0, Math.min(GH - 1, j)) * GW + Math.max(0, Math.min(GW - 1, i))];
  const baseElev = (wx, wy) => { const fi = wx * inv - land.i0 - .5, fj = land.j1 - wy * inv - .5, i = Math.floor(fi), j = Math.floor(fj); if (i < 0 || j < 0 || i >= GW - 1 || j >= GH - 1) return 0;
    const u = fi - i, v = fj - j, row = jj => cr(Eat(i - 1, jj), Eat(i, jj), Eat(i + 1, jj), Eat(i + 2, jj), u);
    return cr(row(j - 1), row(j), row(j + 1), row(j + 2), v); };
  const e0 = baseElev(cx, cy), season = Number.isFinite(yearFrac) ? seasonState(((yearFrac % 1) + 1) % 1, e0, cy) : SUMMER;
  const elevAt = (wx, wy) => { const fx = wx * FT_PER_MI, fy = wy * FT_PER_MI;
    /* rises, hollows and a ridged spine (feet), only when relief is turned up: knolls ~120 ft across, up to ~25 ft high */
    const n1 = fbm(fx / 120, fy / 120, 3, s + 351), n2 = fbm(fx / 40, fy / 40, 2, s + 353), ridge = 1 - Math.abs(fbm(fx / 200, fy / 200, 2, s + 355) * 2 - 1);
    const hum = (n1 - .5) * 130 + (n2 - .5) * 26 + (ridge - .6) * 40;   /* fbm sits near .5, so these give roughly ±20 ft */
    return e0 + (baseElev(wx, wy) - e0) * Math.min(1, relief) + hum * Math.max(0, tune.relief); };   /* up: adds rises and hollows; down: flattens */
  /* lines that pass near the map, bent a little more at close range */
  const pad = 60, lines = [];
  for (const l of land.lines) {
    const pts = l.course.map(p => L(p.x, p.y)), near = pts.some((p, i) => i && segBoxDist(pts[i - 1], p, -pad, -pad, Wft + pad, Hft + pad) <= 0);
    if (!near) continue;
    const road_ = l.kind === "road" || l.kind === "track";
    /* the sheet draws l.course itself, so stay on it: only gentle extra bends (at most ~40 ft off), corners rounded below, the close wobble in waterAt */
    let fine = meander(l.course, road_ ? .015 : .03, 3, s + 900 + l.id.length).map(p => L(p.x, p.y));
    /* round the corners (Chaikin, twice), only on the stretch within ~800 ft: no new bends, so the creek stays where the sheet draws it */
    const nearSeg = (a, i, m) => (i > 0 && segBoxDist(a[i - 1], a[i], -m, -m, Wft + m, Hft + m) <= 0) || (i < a.length - 1 && segBoxDist(a[i], a[i + 1], -m, -m, Wft + m, Hft + m) <= 0);
    fine = fine.filter((p, i, a) => nearSeg(a, i, 800));
    if (!road_) for (let k = 0; k < 2 && fine.length > 2; k++) { const n = [fine[0]]; for (let i = 1; i < fine.length; i++) { const a = fine[i - 1], c = fine[i]; n.push({ u: a.u * .75 + c.u * .25, v: a.v * .75 + c.v * .25 }, { u: a.u * .25 + c.u * .75, v: a.v * .25 + c.v * .75 }); } n.push(fine[fine.length - 1]); fine = n; }
    lines.push({ id: l.id, kind: l.kind, pts: fine.filter((p, i, a) => nearSeg(a, i, 400)) });
  }
  /* placed features: world miles and feet, so they stay put when the map grows */
  const FT = (features ?? []).map((f, i) => { const p = L(f.x, f.y), def = FEATURES[f.kind] ?? { r: 20 }; return { ...f, i, u: p.u, v: p.v, r: (f.r ?? def.r) * (f.size ?? 1) }; });
  /* distance from a feature in its own radii: water gets a lobed, irregular shoreline (a few bays and points), the rest a light wobble */
  const fdist = (f, u, v) => { const n = fbm((x0 * FT_PER_MI + u) / 22, (y1 * FT_PER_MI - v) / 22, 2, s + 700 + f.i * 13), du = u - f.u, dv = v - f.v;
    if (f.kind !== "lake" && f.kind !== "pond") return Math.hypot(du, dv) / (f.r * (.78 + n * .44));
    const a = Math.atan2(dv, du), h = k => hash(f.i, k, s + 731) * 6.283, lob = 1 + .16 * Math.sin(2 * a + h(1)) + .11 * Math.sin(3 * a + h(2)) + .07 * Math.sin(5 * a + h(3)) + .04 * Math.sin(8 * a + h(4));
    return Math.hypot(du, dv) / (f.r * lob * (.62 + n * .76)); };
  const inF = (kinds, u, v, k = 1) => FT.some(f => kinds.includes(f.kind) && f.r > 0 && fdist(f, u, v) < k);
  for (const f of FT) if (f.kind === "stream") {   /* a stream across the whole map through the spot */
    const a = f.ang ?? (hash(f.i, 3, s + 711) * Math.PI), L0 = Math.max(Wft, Hft) * 1.2, pts = [];
    for (let k = -6; k <= 6; k++) { const d = k / 6 * L0; pts.push(W(f.u + Math.cos(a) * d, f.v + Math.sin(a) * d)); }
    lines.push({ id: `feat-stream-${f.i}`, kind: "creek", pts: meander(pts, .16, 3, s + 720 + f.i).map(p => L(p.x, p.y)) });
  }
  const water = lines.filter(l => l.kind === "creek" || l.kind === "river"), roads = lines.filter(l => l.kind === "road" || l.kind === "track");
  const wMul = 2 ** tune.water, halfWidth = (l, u, v) => { const n = fbm((x0 * FT_PER_MI + u) / 55, (y1 * FT_PER_MI - v) / 55, 3, s + 333); return (l.kind === "river" ? 14 + 10 * n : 2.5 + 6 * n * n) * wMul; };
  /* close-range wander: the line is read through a slow warp, so creeks and tracks bend every few dozen feet */
  const wob = (u, v, amp, sc, k) => { const gx = x0 * FT_PER_MI + u, gy = y1 * FT_PER_MI - v; return [u + (fbm(gx / sc, gy / sc, 3, s + k) - .5) * 2 * amp, v + (fbm(gx / sc, gy / sc, 3, s + k + 5) - .5) * 2 * amp]; };
  const lineDist = (l, u, v) => { let best = 1e9; for (let i = 1; i < l.pts.length; i++) best = Math.min(best, segDist(u, v, l.pts[i - 1], l.pts[i])); return best; };
  /* water depth signal: <0 dry; 0..1 shallow edge to channel */
  function waterAt(u, v) { let w = -1; const [a, b] = wob(u, v, 9, 70, 351); for (const l of water) { const hw = halfWidth(l, u, v), d = lineDist(l, a, b); w = Math.max(w, 1 - d / hw); }
    for (const f of FT) if (f.kind === "lake" || f.kind === "pond") w = Math.max(w, (1 - fdist(f, u, v)) * (f.kind === "lake" ? 1.3 : .95) * Math.max(.4, f.size ?? 1) ** .3);
    /* damp ground holds standing water in its hollows: a few small pools as the land is, many and wide with Water turned up, none turned down */
    if (w < .9 && tune.water > -1) { const gx = x0 * FT_PER_MI + u, gy = y1 * FT_PER_MI - v, wp = W(u, v);
      if (terrainAt(wp.x, wp.y) === T.damp) { const n = tbl(gx * .5 + 13, gy * .5 + 91) * .8 + tbl(gx * 1.9 + 3, gy * 1.9 + 7) * .2, th = .77 - tune.water * .12;
        w = Math.max(w, n > th ? .02 + .6 * sm(0, 1, (n - th) / .1) : Math.max(-1, (n - th) / .04)); } }   /* shallow: wading, not swimming */
    return w; }
  /* built features step off water: the nearest dry spot within ~150 ft of where they were asked for */
  const placedB = [];
  for (const f of FT) if (BUILT.includes(f.kind)) {
    const crowd = (u, v) => placedB.some(g => Math.hypot(u - g.u, v - g.v) < (f.r + g.r) * .9 + 6);
    const wet = (u, v) => crowd(u, v) || [[0, 0], ...[...Array(8)].map((_, k) => [Math.cos(k * .785) * f.r * .8, Math.sin(k * .785) * f.r * .8])].some(([a, b]) => waterAt(u + a, v + b) > -.35);
    if (!wet(f.u, f.v)) { placedB.push(f); continue; }
    search: for (let d = 15; d <= 150; d += 15) for (let k = 0; k < 12; k++) { const a = k / 12 * 6.283 + d * .1, u = f.u + Math.cos(a) * d, v = f.v + Math.sin(a) * d; if (u < 10 || v < 10 || u > Wft - 10 || v > Hft - 10) continue; if (!wet(u, v)) { f.u = u; f.v = v; break search; } }
    placedB.push(f);
  }
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
  function edgeTree(wx, wy, u, v, r3, r4, gx, gy, t, cv) {
    const lush = Math.max(0, -(tune.decay ?? 0)), cold = t === T.snow || t === T.crag || t === T.bad;
    if (r3 >= nudge(.62 * Math.min(1, (cv - .35) / .45), tune.trees, 0) * (1 + lush * .12)) return;
    let sp = cold ? null : story.speciesAt(wx, wy, T.woods);
    if (!sp) sp = r4 < .7 ? { kind: "pine", col: PAL.pine[(r4 * 4 | 0) % 3] } : { kind: "hemlock", col: PAL.hemlock[(r4 * 7 | 0) % 3] };   /* the high tree line is evergreen */
    const [rMin, rMax, tr] = SPECIES[sp.kind] ?? SPECIES.pine, R = (rMin + (rMax - rMin) * r4) * (cold ? .85 : .95) * (1 + lush * .22);
    if (!clearOf(u, v, Math.max(2, tr * 2)) || inF(OPEN_FEATS, u, v, 1.1 + R / 22)) return;
    const dz0 = tune.decay ?? 0, dead = hash(gx, gy, s + 517) < (dz0 >= 0 ? .02 + dz0 * .7 : .02 * (1 + dz0)) || inF(["dead"], u, v) && hash(gx, gy, s + 523) < .85;
    const j = (hash(gx, gy, s + 519) - .5) * .16, Tt = season.T + j, ever = EVERGREEN.has(sp.kind);
    feats.trees.push({ u, v, R, trunk: tr * (.8 + r4 * .5), kind: sp.kind, col: sp.col, seed: r3 * 997 + r4, dead, leaf: ever ? 1 : leafAt(Tt, season.rising), aut: ever ? 0 : autAt(Tt, season.rising), hue: (hash(gx, gy, s + 521) * 4) | 0, edge: true });
  }
  /* trees: one chance per 18-ft square of the world */
  lattice(18, 501, (wx, wy, u, v, r3, r4, gx, gy) => {
    const t = terrainAt(wx, wy), fx_ = wx * FT_PER_MI, fy_ = wy * FT_PER_MI;
    /* the sheet draws crowns here though the ground isn't forest: a ragged tree line, trees standing in rough ground or snow */
    const cv = forest(t) || t === T.water ? 0 : coverAt(wx + (fbm(fx_ / 40, fy_ / 40, 2, s + 531) - .5) * .004, wy + (fbm(fx_ / 40, fy_ / 40, 2, s + 533) - .5) * .004);
    if (cv > .35) return edgeTree(wx, wy, u, v, r3, r4, gx, gy, t, cv);
    const p0 = t === T.old ? .72 : t === T.woods ? .78 : t === T.damp ? .5 : t === T.rough ? .035 : t === T.hills ? .05 : t === T.fields ? .006 : 0;
    const lush = Math.max(0, -(tune.decay ?? 0)), p = t === T.snow || t === T.crag ? p0 : nudge(p0, tune.trees, t === T.fields || t === T.rough || t === T.hills ? .25 : 0) * (1 + lush * (forest(t) ? .12 : .8));
    if (r3 >= p) {   /* thinned woods: about half the trees taken out leave a stump */
      if (forest(t) && r3 < p0 && hash(gx, gy, s + 527) < .5 && clearOf(u, v, 3)) (feats.stumps ??= []).push({ u, v, r: 1 + r4 * 1.1, seed: r4 });
      return; }
    let sp = story.speciesAt(wx, wy, t);
    for (let k = 1; !sp && forest(t) && k < 6; k++) sp = story.speciesAt(wx + k * .004, wy - k * .003, t);
    const stray = !sp;   /* the land names no tree here (extra trees from the sliders): it takes after its neighbours below */
    if (!sp) sp = { kind: t === T.damp ? "willow" : "oakS", col: (t === T.damp ? PAL.willow : PAL.oak)[(r4 * 3) | 0] };
    const [rMin, rMax, tr] = SPECIES[sp.kind] ?? SPECIES.oak, R = (rMin + (rMax - rMin) * r4) * (forest(t) ? 1.02 : .8) * (1 + lush * .22);   /* lush: fuller crowns */
    if (!clearOf(u, v, Math.max(2, tr * 2)) || inF(OPEN_FEATS, u, v, 1.1 + R / 22)) return;   /* crowns stay out of open features */
    const dz0 = tune.decay ?? 0, snag = forest(t) ? (t === T.old ? .035 : .015) : 0;   /* the land as it is keeps a few natural snags; healthy clears them */
    const dead = hash(gx, gy, s + 517) < (dz0 >= 0 ? snag + dz0 * .7 : snag * (1 + dz0)) || inF(["dead"], u, v) && hash(gx, gy, s + 523) < .85;   /* decay kills trees outright */
    /* each tree keeps its own timing, a little ahead or behind its neighbours */
    const j = (hash(gx, gy, s + 519) - .5) * .16, Tt = season.T + j, ever = EVERGREEN.has(sp.kind);
    const leaf = ever ? 1 : leafAt(Tt, season.rising), aut = ever ? 0 : autAt(Tt, season.rising), hue = (hash(gx, gy, s + 521) * 4) | 0;
    feats.trees.push({ u, v, R, trunk: tr * (.8 + r4 * .5), kind: sp.kind, col: sp.col, seed: r3 * 997 + r4, dead, leaf, aut, hue, stray, r4, j });
  });
  /* one area, one kind of wood: a tree the sliders added where the land names none is the same kind as the nearest real tree
     (within ~450 ft), so turning Tree cover up adds more of what grows there, never a different species */
  { const anchors = feats.trees.filter(t => !t.stray);
    for (const t of feats.trees) { if (!t.stray) continue; let best = null, bd = 450 * 450;
      for (const a of anchors) { const d = (a.u - t.u) ** 2 + (a.v - t.v) ** 2; if (d < bd) { bd = d; best = a; } }
      if (best && best.kind !== t.kind) { const [a0, a1] = SPECIES[t.kind] ?? SPECIES.oak, [b0, b1, btr] = SPECIES[best.kind] ?? SPECIES.oak, k = t.R / ((a0 + (a1 - a0) * t.r4) || 1);
        t.R = (b0 + (b1 - b0) * t.r4) * k; t.trunk = btr * (.8 + t.r4 * .5); t.kind = best.kind; t.col = best.col;
        const ever = EVERGREEN.has(t.kind), Tt = season.T + t.j; t.leaf = ever ? 1 : leafAt(Tt, season.rising); t.aut = ever ? 0 : autAt(Tt, season.rising); } } }
  /* undergrowth: patches where a slow noise runs high; denser on damp ground and at forest edges */
  lattice(6, 611, (wx, wy, u, v, r3) => {
    const t = terrainAt(wx, wy), fx = wx * FT_PER_MI, fy = wy * FT_PER_MI, n = fbm(fx / 34, fy / 34, 3, s + 613);
    const th0 = t === T.damp ? .5 : t === T.woods ? .58 : t === T.old ? .64 : t === T.rough ? .66 : t === T.hills ? .7 : t === T.fields ? .78 : 1;
    const th = th0 >= 1 ? 1 : th0 - tune.brush * .2 - Math.max(0, -(tune.decay ?? 0)) * .14;   /* lush: more undergrowth */
    if (n < th || r3 > .8 || !clearOf(u, v, 2) || inF(OPEN_FEATS, u, v, .95)) return;
    const Tb = season.T + .05 + (r3 - .4) * .12;   /* shrubs leaf out a little before the trees */
    feats.brush.push({ u, v, r: 2.2 + r3 * 2.4, t, leaf: leafAt(Tb, season.rising), aut: autAt(Tb, season.rising), hue: (r3 * 10 % 4) | 0 });
  });
  /* deadfall in the woods */
  lattice(55, 701, (wx, wy, u, v, r3, r4) => {
    const t = terrainAt(wx, wy), dz = inF(["dead"], u, v); if (!((forest(t) || dz) && r3 < (t === T.old ? .3 : .16) * ((tune.decay ?? 0) >= 0 ? 1 + tune.decay * 2 : 1 + tune.decay * .85) * (dz ? 3 : 1)) || !clearOf(u, v, 8) || inF(OPEN_FEATS, u, v, 1.1)) return;
    feats.logs.push({ u, v, len: 12 + r4 * 16, ang: r3 * 37 % Math.PI, w: 1.4 + r4 * 1.4 });
  });
  /* stones and boulders on rough and hill ground, and a few on the creek bed */
  lattice(26, 801, (wx, wy, u, v, r3, r4) => {
    const t = terrainAt(wx, wy), wa = waterAt(u, v);
    const p = t === T.hills ? .2 : t === T.rough ? .08 : t === T.crag ? .5 : t === T.snow ? .14 : t === T.bad ? .3 : forest(t) ? .04 : wa > -.6 && wa < .2 ? .25 : 0;
    if (r3 >= nudge(p, tune.rocks, t === T.fields || forest(t) ? .03 : .12) || roadAt(u, v) < 8 || inF(["camp", "clearing"], u, v)) return;
    feats.rocks.push({ u, v, r: (t === T.crag || t === T.hills || t === T.snow ? 2 : 1) + r4 * (t === T.snow ? 4 : 3), seed: r4, t });
  });
  /* boulder fields: a closer lattice inside the feature */
  /* Rocks turned up: boulder fields, clustered where a slow noise runs high (stony ground first, a few in the woods, none in the fields or water) */
  if (tune.rocks > 0) lattice(9, 861, (wx, wy, u, v, r3, r4) => { const t = terrainAt(wx, wy); if (t === T.fields || t === T.water || t === T.damp) return;
    const n = tbl(wx * FT_PER_MI * .45 + 21, wy * FT_PER_MI * .45 + 63), th = (forest(t) ? .74 : .66) - tune.rocks * .2;
    if (n < th || r3 > .25 + (n - th) * 2 || waterAt(u, v) > -.25 || roadAt(u, v) < 8 || inF(["camp", "clearing", ...OPEN_FEATS], u, v)) return;
    feats.rocks.push({ u, v, r: 1.4 + r4 * (2.4 + tune.rocks * 2.2), seed: r4, t, big: true }); });
  lattice(9, 851, (wx, wy, u, v, r3, r4) => { if (!inF(["boulders"], u, v) || r3 > .42 || waterAt(u, v) > -.2) return; feats.rocks.push({ u, v, r: 1.5 + r4 * 3.5, seed: r4, t: terrainAt(wx, wy), big: true }); });
  /* the built and shaped features, each from its own seeded generator */
  feats.outcrops = []; feats.stones = []; feats.ruins = []; feats.camps = []; feats.fallen = []; feats.caves = [];
  for (const f of FT) {
    const r_ = rng(Math.round((f.x * 1e4 + f.y * 3e3) * 97) + 31 + f.i), toC = Math.atan2(Hft / 2 - f.v, Wft / 2 - f.u);
    if (f.kind === "outcrop") { const n = 4 + Math.floor(r_() * 4); for (let k = 0; k < n; k++) { const a = r_() * 6.283, d = Math.sqrt(r_()) * f.r * .55; feats.outcrops.push({ u: f.u + Math.cos(a) * d, v: f.v + Math.sin(a) * d, r: 4 + r_() * 5 * (f.size ?? 1), seed: r_() }); } }
    if (f.kind === "stones") { const n = 7 + Math.floor(r_() * 3), R = f.r * .62, a0 = r_() * 6.283; for (let k = 0; k < n; k++) { if (r_() < .12) continue; const a = a0 + k / n * 6.283; feats.stones.push({ u: f.u + Math.cos(a) * R, v: f.v + Math.sin(a) * R, w: 4.5 + r_() * 1.8, h: 2.2 + r_() * .9, ang: a + Math.PI / 2 + (r_() - .5) * .4, fallen: r_() < .18 }); }
      if (r_() < .7) feats.stones.push({ u: f.u, v: f.v, w: 6, h: 3.5, ang: r_() * 3, altar: true }); }
    if (f.kind === "ruins") { const a = r_() * Math.PI, w = f.r * 1.3, h = f.r * (.8 + r_() * .3), ca = Math.cos(a), sa = Math.sin(a), P = (x, y) => ({ u: f.u + x * ca - y * sa, v: f.v + x * sa + y * ca });
      const corners = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
      for (let k = 0; k < 4; k++) { const [ax, ay] = corners[k], [bx, by] = corners[(k + 1) % 4], len = Math.hypot(bx - ax, by - ay), n = Math.max(2, Math.round(len / 9));
        for (let q = 0; q < n; q++) { if (r_() < .3) continue; const t0 = q / n + .02, t1 = (q + 1) / n - .02 - r_() * .25 / n; feats.ruins.push({ a: P(ax + (bx - ax) * t0, ay + (by - ay) * t0), b: P(ax + (bx - ax) * t1, ay + (by - ay) * t1), th: 2 + r_() * .6 }); } }
      for (let k = 0; k < 14; k++) { const q = P((r_() - .5) * w * 1.2, (r_() - .5) * h * 1.2); feats.rocks.push({ u: q.u, v: q.v, r: .8 + r_() * 1.6, seed: r_(), t: T.rough }); } }
    if (f.kind === "camp") feats.camps.push({ u: f.u, v: f.v, ang: r_() * 6.283, seed: r_() });
    if (f.kind === "fallen") { const a = f.ang ?? r_() * Math.PI, len = 48 + r_() * 22 * (f.size ?? 1); feats.fallen.push({ u: f.u, v: f.v, len, w: 4 + r_() * 1.5, ang: a, seed: r_() }); }
    if (f.kind === "cave") feats.caves.push({ u: f.u, v: f.v, r: f.r, face: f.ang ?? toC, seed: r_() });
  }
  /* ground detail: grass tufts, flowers, leaf litter, ferns, on a 3-ft lattice */
  feats.tufts = [];
  lattice(3, 901, (wx, wy, u, v, r3, r4) => {
    if (u < -4 || v < -4 || u > Wft + 4 || v > Hft + 4) return;
    const t = terrainAt(wx, wy), wa = waterAt(u, v); if (wa > -.15 || roadAt(u, v) < 6 || inF(["camp", "ruins", "cave"], u, v, .8)) return;
    const lu = Math.max(0, -(tune.decay ?? 0));   /* lush: ferns carpet the woods, more flowers in the open */
    const kind = forest(t) ? (r3 < (t === T.old ? .16 : .1) + lu * .2 ? "fern" : r3 < .38 + lu * .1 ? "leaf" : null) : (t === T.fields || t === T.rough || t === T.hills || t === T.damp) ? (r3 < .34 ? "tuft" : r3 < (t === T.fields ? .37 : .355) + lu * .06 ? "flower" : r4 < lu * .08 ? "fern" : null) : null;
    if (kind) feats.tufts.push({ u, v, kind, r: r4, t });
  });
  return { cols, rows, Wft, Hft, x0, y1, cx, cy, tune, season, placed: FT, inF, land, terrainAt, coverAt, goingF, goingAt, GOING, elevAt, waterAt, roadAt, W, L, lines, feats };
}

/* trunk thickness in feet of radius: under THIN no wall; from THIN a wall that gives limited sight; from THICK a wall that blocks sight */
export const TRUNK_THIN = .75, TRUNK_THICK = 1.6;
/* Rhea, 2026-11-06: a trunk 3 ft across or more is something to hide behind, so standard cover; anything thinner is lesser cover at most.
   Under THIN there's no wall, so no cover. Visioner's own reckoning from the walls gave greater cover behind most trunks. */
export const TRUNK_COVER = 1.5;
export const trunkCover = trunk => trunk < TRUNK_THIN ? "none" : trunk >= TRUNK_COVER ? "standard" : "lesser";
/* each 5-ft square, 25 samples: the share under water and in undergrowth or climbing-over, and the cost:
   0 plain, 1 difficult (undergrowth or shallow water), 2 greater difficult (deep water: the middle of a river or wide creek; a
   narrow creek is shallow throughout) */
function squareRead(plan) {
  const { cols, rows } = plan, cost = new Uint8Array(cols * rows), water = new Uint8Array(cols * rows), brushN = new Uint8Array(cols * rows), B = plan.feats.brush;
  /* climbing over: a fallen giant (its whole length) and big boulders */
  const logs = plan.feats.fallen ?? [], bigRocks = plan.feats.rocks.filter(r => r.big && r.r >= 2.5);
  const over = (u, v) => logs.some(g => { const ca = Math.cos(g.ang), sa = Math.sin(g.ang), du = u - g.u, dv = v - g.v, al = du * ca + dv * sa, ac = -du * sa + dv * ca; return Math.abs(al) < g.len / 2 && Math.abs(ac) < g.w / 2 + .5; })
    || bigRocks.some(r => (r.u - u) ** 2 + (r.v - v) ** 2 < r.r * r.r);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const near = B.filter(b => Math.abs(b.u - (i * SQ_FT + 2.5)) < b.r + 3 && Math.abs(b.v - (j * SQ_FT + 2.5)) < b.r + 3);
    let wet = 0, deep = 0, brush = 0;
    const go = plan.goingAt ? [[1, 1], [3.5, 1], [1, 3.5], [3.5, 3.5], [2.5, 2.5]].reduce((a, [a1, b1]) => a + plan.goingAt(i * SQ_FT + a1, j * SQ_FT + b1).g, 0) / 5 : 0;   /* drifts, mud, scree */
    for (let a = 0; a < SQ_FT; a++) for (let b = 0; b < SQ_FT; b++) {
      const u = i * SQ_FT + a + .5, v = j * SQ_FT + b + .5, wa = plan.waterAt(u, v);
      if (wa > 0) { wet++; if (wa > .7) deep++; } else if (over(u, v) || near.some(q => (q.u - u) ** 2 + (q.v - v) ** 2 < q.r * q.r * .8)) brush++;
    }
    const k = j * cols + i; water[k] = wet; brushN[k] = brush;
    cost[k] = deep >= 20 ? 2 : wet >= 13 || brush + wet >= 12 || go > .5 ? 1 : 0;
  }
  return { cost, water, brush: brushN };
}
export const squareCosts = plan => squareRead(plan).cost;
/* a plan as plain data per square, with no names and no pins: grids (one value a square, row by row), things and lines. Pure. */
export function readPlan(plan) {
  const { cols, rows, Wft, Hft } = plan, n = cols * rows, sq = (u, v) => [Math.floor(u / SQ_FT), Math.floor(v / SQ_FT)];
  const inMap = q => q.u >= 0 && q.v >= 0 && q.u < Wft && q.v < Hft, r2 = x => +x.toFixed(2);
  const { cost, water, brush } = squareRead(plan), terrain = new Array(n), elev = new Array(n);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) { const w = plan.W(i * SQ_FT + 2.5, j * SQ_FT + 2.5); terrain[j * cols + i] = plan.terrainAt(w.x, w.y); elev[j * cols + i] = Math.round(plan.elevAt(w.x, w.y)); }
  /* crowns over each square, 25 samples a square. Dead trees have no crown to speak of. */
  const fine = new Uint8Array(n * 25), fw = cols * 5, fh = rows * 5;
  for (const t of plan.feats.trees) { if (t.dead) continue; const R = t.R, i0 = Math.max(0, Math.floor(t.u - R)), i1 = Math.min(fw - 1, Math.ceil(t.u + R)), j0 = Math.max(0, Math.floor(t.v - R)), j1 = Math.min(fh - 1, Math.ceil(t.v + R));
    for (let b = j0; b <= j1; b++) for (let a = i0; a <= i1; a++) if ((a + .5 - t.u) ** 2 + (b + .5 - t.v) ** 2 < R * R) fine[b * fw + a] = 1; }
  const canopy = new Array(n).fill(0);
  for (let b = 0; b < fh; b++) for (let a = 0; a < fw; a++) if (fine[b * fw + a]) canopy[Math.floor(b / 5) * cols + Math.floor(a / 5)]++;
  const share = a => Array.from(a, v => r2(v / 25));
  const F = plan.feats, at = q => sq(q.u, q.v);
  /* a line's squares, in order along it, once each */
  const lines = plan.lines.map(l => { const squares = [], seen = new Set();
    for (let k = 1; k < l.pts.length; k++) { const a = l.pts[k - 1], b = l.pts[k], m = Math.ceil(Math.hypot(b.u - a.u, b.v - a.v) / 2.5);
      for (let q = 0; q <= m; q++) { const u = a.u + (b.u - a.u) * q / (m || 1), v = a.v + (b.v - a.v) * q / (m || 1); if (u < 0 || v < 0 || u >= Wft || v >= Hft) continue; const c = sq(u, v), key = c[1] * cols + c[0]; if (!seen.has(key)) { seen.add(key); squares.push(c); } } }
    return { kind: l.kind, squares }; }).filter(l => l.squares.length);
  return {
    grids: { terrain, cost: Array.from(cost), elev, water: share(water), canopy: share(canopy), brush: share(brush) },
    things: {
      trees: F.trees.filter(inMap).map(t => ({ at: at(t), trunk: r2(t.trunk), kind: t.kind, dead: !!t.dead, sight: t.trunk < TRUNK_THIN ? "open" : t.trunk >= TRUNK_THICK && !t.dead ? "blocks" : "limited", cover: trunkCover(t.trunk) })),
      rocks: F.rocks.filter(q => inMap(q) && q.r >= 2.5).map(q => ({ at: at(q), r: r2(q.r), climb: !!q.big })),
      logs: F.logs.filter(inMap).map(q => ({ at: at(q), len: r2(q.len), ang: r2(q.ang) })),
      fallen: (F.fallen ?? []).filter(inMap).map(q => ({ at: at(q), len: r2(q.len), ang: r2(q.ang) })),
      stones: (F.stones ?? []).filter(inMap).map(q => ({ at: at(q), fallen: !!q.fallen, altar: !!q.altar })),
      ruins: (F.ruins ?? []).filter(q => inMap(q.a) || inMap(q.b)).map(q => ({ from: at(q.a), to: at(q.b) })),
      outcrops: (F.outcrops ?? []).filter(inMap).map(q => ({ at: at(q), r: r2(q.r) })),
      camps: (F.camps ?? []).filter(inMap).map(q => ({ at: at(q) })),
      caves: (F.caves ?? []).filter(inMap).map(q => ({ at: at(q), face: r2(q.face) })),
      placed: plan.placed.filter(inMap).map(f => ({ kind: f.kind, at: at(f), r: r2(f.r) }))
    },
    lines
  };
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
export function drawEncounter(plan, styleName = "story", pxSq = 100, layers = "all") {
  if (styleName === "real") return drawReal(plan, pxSq, layers);
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
    else if (q.kind === "flower" && sea.dormant < .3 && !(sea.snow > 0 && snowAt(plan.x0 * FT_PER_MI + q.u, plan.y1 * FT_PER_MI - q.v, q.t) > .3)) { c.fillStyle = q.r < .4 ? "#f0ecd8" : q.r < .7 ? "#e8c64a" : "#b88ac8"; c.beginPath(); c.arc(x, y, k * .28, 0, 7); c.fill(); }
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

/* ---------- realistic painting (the "real" style, grown out of "painted") ----------
   Colour varies, not just brightness; grass and litter are drawn blade by blade and leaf by leaf; canopies are hundreds of
   lit leaf clusters with soft cast shadows; water shows the bed through the shallows, flows, and foams at the edges.
   layers: "all" (one image), "ground" (ground and undergrowth, no tree crowns; for the map) or "canopy" (tree crowns only, transparent; for an overhead tile). */
const mixRgba = (str, to, k) => { const m = str.match(/[\d.]+/g).map(Number); return `rgba(${Math.round(m[0] + (to[0] - m[0]) * k)},${Math.round(m[1] + (to[1] - m[1]) * k)},${Math.round(m[2] + (to[2] - m[2]) * k)},${m[3] ?? 1})`; };
const ihash = (x, y) => { let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const sm = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
/* Colours measured from 60-odd straight-down summer drone photos of temperate woods, meadows and creeks (Unsplash, Nov 2026):
   canopy luminance percentiles 5/20/40/60/80/95 for broadleaf and conifer stands; meadow grass about 95,124,52; water under trees 63,87,67. */
/* battle-map finish: the measured ramp lifted out of black and a little more saturated */
const RAMP_BROAD = [[30, 50, 30], [42, 70, 36], [64, 98, 42], [94, 130, 52], [134, 166, 70], [188, 210, 106]];
const RAMP_CONIFER = [[18, 38, 30], [26, 54, 38], [38, 72, 46], [54, 94, 56], [80, 122, 68], [122, 156, 90]];
const ramp = (R, t) => { t = Math.max(0, Math.min(.9999, t)) * (R.length - 1); const i = Math.floor(t), f = t - i; return mixc(R[i], R[i + 1], f); };
const REAL = {
  [T.fields]: [[98, 134, 56], [128, 150, 70]], [T.rough]: [[104, 130, 58], [138, 146, 76]], [T.woods]: [[84, 82, 48], [72, 92, 46]], [T.old]: [[70, 68, 40], [60, 80, 40]],
  [T.damp]: [[80, 98, 54], [112, 116, 70]], [T.hills]: [[136, 126, 88], [116, 120, 68]], [T.bad]: [[96, 88, 82], [80, 74, 70]], [T.crag]: [[138, 134, 126], [112, 110, 104]], [T.snow]: [[222, 228, 238], [206, 214, 228]]
};
const GRASS = ["rgba(70,100,38,.42)", "rgba(92,124,46,.4)", "rgba(126,152,64,.38)", "rgba(160,170,92,.32)", "rgba(84,112,44,.4)", "rgba(112,140,58,.38)"];
const LITTER = ["rgba(150,104,52,.28)", "rgba(170,132,62,.24)", "rgba(122,90,48,.28)", "rgba(190,160,84,.2)", "rgba(98,80,50,.26)"];

export function drawReal(plan, pxSq = 100, layers = "all") {
  const ppf = pxSq / SQ_FT, w = Math.round(plan.Wft * ppf), h = Math.round(plan.Hft * ppf);
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h; const c = cv.getContext("2d");
  const fw = Math.ceil(plan.Wft) + 2, fh = Math.ceil(plan.Hft) + 2, TF = new Uint8Array(fw * fh), EF = new Float32Array(fw * fh), WF = new Float32Array(fw * fh), RF = new Float32Array(fw * fh);
  for (let j = 0; j < fh; j++) for (let i = 0; i < fw; i++) { const k = j * fw + i, p = plan.W(i, j); TF[k] = plan.terrainAt(p.x, p.y); WF[k] = plan.waterAt(i, j); RF[k] = plan.roadAt(i, j);
    const fx = p.x * FT_PER_MI, fy = p.y * FT_PER_MI; EF[k] = plan.elevAt(p.x, p.y) + (fbm(fx / 30, fy / 30, 3, plan.land.s + 41) - .5) * 5 - Math.max(0, WF[k] + 1) * 2.4; }
  const bil = (A, u, v) => { const i = Math.max(0, Math.min(fw - 2, Math.floor(u))), j = Math.max(0, Math.min(fh - 2, Math.floor(v))), a = u - i, b = v - j, k = j * fw + i; return (A[k] * (1 - a) + A[k + 1] * a) * (1 - b) + (A[k + fw] * (1 - a) + A[k + fw + 1] * a) * b; };
  /* terrain at a point: the class holding the most bilinear weight among the four surrounding feet (no allocation: called per pixel) */
  const tAt = (u, v) => { const i0 = Math.max(0, Math.min(fw - 2, Math.floor(u))), j0 = Math.max(0, Math.min(fh - 2, Math.floor(v))), fa = u - i0, fb = v - j0, k0 = j0 * fw + i0;
    const q0 = TF[k0], q1 = TF[k0 + 1], q2 = TF[k0 + fw], q3 = TF[k0 + fw + 1];
    if (q0 === q1 && q0 === q2 && q0 === q3) return q0;
    const w0 = (1 - fa) * (1 - fb), w1 = fa * (1 - fb), w2 = (1 - fa) * fb, w3 = fa * fb;
    const s = a => (q0 === a ? w0 : 0) + (q1 === a ? w1 : 0) + (q2 === a ? w2 : 0) + (q3 === a ? w3 : 0);
    let t = q0, best = s(q0), z; if ((z = s(q1)) > best) { best = z; t = q1; } if ((z = s(q2)) > best) { best = z; t = q2; } if ((z = s(q3)) > best) t = q3; return t; };
  /* smooth height (no hummock noise) for contour lines, when the elevation slider is up */
  const EC = (plan.tune?.relief ?? 0) > 0 ? new Float32Array(fw * fh) : null;
  if (EC) for (let j = 0; j < fh; j++) for (let i = 0; i < fw; i++) { const p = plan.W(i, j); EC[j * fw + i] = plan.elevAt(p.x, p.y); }
  /* slope shading per foot, sampled per pixel */
  const SL = new Float32Array(fw * fh); for (let j = 0; j < fh; j++) for (let i = 0; i < fw; i++) SL[j * fw + i] = (bil(EF, i - 1.5, j) - bil(EF, i + 1.5, j) + bil(EF, i, j - 1.5) - bil(EF, i, j + 1.5)) * .8;
  const ox = plan.x0 * FT_PER_MI, oy = plan.y1 * FT_PER_MI, decayS = plan.tune?.decay ?? 0, decay = Math.max(0, decayS), rel = Math.max(0, plan.tune?.relief ?? 0), sea = plan.season ?? SUMMER, forest = t => t === T.woods || t === T.old;
  /* snow at a world foot: drifts lit from the north-west, wind ripples, scoured rocky patches. Returns colour and a shade offset. */
  /* one stone of a loose stony skin at a world foot: cells of S ft, a jittered rounded stone in each (some cells empty) */
  const stoneAt = (gx0, gy0, S) => { const gx = gx0 * .83 + gy0 * .56, gy = gy0 * .83 - gx0 * .56, cx_ = Math.floor(gx / S), cy_ = Math.floor(gy / S), hs = ihash(cx_, cy_), h2 = ihash(cx_ + 71, cy_ - 13), h3 = ihash(cx_ - 29, cy_ + 47);
    const fu = gx / S - cx_ - .5 - (h2 - .5) * .36, fv = gy / S - cy_ - .5 - (h3 - .5) * .36, rr = hs < .1 ? 0 : .3 + hs * .2, dd = Math.hypot(fu * (1 + h2 * .4), fv * (1 + h3 * .4));
    return { in: dd < rr, tone: h2, shade: (-(fu + fv) * 40 + (hs - .5) * 16) }; };
  const snowTex = (gx, gy, col) => { let d = 0;
          /* (the noise table makes features about 23 units across, so an argument of gx * 23 / F gives features F feet wide) */
          /* drifts about 40 and 15 ft across, lit from the north-west: bright windward faces, blue lee shade */
          const hD = (x, y) => tbl(x * .58 + 7, y * .58 + 1) * .6 + tbl(x * 1.5 + 3, y * 1.5 + 5) * .4;
          const lit = (hD(gx - .7, gy + .7) - hD(gx + .7, gy - .7)) * 3;
          const along = gx * .8 + gy * .6, across = gy * .8 - gx * .6, bend = tbl(gx * .9 + 3, gy * .9 + 9) * 3;
          const rip = tbl(along * 1.4 + 2, across * 8 + bend);             /* wind ripples (sastrugi) about 3 ft apart */
          col = mixc(col, [158, 176, 208], sm(.0, .25, -lit) * .8 + sm(.3, .55, 1 - rip) * .2);
          col = mixc(col, [252, 252, 254], sm(.0, .2, lit) * .6);
          d += lit * 30 + (rip - .5) * 18;
          /* wind-scoured patches, about 50 ft, where rock and frozen scree show through */
          const sc = tbl(gx * .46 + 50, gy * .46 + 20) * .7 + tbl(gx * 3 + 9, gy * 3 + 31) * .3;
          if (sc > .64) { const k = sm(.64, .74, sc), st = stoneAt(gx, gy, 1.1);   /* frozen scree: rounded stones with frost-dark gaps, not grain */
            col = mixc(col, st.in ? mixc([128, 122, 112], [92, 88, 82], st.tone) : [70, 68, 66], k * (st.in ? .85 : .6)); d += (st.in ? st.shade : -10) * k; }
          if (ihash(gx * 9, gy * 9) > .996) col = [255, 255, 255];
        
    return { col, d }; };
  /* lying snow: patchy at first (drifts fill hollows), whole when deep; a little thinner under trees */
  const snowPn = (gx, gy) => tbl(gx * .7 + 61, gy * .7 + 17) * .75 + tbl(gx * 1.8 + 3, gy * 1.8 + 5) * .25;
  const snowAt = (gx, gy, t) => sea.snow <= 0 || t === T.snow ? 0 : sm(0, .1, sea.snow * 1.3 - (1 - snowPn(gx, gy)) * .9 + (forest(t) ? -.07 : 0));
  /* overall flow direction of the water, for streaks */
  let fa = 0; { const wl = plan.lines.find(l => l.kind === "creek" || l.kind === "river"); if (wl && wl.pts.length > 1) { const a = wl.pts[0], b = wl.pts[wl.pts.length - 1]; fa = Math.atan2(b.v - a.v, b.u - a.u); } }
  const ca = Math.cos(fa), sa = Math.sin(fa);
  let SEEDC = null;
  if (layers !== "canopy") {
    const img = c.createImageData(w, h), buf = new Uint32Array(img.data.buffer);
    for (let py = 0; py < h; py++) {
      const v = py / ppf;
      for (let px = 0; px < w; px++) {
        const u = px / ppf, t = tAt(u, v), gx = ox + u, gy = oy - v;
        let relief = 6 * (1 + rel * 1.5), dAdd = 0;
        const pal = REAL[t] ?? REAL[T.rough], nA = tbl(gx / 16, gy / 16), nB = tbl(gx / 5 + 11, gy / 5 + 29), n2 = tbl(gx / 2.3 + 40, gy / 2.3 + 17), n3 = tbl(gx / .7 + 9, gy / .7 + 3);
        let col = mixc(pal[0], pal[1], sm(.2, .8, nA * .45 + nB * .55));
        /* bare earth showing through grass */
        if (t === T.fields || t === T.rough || t === T.hills) { const dd = tbl(gx / 4.5 + 3, gy / 4.5 + 7) * .6 + n2 * .4; col = mixc(col, [132, 116, 76], sm(.66, .76, dd) * .5);
          col = mixc(col, [86, 116, 46], sm(.5, .72, tbl(gx / 2.2 + 31, gy / 2.2 + 13)) * .3); }
        /* moss on the forest floor */
        if (t === T.woods || t === T.old) col = mixc(col, [58, 78, 34], sm(.55, .7, tbl(gx / 7 + 5, gy / 7 + 2)) * .7);
        /* season: dormant straw grass in winter, fresh green in spring, leaf litter in autumn, snow lying in patches */
        if (sea.dormant > 0 && (t === T.fields || t === T.rough || t === T.hills || t === T.damp)) col = mixc(col, mixc([156, 142, 98], [128, 118, 84], n2), sea.dormant * .75);
        if (sea.dormant > 0 && (t === T.woods || t === T.old)) col = mixc(col, [92, 74, 50], sea.dormant * .5);
        if (sea.fresh > 0 && (t === T.fields || t === T.rough || t === T.hills || t === T.damp)) col = mixc(col, [118, 166, 58], sea.fresh * .35);
        if (sea.autumn > 0 && (t === T.woods || t === T.old)) col = mixc(col, mixc([150, 96, 40], [120, 70, 30], n2), sea.autumn * .55 * sm(.35, .6, tbl(gx * 2 + 4, gy * 2 + 9)));
        if (sea.snow > 0 && t !== T.snow && t !== T.crag && t !== T.bad) { const cov = snowAt(gx, gy, t);   /* crag lays its own snow after its texture */
          if (cov > 0) { const sn = snowTex(gx, gy, mixc([222, 228, 238], [206, 214, 228], .5)); col = mixc(col, sn.col, cov); dAdd += sn.d * cov; } }
        /* decay: grass and moss go grey-brown in patches */
        if (decayS < 0 && t !== T.snow && t !== T.crag && !(sea.snow > .5)) col = mixc(col, mixc([84, 140, 46], [52, 104, 38], n2), -decayS * (.3 + .3 * sm(.3, .7, tbl(gx * .6 + 11, gy * .6 + 4))));   /* lush: deep green growth and moss, in patches */
        if (decay > 0 && t !== T.snow && t !== T.crag) col = mixc(col, mixc([134, 122, 88], [100, 92, 72], n2), decay * (.4 + .5 * sm(.3, .7, tbl(gx * .6 + 3, gy * .6 + 8))));
        const sl = bil(SL, u, v);
        /* wind-packed snow: low ripples across the wind (from the north-west), blue-grey in the hollows, drifts, a little sparkle */
        if (t === T.snow) { const sn = snowTex(gx, gy, col); col = sn.col; dAdd += sn.d; relief = 14; }
        /* bare crag: cracked, banded stone with dark fissures and lichen */
        if (t === T.crag || t === T.bad) {
          /* bedded rock: blocks drawn out along the strike (~14 by 6 ft), only some joints open as dark cracks, grit in the wider ones,
             each block a slightly different tone and tilt, lichen on some */
          const th_ = .5 + (tbl(ox * .0004 + 9, oy * .0004 + 4) - .5) * 1.4, cs = Math.cos(th_), sn = Math.sin(th_), qx = (gx * cs + gy * sn) / 14, qy = (-gx * sn + gy * cs) / 6;
          const ix = Math.floor(qx), iy = Math.floor(qy); let d1 = 9, d2 = 9, ia = 0, ib = 0, ja = 0, jb = 0;
          if (!SEEDC || SEEDC.th !== th_) {   /* seed points cached per map (two hashes each, 9 cells a pixel, was the cost) */
            const qs = [[ox, oy], [ox + plan.Wft, oy], [ox, oy - plan.Hft], [ox + plan.Wft, oy - plan.Hft]].map(([X, Y]) => [(X * cs + Y * sn) / 14, (-X * sn + Y * cs) / 6]);
            const ax = Math.floor(Math.min(...qs.map(q => q[0]))) - 2, ay = Math.floor(Math.min(...qs.map(q => q[1]))) - 2, nx = Math.ceil(Math.max(...qs.map(q => q[0]))) + 3 - ax, ny = Math.ceil(Math.max(...qs.map(q => q[1]))) + 3 - ay;
            const sx = new Float32Array(nx * ny), sy = new Float32Array(nx * ny);
            for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { sx[j * nx + i] = ax + i + .15 + ihash(ax + i, ay + j) * .7; sy[j * nx + i] = ay + j + .15 + ihash(ax + i + 31, ay + j + 17) * .7; }
            SEEDC = { th: th_, ax, ay, nx, ny, sx, sy }; }
          const C_ = SEEDC;
          for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const X = ix + a, Y = iy + b, k = (Y - C_.ay) * C_.nx + (X - C_.ax), inb = X >= C_.ax && Y >= C_.ay && X < C_.ax + C_.nx && Y < C_.ay + C_.ny;
            const dx = qx - (inb ? C_.sx[k] : X + .15 + ihash(X, Y) * .7), dy = qy - (inb ? C_.sy[k] : Y + .15 + ihash(X + 31, Y + 17) * .7), dd = dx * dx + dy * dy;
            if (dd < d1) { d2 = d1; ja = ia; jb = ib; d1 = dd; ia = X; ib = Y; } else if (dd < d2) { d2 = dd; ja = X; jb = Y; } }
          const edge = (Math.sqrt(d2) - Math.sqrt(d1)) * 6, h1 = ihash(ia + 7, ib + 3), h2 = ihash(ia - 5, ib + 11), band = tbl(gx * 1.1 + 2, gy * 3 + 5);
          const open_ = ihash(Math.min(ia, ja) * 7 + Math.max(ia, ja) * 13, Math.min(ib, jb) * 11 + Math.max(ib, jb) * 5) > .58;
          col = mixc(col, mixc([130, 126, 117], [88, 86, 81], h1 * .4 + tbl(gx * .35 + 5, gy * .35 + 77) * .35 + sm(.45, .75, band) * .25), .8);
          col = mixc(col, [70, 68, 64], sm(.55, .8, tbl(gx * .9 + 40, gy * .9 + 2)) * .25);   /* weathering stains */
          dAdd += (h2 - .5) * 14 + (n3 - .5) * 8;
          if (h1 > .78) col = mixc(col, [140, 148, 104], sm(.58, .7, tbl(gx * 9 + 31, gy * 9 + 8)) * .4);   /* lichen */
          if (open_) { if (edge < .45) col = mixc(col, [40, 38, 36], (1 - edge / .45) * .9); else if (edge < 1.6) { dAdd -= (1.6 - edge) * 16; if (edge < .9 && ihash(gx * 2, gy * 2) > .7) col = mixc(col, [112, 104, 90], .4); } }
          else if (edge < .2) dAdd -= 14;   /* a closed joint: a hairline */
          if (sea.snow > 0) { const cov = Math.min(1, snowAt(gx, gy, t) * 1.1 + (open_ && edge < 1.4 ? .35 * sea.snow : 0));   /* snow lies on the rock, deepest in the open joints */
            if (cov > 0) { const sn = snowTex(gx, gy, mixc([222, 228, 238], [206, 214, 228], .5)); col = mixc(col, sn.col, cov); dAdd = dAdd * (1 - cov) + sn.d * cov; } }
          relief = 12;
        }
        /* rough going */
        const go = plan.goingF ? plan.goingF(gx, gy, t) : 0;
        if (go > 0) { const k = plan.GOING(t);
          if (k === "drift") {   /* deep drifts: fresh, smooth snow piled into soft pillows that bury the wind ripples; lit from the north-west, blue in the lee */
            const H = (x, y) => plan.goingF(x, y, t) * (.65 + .35 * tbl(x * 2.4 + 3, y * 2.4 + 61));
            const sh = (H(gx - 1.6, gy + 1.6) - H(gx + 1.6, gy - 1.6)) * 1.6;
            col = mixc(col, [242, 245, 250], Math.min(1, go * 1.4) * .8);
            if (sh < 0) col = mixc(col, [160, 178, 212], Math.min(.55, -sh * 1.4));
            dAdd = dAdd * (1 - go) + Math.max(-10, Math.min(18, sh * 40)); relief = 3;
          } else if (k === "mud" && sea.snow > .25) {   /* frozen hard under the snow: only a dimple shows */
            dAdd -= 4 * go;
          } else if (k === "mud") {   /* sucking mud: dark, wet, with standing puddles that catch the sky */
            col = mixc(col, mixc([84, 66, 44], [60, 48, 34], n2), go * .85); const pud = tbl(gx * 6 + 17, gy * 6 + 9);
            if (pud > .62) { const e = sm(.62, .7, pud) * go; col = mixc(col, [92, 108, 104], e * .8); dAdd += (ihash(gx * 3, gy * 3) > .9 ? 26 : 6) * e; }
            else dAdd -= 8 * go;
          } else if (!(sea.snow > 0 && t !== T.snow && snowAt(gx, gy, t) > .35)) {   /* loose scree (buried where snow lies): a skin of small broken stones with dark gaps */
            const st = stoneAt(gx, gy, k === "stony" ? 1.3 : 1.6), cover = go * (k === "stony" ? .75 : .9) * (st.tone < .2 && k === "stony" ? 0 : 1);
            if (st.in) { col = mixc(col, mixc([142, 137, 128], [100, 96, 90], st.tone), Math.min(1, cover * 1.3)); dAdd = dAdd * (1 - cover) + st.shade * cover; }
            else { col = mixc(col, [72, 68, 63], cover * (k === "stony" ? .4 : .85)); dAdd -= 10 * cover; }   /* the dark grit between stones hides the bedrock */
          } }
        if (EC) {   /* contour lines every 5 ft, darker every 25 ft, drawn a constant width whatever the slope */
          const e = bil(EC, u, v), ge = Math.hypot(bil(EC, u + .5, v) - bil(EC, u - .5, v), bil(EC, u, v + .5) - bil(EC, u, v - .5)) + 1e-4;
          const c5 = e / 5, dist = Math.abs(c5 - Math.round(c5)) * 5 / ge, idx = Math.round(c5) % 5 === 0, wFt = idx ? .2 : .13;
          if (dist < wFt) dAdd -= (idx ? 34 : 20) * rel * (1 - dist / wFt);
        }
        let d = (n3 - .5) * 10 + (ihash(gx * 10, gy * 10) - .5) * 7 + Math.max(-40, Math.min(40, sl * relief)) + dAdd;
        const wa = bil(WF, u, v), rd = bil(RF, u, v);
        if (rd < 6.5) { const e = sm(6.5, 4.8, rd); col = mixc(col, mixc([138, 116, 82], [118, 98, 70], n2), e); if (Math.abs(rd - 2.6) < .7) d -= 18 * e; if (ihash(gx * 4, gy * 4) > .93) d += 24 * e; }
        if (wa > -.55 && wa <= 0) { /* wet mud and pebbles on the banks */
          const m = sm(-.55, -.1, wa) * (sea.snow > .25 ? .25 : 1); col = mixc(col, mixc([120, 104, 74], [86, 72, 54], m), m * .9); if (wa > -.06) d -= 26 * (sea.snow > .25 ? .4 : 1);   /* frozen banks lie under the snow */
        }
        if (wa > 0) {
          const along = gx * ca - gy * sa, across = gx * sa + gy * ca, z = Math.min(1, wa);
          col = mixc([110, 150, 136], [62, 112, 112], sm(0, .4, z)); col = mixc(col, [40, 74, 80], sm(.4, .95, z));
          if (t === T.damp) col = mixc(col, mixc([92, 100, 64], [70, 80, 52], n2), .5);   /* swamp water: still, peaty, green-brown */
          if (sea.snow > .25 && (t === T.damp || plan.inF(["lake", "pond"], u, v))) {   /* still water freezes: grey-blue ice, white cracks, snow blown across it */
            const cr = Math.abs(tbl(gx * 1.3 + 5, gy * 1.3 + 50) - .5), cr2 = Math.abs(tbl(gx * 3.1 + 70, gy * 3.1 + 9) - .5);
            col = mixc([196, 210, 222], [168, 186, 204], sm(.3, .7, n2)); d = (nA - .5) * 8;
            if (cr < .007) { col = mixc(col, [234, 240, 247], .55); d += 4; }
            const cov = sm(.45, .75, tbl(gx * .7 + 33, gy * .7 + 8)) * Math.min(1, sea.snow * 1.4); if (cov > 0) col = mixc(col, [234, 238, 245], cov * .9);
          }
          const st1 = tbl(along / 9, across / .7), st2 = tbl(along / 3 + 7, across / .4 + 3);
          d = (st1 - .5) * 16 + (st2 - .5) * 10 + (1 - z) * 6;
          if (st1 > .74) d += (st1 - .74) * 80 * (1 - z * .5);
          if (z < .06) d += 34 * (1 - z / .06);
        }
        buf[py * w + px] = (255 << 24 | (Math.max(0, Math.min(255, col[2] + d)) << 16) | (Math.max(0, Math.min(255, col[1] + d)) << 8) | Math.max(0, Math.min(255, col[0] + d))) >>> 0;
      }
    }
    c.putImageData(img, 0, 0);
    c.lineCap = "round"; c.lineJoin = "round";
    /* grass blades and forest litter on fine world lattices, batched by colour */
    const gB = GRASS.map(() => new Path2D()), lB = LITTER.map(() => new Path2D()), twig = new Path2D();
    const s = plan.land.s, fx0 = Math.floor((ox - 2) / 1.1), fx1 = Math.ceil((ox + plan.Wft + 2) / 1.1), fy0 = Math.floor((oy - plan.Hft - 2) / 1.1), fy1 = Math.ceil((oy + 2) / 1.1);
    for (let gy = fy1; gy >= fy0; gy--) for (let gx = fx0; gx <= fx1; gx++) {
      const u0 = gx * 1.1 - ox, v0 = oy - gy * 1.1; if (u0 < -1 || v0 < -1 || u0 > plan.Wft + 1 || v0 > plan.Hft + 1) continue;
      const t = tAt(u0, v0), wa = bil(WF, u0, v0), rd = bil(RF, u0, v0); if (wa > -.3 || rd < 5) continue;
      if (sea.snow > 0 && snowAt(gx * 1.1, gy * 1.1, t) > .5) continue;   /* buried */
      if (t === T.fields || t === T.rough || t === T.hills || t === T.damp) {
        const dens = t === T.hills ? 2 : t === T.fields ? 3 : 4;
        for (let n = 0; n < dens; n++) { const r1 = hash(gx, gy, s + 1000 + n), r2 = hash(gx, gy, s + 1010 + n), r3 = hash(gx, gy, s + 1020 + n);
          const x = (u0 + r1 * 1.1) * ppf, y = (v0 + r2 * 1.1) * ppf, L = (.6 + r3 * 1.0) * ppf, an = -1.9 + (r3 - .5) * 1.1 + (r1 - .5) * .5, p = gB[(r2 * GRASS.length) | 0];
          p.moveTo(x, y); p.quadraticCurveTo(x + Math.cos(an) * L * .5 + L * .15, y + Math.sin(an) * L * .5, x + Math.cos(an) * L, y + Math.sin(an) * L); }
      } else if (t === T.woods || t === T.old) {
        for (let n = 0; n < 3; n++) { const r1 = hash(gx, gy, s + 1100 + n), r2 = hash(gx, gy, s + 1110 + n), r3 = hash(gx, gy, s + 1120 + n);
          if (r3 < .2 - sea.autumn * .18) continue; const x = (u0 + r1 * 1.1) * ppf, y = (v0 + r2 * 1.1) * ppf, a = r3 * 6.28, rl = (.2 + r3 * .22) * ppf, p = lB[(r1 * LITTER.length) | 0];
          p.moveTo(x + Math.cos(a) * rl, y + Math.sin(a) * rl); p.ellipse(x, y, rl, rl * .55, a, 0, 6.3); }
        if (hash(gx, gy, s + 1130) < .05) { const x = (u0 + .5) * ppf, y = (v0 + .5) * ppf, a = hash(gx, gy, s + 1131) * 6.28, L = (.8 + hash(gx, gy, s + 1132) * 1.4) * ppf; twig.moveTo(x, y); twig.lineTo(x + Math.cos(a) * L, y + Math.sin(a) * L); twig.lineTo(x + Math.cos(a + .5) * L * 1.3, y + Math.sin(a + .5) * L * 1.3); }
      }
    }
    c.lineWidth = Math.max(1, ppf * .13); GRASS.forEach((col, i) => { c.strokeStyle = sea.dormant > 0 ? mixRgba(col, [178, 160, 106], sea.dormant * .85) : sea.autumn > 0 ? mixRgba(col, [170, 150, 90], sea.autumn * .35) : col; c.stroke(gB[i]); });
    LITTER.forEach((col, i) => { c.fillStyle = col; c.fill(lB[i]); });
    c.strokeStyle = "rgba(52,38,24,.7)"; c.lineWidth = Math.max(1, ppf * .1); c.stroke(twig);
    /* ferns */
    const fernG = sea.dormant > .5 || sea.autumn > .6 ? ["rgba(120,84,44,.85)", "rgba(150,108,56,.8)", "rgba(136,96,50,.8)"] : ["rgba(58,92,34,.9)", "rgba(96,132,52,.8)", "rgba(78,116,44,.8)"];
    const fernAt = (q) => !(sea.snow > 0 && snowAt(plan.x0 * FT_PER_MI + q.u, plan.y1 * FT_PER_MI - q.v, q.t) > .4) && !(sea.dormant > .85);
    for (const q of plan.feats.tufts) if (q.kind === "fern" && fernAt(q)) {
      const x = q.u * ppf, y = q.v * ppf, n = 6;
      for (let a = 0; a < n; a++) { const an = a / n * 6.283 + q.r * 3, L = (1.3 + hash(a, Math.round(q.r * 999), 5) * .7) * ppf, ex = x + Math.cos(an) * L, ey = y + Math.sin(an) * L;
        c.strokeStyle = fernG[0]; c.lineWidth = Math.max(1, ppf * .08); c.beginPath(); c.moveTo(x, y); c.lineTo(ex, ey); c.stroke();
        c.strokeStyle = a % 2 ? fernG[1] : fernG[2]; c.lineWidth = Math.max(1, ppf * .1); c.beginPath();
        for (let k = 1; k < 7; k++) { const f = k / 7, bx = x + (ex - x) * f, by = y + (ey - y) * f, ll = L * .22 * (1 - f * .7); c.moveTo(bx, by); c.lineTo(bx + Math.cos(an + 1.1) * ll, by + Math.sin(an + 1.1) * ll); c.moveTo(bx, by); c.lineTo(bx + Math.cos(an - 1.1) * ll, by + Math.sin(an - 1.1) * ll); }
        c.stroke(); }
    }
    else if (q.kind === "flower") { const x = q.u * ppf, y = q.v * ppf; c.fillStyle = q.r < .4 ? "rgba(244,240,226,.9)" : q.r < .7 ? "rgba(232,198,74,.9)" : "rgba(184,138,200,.9)"; for (let k = 0; k < 4; k++) { c.beginPath(); c.arc(x + (hash(k, Math.round(q.r * 999), 8) - .5) * ppf * .8, y + (hash(k, Math.round(q.r * 999), 9) - .5) * ppf * .8, ppf * .14, 0, 7); c.fill(); } }
    /* swamp margins: reed clumps along the water's edge, lily pads on the still pools */
    { const R1 = new Path2D(), R2 = new Path2D(), LP = new Path2D(), LF = new Path2D(), S = 1.6, gx0 = Math.floor((ox - 2) / S), gx1 = Math.ceil((ox + plan.Wft + 2) / S), gy0 = Math.floor((oy - plan.Hft - 2) / S), gy1 = Math.ceil((oy + 2) / S);
      const dry = sea.dormant > .5 || sea.snow > .3;
      for (let gy = gy1; gy >= gy0; gy--) for (let gx = gx0; gx <= gx1; gx++) { const u = gx * S - ox + hash(gx, gy, s + 1211) * S, v = oy - gy * S + hash(gx, gy, s + 1212) * S;
        if (tAt(u, v) !== T.damp && !(tAt(u, v) !== T.snow && plan.inF(["lake", "pond"], u, v, 1.3))) continue; const wa = bil(WF, u, v), h = hash(gx, gy, s + 1213), x = u * ppf, y = v * ppf;
        if (wa > -.25 && wa < .18 && h < .7) { const n = 6 + (h * 20 | 0) % 6, L = (1.2 + h * 1.6) * ppf;   /* a reed clump */
          for (let k = 0; k < n; k++) { const a = -Math.PI / 2 + (hash(gx * 7 + k, gy, s + 1214) - .5) * 1.9, l = L * (.6 + hash(gx, gy * 7 + k, s + 1215) * .5), P = k % 2 ? R1 : R2;
            P.moveTo(x, y); P.quadraticCurveTo(x + Math.cos(a) * l * .5, y + Math.sin(a) * l * .5, x + Math.cos(a) * l + l * .12, y + Math.sin(a) * l); } }
        else if (wa > .2 && wa < .55 && h < .3 && !dry && tbl((ox + u) * .35 + 17, (oy - v) * .35 + 4) > .62) { const r = (.7 + h * 3) * ppf, a = h * 40;   /* a lily pad with its notch */
          LP.moveTo(x, y); LP.arc(x, y, r, a + .35, a + 6.0); LP.closePath(); if (h < .03) { LF.moveTo(x + r * .3, y); LF.arc(x, y, r * .3, 0, 6.3); } } }
      c.lineCap = "round"; c.lineWidth = Math.max(1, ppf * .09); c.strokeStyle = dry ? "rgba(150,128,80,.9)" : "rgba(70,96,40,.95)"; c.stroke(R1); c.strokeStyle = dry ? "rgba(128,108,68,.9)" : "rgba(104,130,56,.95)"; c.stroke(R2);
      c.fillStyle = "rgba(78,112,52,.95)"; c.fill(LP); c.lineWidth = Math.max(1, ppf * .05); c.strokeStyle = "rgba(46,70,34,.7)"; c.stroke(LP); c.fillStyle = "rgba(240,236,230,.95)"; c.fill(LF); }
    /* pebbles on the wet banks */
    { const P1 = new Path2D(), P2 = new Path2D(), H = new Path2D(), S = .9, gx0 = Math.floor((ox - 2) / S), gx1 = Math.ceil((ox + plan.Wft + 2) / S), gy0 = Math.floor((oy - plan.Hft - 2) / S), gy1 = Math.ceil((oy + 2) / S);
      for (let gy = gy1; gy >= gy0; gy--) for (let gx = gx0; gx <= gx1; gx++) { const u = gx * S - ox + hash(gx, gy, s + 1201) * S, v = oy - gy * S + hash(gx, gy, s + 1202) * S, wa = bil(WF, u, v);
        if (wa < -.4 || wa > .12 || hash(gx, gy, s + 1203) > .55 || tAt(u, v) === T.damp || sea.snow > .25 || plan.inF(["lake", "pond"], u, v, 1.3)) continue; const r = (.12 + hash(gx, gy, s + 1204) * .28) * ppf, x = u * ppf, y = v * ppf, P = hash(gx, gy, s + 1205) < .5 ? P1 : P2;
        P.moveTo(x + r, y); P.ellipse(x, y, r, r * .78, hash(gx, gy, s + 1206) * 3, 0, 6.3); H.moveTo(x - r * .25 + r * .3, y - r * .3); H.arc(x - r * .25, y - r * .3, r * .3, 0, 6.3); }
      c.fillStyle = "rgba(146,138,124,.95)"; c.fill(P1); c.fillStyle = "rgba(118,108,94,.95)"; c.fill(P2); c.fillStyle = "rgba(220,214,200,.45)"; c.fill(H); }
    /* rocks */
    for (const r of plan.feats.rocks) realRock(c, r.u * ppf, r.v * ppf, r.r * ppf, r.seed, r.t === T.snow || sea.snow > .4);
    /* stumps: a cut face with rings and a dark bark rim, a short shadow */
    for (const g of plan.feats.stumps ?? []) { const x = g.u * ppf, y = g.v * ppf, r = g.r * ppf;
      c.fillStyle = "rgba(30,24,16,.35)"; c.beginPath(); c.ellipse(x + r * .45, y + r * .5, r * 1.05, r * .9, .6, 0, 6.3); c.fill();
      c.fillStyle = "#4a3824"; c.beginPath(); c.arc(x, y, r, 0, 6.3); c.fill();
      c.fillStyle = sea.snow > .3 ? "#e8ecf2" : "#b39468"; c.beginPath(); c.arc(x - r * .06, y - r * .06, r * .8, 0, 6.3); c.fill();
      c.strokeStyle = "rgba(110,84,52,.7)"; c.lineWidth = Math.max(1, ppf * .04); for (let k = 1; k < 4; k++) { c.beginPath(); c.arc(x - r * .06 + g.seed * r * .1, y - r * .06, r * .8 * k / 4, 0, 6.3); c.stroke(); } }
    /* deadfall */
    for (const g of plan.feats.logs) realLog(c, g.u * ppf, g.v * ppf, g.len * ppf, g.w * ppf, g.ang, g.u * 7 + g.v);
    /* tree shadows: crisp, long, in the crown's outline, falling south-east (sun high in the north-west) */
    c.save(); c.globalCompositeOperation = "multiply"; c.fillStyle = "rgb(138,144,156)";
    /* each shadow is blurred on a small scratch canvas, then multiplied in: a blur filter on the full map canvas costs a whole-canvas pass per tree */
    for (const t of plan.feats.trees) { if (t.dead || (t.leaf ?? 1) < .12) continue; const R = t.R * ppf * .97, x = t.u * ppf + R * .36, y = t.v * ppf + R * .42, bl = Math.max(1, R * .1);
      /* blurred at reduced resolution (the edge is soft anyway), then scaled up */
      const q = Math.max(1, Math.min(4, bl / 1.5)), pad = Math.ceil(R * 1.2 + bl * 3 + 4), S = pad * 2, s2 = Math.ceil(S / q), sc = scratch(s2), ox = Math.floor(x) - pad, oy = Math.floor(y) - pad, k = sc.c;
      k.setTransform(1, 0, 0, 1, 0, 0); k.clearRect(0, 0, s2 + 1, s2 + 1); k.filter = `blur(${bl / q}px)`; { const lf = t.leaf ?? 1, g = (a, b) => Math.round(a + (b - a) * (1 - lf) * .8); k.fillStyle = `rgb(${g(138, 214)},${g(144, 218)},${g(156, 226)})`; } k.beginPath();
      for (const f of florets(t)) { const fx = (x - ox + f.x * R) / q, fy = (y - oy + f.y * R) / q, fr = f.r * R / q; k.moveTo(fx + fr, fy); k.arc(fx, fy, fr, 0, 7); } k.fill(); k.filter = "none";
      c.drawImage(sc.cv, 0, 0, s2, s2, ox, oy, s2 * q, s2 * q); }
    c.restore();
    /* placed features, ground level, each with its own shadow */
    for (const g of plan.feats.fallen ?? []) giantLog(c, g.u * ppf, g.v * ppf, g.len * ppf, g.w * ppf, g.ang, g.seed, ppf);
    for (const q of plan.feats.camps ?? []) campsite(c, q.u * ppf, q.v * ppf, q.ang, q.seed, ppf);
    for (const w of plan.feats.ruins ?? []) ruinWall(c, w.a.u * ppf, w.a.v * ppf, w.b.u * ppf, w.b.v * ppf, w.th * ppf, ppf);
    for (const q of plan.feats.stones ?? []) standingStone(c, q.u * ppf, q.v * ppf, q.w * ppf, q.h * ppf, q.ang, q, ppf);
    for (const q of plan.feats.caves ?? []) caveMouth(c, q.u * ppf, q.v * ppf, q.r * ppf, q.face, q.seed, ppf, sea.snow > .4);
    for (const r of plan.feats.outcrops ?? []) realRock(c, r.u * ppf, r.v * ppf, r.r * ppf, r.seed, sea.snow > .4);
    /* trunks and root flare, seen when the canopy above fades */
    for (const t of plan.feats.trees) { const x = t.u * ppf, y = t.v * ppf, r = Math.max(t.trunk, .5) * ppf;
      c.fillStyle = "rgba(10,8,4,.35)"; c.beginPath(); c.arc(x + r * .3, y + r * .35, r * 1.5, 0, 7); c.fill();
      const g = c.createRadialGradient(x - r * .3, y - r * .3, r * .1, x, y, r * 1.2); g.addColorStop(0, "#7a6046"); g.addColorStop(.7, "#4e3a26"); g.addColorStop(1, "#2a1f14"); c.fillStyle = g;
      c.beginPath(); for (let k = 0; k < 9; k++) { const a = k / 9 * 6.283, rr = r * (k % 2 ? 1 : 1.35); k ? c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr) : c.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); } c.closePath(); c.fill(); }
  }
  /* undergrowth is ground-level: it belongs to the map image, not the overhead canopy that fades */
  if (layers !== "canopy") for (const b of plan.feats.brush) if (!(sea.snow > 0 && snowAt(ox + b.u, oy - b.v, b.t) > .5)) realCanopy(c, b.u * ppf, b.v * ppf, b.r * ppf, null, b.u * 13 + b.v * 7, ppf, .8, "brush", { leaf: b.leaf ?? 1, aut: b.aut ?? 0, hue: b.hue ?? 0, fresh: plan.season?.fresh ?? 0 });
  if (layers !== "ground") {
    /* canopies, small first so big crowns sit on top */
    const trees = plan.feats.trees.slice().sort((a, b) => a.R - b.R);
    for (const t of trees) {
      const x = t.u * ppf, y = t.v * ppf, R = t.R * ppf, col = hex(t.col);
      if (t.dead) { realDeadTree(c, x, y, R, t.seed, ppf); continue; }
      if (t.kind === "pine" || t.kind === "hemlock") { realConifer(c, x, y, R, col, t.seed, ppf); if (sea.snow > .15) snowDust(c, x, y, R, t.seed, sea.snow); }
      else { realCanopy(c, x, y, R, col, t.seed, ppf, 1, t.kind, { leaf: t.leaf ?? 1, aut: t.aut ?? 0, hue: t.hue ?? 0, fresh: plan.season?.fresh ?? 0 }); }
    }
  }
  if (layers === "all") { c.strokeStyle = "rgba(20,20,10,.09)"; c.lineWidth = Math.max(1, pxSq / 70); c.beginPath(); for (let i = 0; i <= plan.cols; i++) { c.moveTo(i * pxSq + .5, 0); c.lineTo(i * pxSq + .5, h); } for (let j = 0; j <= plan.rows; j++) { c.moveTo(0, j * pxSq + .5); c.lineTo(w, j * pxSq + .5); } c.stroke(); }
  return cv;
}

/* a small seeded generator for per-tree draws (the lattice hash is fine for places, but its sequences correlate and draw spirals) */
function rng(seed) { let a = (Math.imul(seed | 0, 2654435761) ^ 0x9e3779b9) >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
/* foliage that reads at close range: the overland's darkest greens are lifted toward a living mid-green */
const liftDark = col => { const m = (col[0] + col[1] + col[2]) / 3; return m < 75 ? mixc(col, [86, 100, 48], .45 * (75 - m) / 40 + .2) : col; };
function jitter(col, k, a) { return [col[0] + (hash(k, 1, a) - .5) * 26, col[1] + (hash(k, 2, a) - .5) * 26, col[2] + (hash(k, 3, a) - .5) * 18]; }
/* A broadleaf crown seen from above is a cluster of florets (sub-domes), each lit on its own sun side, with dark crevices between. */
function florets(t) {
  const r_ = rng(Math.round(t.seed * 9973) + 113), Rft = t.R, n = 4 + Math.round(Rft / 2.1), out = [{ x: (r_() - .5) * .12, y: (r_() - .5) * .12, r: .44 + r_() * .1, h: 1 }];
  for (let i = 1; i < n; i++) { const a = r_() * 6.283, d = .3 + r_() * .36; out.push({ x: Math.cos(a) * d, y: Math.sin(a) * d * (.85 + r_() * .15), r: .26 + r_() * .16, h: 1 - d * .55 }); }
  return out;
}
/* a circle with a leafy, bumpy edge */
function bumpy(c, x, y, r, r_, n = 11, amp = .14) { const ph = r_() * 6.283, a2 = r_() * 6.283; c.moveTo(x + r, y);
  for (let k = 0; k <= 40; k++) { const a = k / 40 * 6.283, rr = r * (1 + amp * (.6 * Math.cos(n * a + ph) + .4 * Math.cos((n + 3) * a + a2))); k ? c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr) : c.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); } c.closePath(); }
let SCR = null;
/* one reusable scratch canvas, grown as needed */
function scratch(S) { if (!SCR || SCR.cv.width < S) { const cv = document.createElement("canvas"); cv.width = cv.height = Math.max(S, SCR ? SCR.cv.width : 0); SCR = { cv, c: cv.getContext("2d") }; } return SCR; }
/* autumn colour ramps (dark to light): yellow, orange, red, russet */
const RAMP_AUT = [[[64, 50, 14], [120, 92, 20], [176, 140, 34], [214, 178, 58], [236, 210, 110]], [[70, 36, 12], [130, 64, 18], [186, 102, 32], [220, 142, 56], [240, 188, 110]],
  [[56, 18, 14], [110, 30, 22], [164, 50, 32], [204, 84, 52], [232, 140, 104]], [[50, 36, 20], [92, 66, 34], [132, 98, 52], [168, 132, 76], [202, 172, 118]]];
const RAMP_FRESH = [[40, 66, 26], [70, 108, 34], [112, 150, 46], [160, 190, 70], [204, 222, 120]];
function realCanopy(c, x, y, R, col, seed, ppf, scale, kind, sea) {
  const r_ = rng(Math.round(seed * 9973) + 17), Rft = R / ppf, lf = sea?.leaf ?? 1, aut = sea?.aut ?? 0, fresh = sea?.fresh ?? 0, hue = RAMP_AUT[sea?.hue ?? 0];
  /* bare: the branches only; thin: branches under a sparse crown */
  if (lf < .12) return realDeadTree(c, x, y, R, seed, ppf, "bare");
  const keep = lf >= 1 ? null : rng(Math.round(seed * 31) + 7);
  if (keep) realDeadTree(c, x, y, R, seed, ppf, "bare");
  const tint = (kind === "birch" || kind === "beech" || kind === "beechS" || kind === "willow" ? .4 : kind === "dark" ? -.35 : kind === "brush" ? -.15 : 0) + (r_() - .5) * .6, val = (kind === "dark" ? .9 : 1) * (.9 + r_() * .2);
  const tone = t => { let c3 = ramp(RAMP_BROAD, t); if (aut > 0) c3 = mixc(c3, ramp(hue, Math.max(0, Math.min(1, t))), aut); if (fresh > 0) c3 = mixc(c3, ramp(RAMP_FRESH, Math.max(0, Math.min(1, t))), fresh * .5); return `rgb(${Math.min(255, (c3[0] + tint * 16) * val) | 0},${Math.min(255, (c3[1] + tint * 6) * val) | 0},${Math.min(255, (c3[2] - tint * 12) * val) | 0})`; };
  const F = florets({ R: Rft, seed }), lw = Math.max(1.4, ppf * .14);
  /* silhouette: a dark rim, then the shaded body; overlapping strokes are covered so only the outer edge shows */
  let shapes = F.map(f => ({ f, s: r_() * 1e6 }));
  if (keep) { const kp = lf ** .6; shapes = shapes.filter(() => keep() < kp); if (!shapes.length) return; }
  const sil = new Path2D(); for (const { f, s } of shapes) bumpy(sil, x + f.x * R, y + f.y * R, f.r * R * 1.04, rng(s));
  c.lineJoin = "round"; c.strokeStyle = tone(-.1); c.lineWidth = lw * 2; c.stroke(sil);
  c.fillStyle = tone(.05); c.fill(sil);
  /* each floret in three clean tones, lowest first, then a leaf texture on top */
  const leaf = Math.max(.3, Math.min(.5, Rft * .035));
  for (const { f } of shapes.slice().sort((a, b) => a.f.h - b.f.h)) {
    const fx = x + f.x * R, fy = y + f.y * R, fr = f.r * R, lift = (f.h - .7) * .25 - (f.x + f.y) * .08;
    c.fillStyle = tone(.32 + lift); c.beginPath(); bumpy(c, fx, fy, fr * .96, r_, 9, .12); c.fill();
    c.fillStyle = tone(.58 + lift); c.beginPath(); bumpy(c, fx - fr * .17, fy - fr * .19, fr * .68, r_, 8, .16); c.fill();
    c.fillStyle = tone(.82 + lift); c.beginPath(); bumpy(c, fx - fr * .3, fy - fr * .33, fr * .34, r_, 7, .2); c.fill();
    /* leaves: small stamps tinted by where they sit on the floret, plus a few dark gaps on the shaded side */
    const n = Math.round((10 + 1.1 * (f.r * Rft / leaf) ** 2) * scale * Math.sqrt(lf)), B = new Map();
    for (let i = 0; i < n; i++) { const a = r_() * 6.283, d = Math.sqrt(r_()) * .92, lx = Math.cos(a) * d, ly = Math.sin(a) * d, lit = Math.max(0, -(lx + ly) * .45 + .5 - d * .3);
      const px = fx + lx * fr, py = fy + ly * fr, rr = (.6 + r_() * .7) * leaf * ppf;
      const t = (lit < .25 && r_() < .35) ? .05 : .25 + lit * .7 + lift + (r_() - .5) * .12, q = Math.round(t * 40);
      const key = (i & 7) * 1000 + q; let path = B.get(key); if (!path) B.set(key, path = new Path2D());
      const rot = r_() * 3.14; path.moveTo(px + Math.cos(rot) * rr * 1.2, py + Math.sin(rot) * rr * 1.2); path.ellipse(px, py, rr * 1.2, rr * .75, rot, 0, 6.2832); }
    /* leaves are grouped by tone (one fill per tone, not per leaf) in eight interleaved passes, tones shuffled within a pass; the dark gaps go last so they read on top */
    const ord = k => k % 1000 === 2 ? 99 : Math.floor(k / 1000) * 10 + hash(k % 1000, 5, 77);
    c.globalAlpha = .8; for (const k of [...B.keys()].sort((a, b) => ord(a) - ord(b))) { c.fillStyle = tone((k % 1000) / 40); c.fill(B.get(k)); } c.globalAlpha = 1;
  }
}
/* a dead tree from above: bare grey limbs radiating from the trunk, forking as they go, with their shadow cast south-east */
function realDeadTree(c, x, y, R, seed, ppf, style = "dead") {
  const bare = style === "bare", depthMax = bare ? 4 : 3;
  const r_ = rng(Math.round(seed * 9973) + 53), limbs = [];
  const tips = [];
  const grow = (x0, y0, a, len, w, depth) => { const x1 = x0 + Math.cos(a) * len, y1 = y0 + Math.sin(a) * len; limbs.push([x0, y0, x1, y1, w]); if (depth >= depthMax - 1) tips.push([x1, y1, a]);
    if (depth < depthMax) { const n = 1 + (r_() < .7 ? 1 : 0); for (let i = 0; i < n + 1; i++) grow(x1, y1, a + (r_() - .5) * 1.3, len * (.55 + r_() * .2), w * .62, depth + 1); } };
  const n = 5 + Math.floor(r_() * 4); for (let i = 0; i < n; i++) grow(x, y, i / n * 6.283 + r_() * .6, R * (.32 + r_() * .14), Math.max(1.2, ppf * .55), 0);
  c.lineCap = "round";
  const draw = (dx, dy, col) => { for (const [a, b, e, f, w] of limbs) { c.strokeStyle = col; c.lineWidth = w; c.beginPath(); c.moveTo(a + dx, b + dy); c.lineTo(e + dx, f + dy); c.stroke(); } };
  c.save(); c.globalCompositeOperation = "multiply"; draw(R * .22, R * .26, "rgba(120,124,136,.55)"); c.restore();
  if (bare) {   /* a living bare crown: a haze of fine twigs over the limb tips, so a winter wood still reads as a wood from above */
    const g = c.createRadialGradient(x, y, R * .1, x, y, R * .95); g.addColorStop(0, "rgba(74,60,46,.30)"); g.addColorStop(.7, "rgba(80,66,52,.22)"); g.addColorStop(1, "rgba(80,66,52,0)");
    c.fillStyle = g; c.beginPath(); c.arc(x, y, R * .95, 0, 6.3); c.fill();
    c.strokeStyle = "rgba(78,64,50,.55)"; c.lineWidth = Math.max(.6, ppf * .07); c.beginPath();
    for (const [tx, ty, a] of tips) for (let k = 0; k < 4; k++) { const b = a + (r_() - .5) * 2.2, l = R * (.05 + r_() * .1); c.moveTo(tx, ty); c.lineTo(tx + Math.cos(b) * l, ty + Math.sin(b) * l); }
    c.stroke();
    draw(1, 1, "#2a221c"); draw(0, 0, "#6a5a4a"); } else { draw(1, 1, "#3e3833"); draw(0, 0, "#8a8178"); }
  c.lineWidth = Math.max(1, ppf * .2); c.strokeStyle = bare ? "rgba(150,132,112,.45)" : "rgba(200,192,180,.5)"; for (const [a, b, e, f, w] of limbs) if (w > ppf * .3) { c.beginPath(); c.moveTo(a - 1, b - 1); c.lineTo(e - 1, f - 1); c.stroke(); }
  const tr = Math.max(2, ppf * .9); c.fillStyle = "#5e554c"; c.beginPath(); c.arc(x, y, tr, 0, 7); c.fill(); c.fillStyle = "#9a9086"; c.beginPath(); c.arc(x - tr * .25, y - tr * .25, tr * .55, 0, 7); c.fill();
}
/* snow caught on a conifer's branch tips, more on the sunlit north-west side */
function snowDust(c, x, y, R, seed, amt) {
  const r_ = rng(Math.round(seed * 9973) + 71), P = new Path2D(), n = Math.round(30 + amt * 60);
  for (let i = 0; i < n; i++) { const a = r_() * 6.283, d = Math.sqrt(r_()) * R * .82, px = x + Math.cos(a) * d, py = y + Math.sin(a) * d, rr = R * (.035 + r_() * .05);
    if (r_() > amt * 1.2 + .1) continue; P.moveTo(px + rr, py); P.ellipse(px, py, rr * 1.4, rr, a, 0, 6.283); }
  c.fillStyle = "rgba(240,244,250,.88)"; c.fill(P);
}
function realConifer(c, x, y, R, col, seed, ppf) {
  const key = Math.round(seed * 97) | 0, r_ = rng(Math.round(seed * 9973) + 29), tilt = r_() * 6.283; col = liftDark(col);
  c.fillStyle = `rgb(${RAMP_CONIFER[0]})`; c.beginPath(); for (let k = 0; k <= 36; k++) { const a = k / 36 * 6.283, rr = R * (k % 2 ? .74 : .84); k ? c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr) : c.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); } c.closePath(); c.fill();
  for (let layer = 0; layer < 3; layer++) {
    const n = 14 + layer * 3, sc = 1 - layer * .26;
    for (let i = 0; i < n; i++) {
      const a = i / n * 6.283 + r_() * .55 + layer * .3, L = R * sc * (.7 + r_() * .36) * (1 + .12 * Math.cos(a - tilt)), wd = R * .17 * sc, lit = -(Math.cos(a) + Math.sin(a)) * 14 + layer * 20 - 30;
      const ex = x + Math.cos(a) * L, ey = y + Math.sin(a) * L, nx = -Math.sin(a) * wd, ny = Math.cos(a) * wd;
      const cc = ramp(RAMP_CONIFER, Math.max(0, Math.min(1, (lit + 62) / 92 + (r_() - .5) * .1))); c.fillStyle = `rgb(${cc[0] | 0},${cc[1] | 0},${cc[2] | 0})`; c.beginPath(); c.moveTo(x + nx, y + ny); c.quadraticCurveTo(x + (ex - x) * .6 + nx * .9, y + (ey - y) * .6 + ny * .9, ex, ey); c.quadraticCurveTo(x + (ex - x) * .6 - nx * .9, y + (ey - y) * .6 - ny * .9, x - nx, y - ny); c.closePath(); c.fill();
      const tc = ramp(RAMP_CONIFER, Math.max(0, Math.min(1, (lit + 95) / 92))); c.strokeStyle = `rgb(${tc[0] | 0},${tc[1] | 0},${tc[2] | 0})`; c.lineWidth = Math.max(1, ppf * .06); c.beginPath();
      for (let k = 2; k < 9; k++) { const f = k / 9, bx = x + (ex - x) * f, by = y + (ey - y) * f, ll = wd * (1 - f) * 1.1; c.moveTo(bx, by); c.lineTo(bx + Math.cos(a + .9) * ll, by + Math.sin(a + .9) * ll); c.moveTo(bx, by); c.lineTo(bx + Math.cos(a - .9) * ll, by + Math.sin(a - .9) * ll); }
      c.stroke();
    }
  }
  const tip = ramp(RAMP_CONIFER, .95); c.fillStyle = `rgb(${tip.map(v => v | 0)})`; c.beginPath(); c.arc(x - R * .05, y - R * .06, R * .1, 0, 7); c.fill();
}
function willowStrands(c, x, y, R, col, seed, ppf) {
  const r_ = rng(Math.round(seed * 9973) + 41); c.lineWidth = Math.max(1, ppf * .05); c.globalAlpha = .32;
  for (let i = 0; i < 110; i++) { const a = r_() * 6.283, d0 = R * (.7 + r_() * .25), L = R * (.12 + r_() * .2); c.strokeStyle = shade(col, -(Math.cos(a) + Math.sin(a)) * 18 - 6);
    c.beginPath(); c.moveTo(x + Math.cos(a) * d0, y + Math.sin(a) * d0); c.quadraticCurveTo(x + Math.cos(a + .1) * (d0 + L * .6), y + Math.sin(a + .1) * (d0 + L * .6), x + Math.cos(a + .05) * (d0 + L), y + Math.sin(a + .05) * (d0 + L)); c.stroke(); }
  c.globalAlpha = 1;
}
function realRock(c, x, y, R, seed, snowy = false) {
  const key = Math.round(seed * 999), pts = [];
  for (let k = 0; k < 9; k++) { const a = k / 9 * 6.283 + seed * 3, rr = R * (.75 + .3 * hash(k, key, 3)); pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr * .85]); }
  const poly = () => { c.beginPath(); pts.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])); c.closePath(); };
  c.save(); c.shadowColor = "rgba(0,0,0,.45)"; c.shadowBlur = R * .5; c.shadowOffsetX = R * .3; c.shadowOffsetY = R * .35; c.fillStyle = "#5a5650"; poly(); c.fill(); c.restore();
  const g = c.createRadialGradient(x - R * .35, y - R * .4, R * .1, x, y, R * 1.1); g.addColorStop(0, "#b8b2a6"); g.addColorStop(.55, "#8a857b"); g.addColorStop(1, "#4e4a44"); c.fillStyle = g; poly(); c.fill();
  if (snowy) { c.fillStyle = "rgba(240,244,250,.92)"; c.beginPath(); c.ellipse(x - R * .15, y - R * .3, R * .62, R * .4, -.4, 0, 7); c.fill(); }
  else { c.fillStyle = "rgba(84,104,48,.45)"; c.beginPath(); c.ellipse(x - R * .1, y - R * .35, R * .5, R * .25, -.3, 0, 7); c.fill(); }
  c.strokeStyle = "rgba(40,36,32,.55)"; c.lineWidth = Math.max(1, R * .05); c.beginPath(); c.moveTo(x - R * .4, y + R * .1); c.lineTo(x + R * .05, y - R * .1); c.lineTo(x + R * .35, y + R * .25); c.stroke();
}
/* a giant fallen tree: a long trunk with bark ridges, a torn-up root plate at one end and broken limbs */
function giantLog(c, x, y, L, W, ang, seed, ppf) {
  const r_ = rng(Math.round(seed * 9973) + 81), ca = Math.cos(ang), sa = Math.sin(ang), dx = ca * L / 2, dy = sa * L / 2, nx = -sa, ny = ca;
  c.save(); c.globalCompositeOperation = "multiply"; c.strokeStyle = "rgba(120,124,136,.6)"; c.lineCap = "round"; c.lineWidth = W * 1.05; c.beginPath(); c.moveTo(x - dx + W * .5, y - dy + W * .6); c.lineTo(x + dx + W * .5, y + dy + W * .6); c.stroke(); c.restore();
  /* limbs */
  c.lineCap = "round"; for (let k = 0; k < 7; k++) { const t = .2 + r_() * .7, side = r_() < .5 ? -1 : 1, bx = x - dx + dx * 2 * t, by = y - dy + dy * 2 * t, a = ang + side * (.7 + r_() * .6), l = W * (1.2 + r_() * 1.6);
    c.strokeStyle = "#3a2c1e"; c.lineWidth = W * .22; c.beginPath(); c.moveTo(bx, by); c.lineTo(bx + Math.cos(a) * l, by + Math.sin(a) * l); c.stroke(); }
  /* trunk: dark edge, bark body, lit ridge along the north-west side */
  c.strokeStyle = "#2b2016"; c.lineWidth = W; c.beginPath(); c.moveTo(x - dx, y - dy); c.lineTo(x + dx, y + dy); c.stroke();
  c.strokeStyle = "#5c4630"; c.lineWidth = W * .8; c.stroke();
  c.strokeStyle = "rgba(150,122,88,.7)"; c.lineWidth = W * .22; c.beginPath(); c.moveTo(x - dx - nx * W * .18, y - dy - ny * W * .18); c.lineTo(x + dx - nx * W * .18, y + dy - ny * W * .18); c.stroke();
  c.strokeStyle = "rgba(30,22,14,.45)"; c.lineWidth = Math.max(1, ppf * .12); c.beginPath();
  for (let k = 0; k < 26; k++) { const t = r_(), o = (r_() - .5) * W * .6, bx = x - dx + dx * 2 * t + nx * o, by = y - dy + dy * 2 * t + ny * o; c.moveTo(bx, by); c.lineTo(bx + ca * W * (.6 + r_()), by + sa * W * (.6 + r_())); } c.stroke();
  /* root plate standing up at the base */
  const rx = x - dx - ca * W * .3, ry = y - dy - sa * W * .3, R = W * 1.6;
  c.fillStyle = "rgba(0,0,0,.3)"; c.beginPath(); c.ellipse(rx + R * .3, ry + R * .35, R, R * .55, ang + Math.PI / 2, 0, 7); c.fill();
  c.fillStyle = "#4a3a2a"; c.beginPath(); c.ellipse(rx, ry, R * .45, R, ang, 0, 7); c.fill();
  c.strokeStyle = "#2a2018"; c.lineWidth = Math.max(1, ppf * .25); c.beginPath(); for (let k = 0; k < 11; k++) { const a = ang + Math.PI + (r_() - .5) * 2.6, l = R * (.8 + r_() * .9); c.moveTo(rx, ry); c.quadraticCurveTo(rx + Math.cos(a) * l * .5, ry + Math.sin(a) * l * .5 + (r_() - .5) * R * .4, rx + Math.cos(a) * l, ry + Math.sin(a) * l); } c.stroke();
  c.fillStyle = "rgba(110,86,56,.85)"; c.beginPath(); c.ellipse(rx - ca * R * .1, ry - sa * R * .1, R * .25, R * .7, ang, 0, 7); c.fill();
}
/* a campsite: a ring of fire stones round ash and embers, bedrolls, a log seat and trampled ground */
function campsite(c, x, y, ang, seed, ppf) {
  const r_ = rng(Math.round(seed * 9973) + 91), f = ppf;
  const g0 = c.createRadialGradient(x, y, f, x, y, 9 * f); g0.addColorStop(0, "rgba(96,78,54,.55)"); g0.addColorStop(1, "rgba(96,78,54,0)"); c.fillStyle = g0; c.beginPath(); c.arc(x, y, 9 * f, 0, 7); c.fill();
  c.fillStyle = "#2a2622"; c.beginPath(); c.arc(x, y, 1.6 * f, 0, 7); c.fill();
  const g1 = c.createRadialGradient(x, y, 0, x, y, 1.4 * f); g1.addColorStop(0, "rgba(255,196,96,.95)"); g1.addColorStop(.45, "rgba(214,90,30,.85)"); g1.addColorStop(1, "rgba(60,30,20,.2)"); c.fillStyle = g1; c.beginPath(); c.arc(x, y, 1.4 * f, 0, 7); c.fill();
  for (let k = 0; k < 9; k++) { const a = k / 9 * 6.283 + r_() * .3; realRock(c, x + Math.cos(a) * 1.9 * f, y + Math.sin(a) * 1.9 * f, (.45 + r_() * .2) * f, r_()); }
  const rolls = [["#6b4a3a", "#8a6a50"], ["#4a5a6a", "#6a7a8a"], ["#5a5a3a", "#7a7a50"]];
  for (let k = 0; k < 3; k++) { const a = ang + k * 2.1 + (r_() - .5) * .4, d = 6.2 * f, bx = x + Math.cos(a) * d, by = y + Math.sin(a) * d, [dk, lt] = rolls[k];
    c.save(); c.translate(bx, by); c.rotate(a + Math.PI / 2); c.fillStyle = "rgba(0,0,0,.25)"; c.fillRect(-1.1 * f + 3, -3 * f + 3, 2.2 * f, 6 * f); c.fillStyle = dk; c.fillRect(-1.1 * f, -3 * f, 2.2 * f, 6 * f); c.fillStyle = lt; c.fillRect(-1 * f, -2.9 * f, 2 * f, 1.8 * f); c.restore(); }
  realLog(c, x + Math.cos(ang - 1) * 5 * f, y + Math.sin(ang - 1) * 5 * f, 6 * f, 1.2 * f, ang - 1 + Math.PI / 2, seed);
}
/* a length of ruined wall: dressed stone blocks, broken ends, its shadow cast south-east */
function ruinWall(c, ax, ay, bx, by, th, ppf) {
  const L = Math.hypot(bx - ax, by - ay), ux = (bx - ax) / L, uy = (by - ay) / L, nx = -uy, ny = ux;
  c.lineCap = "butt";
  c.save(); c.globalCompositeOperation = "multiply"; c.strokeStyle = "rgba(118,122,134,.7)"; c.lineWidth = th; c.beginPath(); c.moveTo(ax + th * .7, ay + th * .8); c.lineTo(bx + th * .7, by + th * .8); c.stroke(); c.restore();
  c.strokeStyle = "#4e4a44"; c.lineWidth = th; c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by); c.stroke();
  c.strokeStyle = "#8f897d"; c.lineWidth = th * .78; c.stroke();
  c.strokeStyle = "rgba(180,172,158,.8)"; c.lineWidth = th * .2; c.beginPath(); c.moveTo(ax - nx * th * .22, ay - ny * th * .22); c.lineTo(bx - nx * th * .22, by - ny * th * .22); c.stroke();
  c.strokeStyle = "rgba(50,46,40,.6)"; c.lineWidth = Math.max(1, ppf * .08); c.beginPath(); const step = th * 1.1;
  for (let d = step; d < L; d += step) { const px = ax + ux * d, py = ay + uy * d, o = (Math.round(d / step) % 2) * .5; c.moveTo(px + nx * th * .4, py + ny * th * .4); c.lineTo(px - nx * th * (o ? 0 : .4), py - ny * th * (o ? 0 : .4)); }
  c.moveTo(ax, ay); c.lineTo(bx, by); c.stroke();
}
/* a standing stone: a tall slab seen from above, with a long shadow; fallen ones lie flat and longer; an altar is a low wide block */
function standingStone(c, x, y, w, h, ang, q, ppf) {
  const len = q.fallen ? w * 1.8 : w, wid = q.altar ? h : h;
  c.save(); c.translate(x, y); c.rotate(ang);
  if (!q.fallen && !q.altar) { c.save(); c.rotate(-ang); c.globalCompositeOperation = "multiply"; c.fillStyle = "rgba(110,114,128,.75)"; c.beginPath(); c.moveTo(-w * .4, 0); c.lineTo(w * .4, 0); c.lineTo(w * 1.2, w * 1.35); c.lineTo(w * .65, w * 1.55); c.closePath(); c.fill(); c.restore(); }
  else { c.fillStyle = "rgba(0,0,0,.3)"; c.fillRect(-len / 2 + 3, -wid / 2 + 3, len, wid); }
  const g = c.createLinearGradient(-len / 2, -wid / 2, len / 2, wid / 2); g.addColorStop(0, "#b6b0a4"); g.addColorStop(.6, "#8a857b"); g.addColorStop(1, "#5c5850");
  c.fillStyle = "#3e3b36"; c.beginPath(); c.roundRect(-len / 2 - 1, -wid / 2 - 1, len + 2, wid + 2, wid * .35); c.fill();
  c.fillStyle = g; c.beginPath(); c.roundRect(-len / 2, -wid / 2, len, wid, wid * .35); c.fill();
  c.fillStyle = "rgba(96,112,64,.45)"; c.beginPath(); c.ellipse(-len * .15, -wid * .1, len * .2, wid * .25, .3, 0, 7); c.fill();
  if (q.altar) { c.strokeStyle = "rgba(60,30,30,.5)"; c.lineWidth = Math.max(1, ppf * .15); c.strokeRect(-len * .3, -wid * .25, len * .6, wid * .5); }
  c.restore();
}
/* a cave entrance: a horseshoe of rock open toward the map, rising behind into a mass of stone, with a dark mouth */
function caveMouth(c, x, y, R, face, seed, ppf, snowy) {
  const r_ = rng(Math.round(seed * 9973) + 97), back = face + Math.PI;
  /* the rock mass behind */
  for (let k = 0; k < 14; k++) { const a = back + (r_() - .5) * 3.4, d = R * (.45 + r_() * .5); realRock(c, x + Math.cos(a) * d, y + Math.sin(a) * d, R * (.22 + r_() * .2), r_(), snowy); }
  /* the mouth: a dark throat going in */
  const mx = x + Math.cos(face) * R * .05, my = y + Math.sin(face) * R * .05, g = c.createRadialGradient(mx, my, R * .05, mx, my, R * .42);
  g.addColorStop(0, "rgba(4,4,6,1)"); g.addColorStop(.6, "rgba(16,14,14,.95)"); g.addColorStop(1, "rgba(30,26,24,0)");
  c.fillStyle = g; c.beginPath(); c.ellipse(mx, my, R * .42, R * .3, face + Math.PI / 2, 0, 7); c.fill();
  /* the jaws either side of the mouth */
  for (const side of [-1, 1]) for (let k = 0; k < 3; k++) { const a = face + side * (1.1 + k * .45), d = R * (.38 + k * .06); realRock(c, x + Math.cos(a) * d, y + Math.sin(a) * d, R * (.16 + r_() * .08), r_(), snowy); }
}
function realLog(c, x, y, L, W, ang, seed) {
  const dx = Math.cos(ang) * L / 2, dy = Math.sin(ang) * L / 2, nx = -Math.sin(ang), ny = Math.cos(ang);
  c.save(); c.shadowColor = "rgba(0,0,0,.45)"; c.shadowBlur = W * .6; c.shadowOffsetX = W * .35; c.shadowOffsetY = W * .4;
  c.strokeStyle = "#3a2a1a"; c.lineWidth = W; c.lineCap = "round"; c.beginPath(); c.moveTo(x - dx, y - dy); c.lineTo(x + dx, y + dy); c.stroke(); c.restore();
  const g = c.createLinearGradient(x - nx * W / 2, y - ny * W / 2, x + nx * W / 2, y + ny * W / 2); g.addColorStop(0, "#8a6a48"); g.addColorStop(.45, "#5e4630"); g.addColorStop(1, "#2e2216");
  c.strokeStyle = g; c.lineWidth = W * .92; c.beginPath(); c.moveTo(x - dx, y - dy); c.lineTo(x + dx, y + dy); c.stroke();
  c.strokeStyle = "rgba(30,20,12,.5)"; c.lineWidth = Math.max(1, W * .05);
  for (let k = 0; k < 5; k++) { const o = (k / 4 - .5) * W * .7, s = .1 + hash(k, Math.round(seed), 4) * .2; c.beginPath(); c.moveTo(x - dx * (1 - s) + nx * o, y - dy * (1 - s) + ny * o); c.lineTo(x + dx * (1 - s * 1.5) + nx * o, y + dy * (1 - s * 1.5) + ny * o); c.stroke(); }
  c.fillStyle = "rgba(84,110,46,.5)"; c.beginPath(); c.ellipse(x - dx * .2 - nx * W * .2, y - dy * .2 - ny * W * .2, L * .18, W * .25, ang, 0, 7); c.fill();
  c.fillStyle = "#b08a5a"; c.beginPath(); c.ellipse(x + dx, y + dy, W * .2, W * .46, ang, 0, 7); c.fill(); c.strokeStyle = "rgba(90,60,30,.6)"; c.beginPath(); c.ellipse(x + dx, y + dy, W * .1, W * .24, ang, 0, 7); c.stroke();
}
