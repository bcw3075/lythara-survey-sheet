/* Exploration carried between sheets. Foundry keeps one explored-area record per user per scene. This keeps a
   world-wide copy, in miles, of what the players' characters have seen, so a new sheet opens with that land
   already revealed. Only player accounts count: players see through their own characters, so this is the party's
   vision and nothing the GM looked at. */
import { CELL } from "./land.mjs";

const ID = "lythara-survey-sheet";
export const RES = 0.05, CHUNK = 4;          /* miles per cell, miles per saved chunk */
const N = Math.round(CHUNK / RES);           /* cells per chunk side */
const F = () => foundry.documents.FogExploration;

const store = () => game.settings.get(ID, "explored") ?? { version: 1, chunks: {}, harvested: {} };
const saveStore = s => game.settings.set(ID, "explored", s);
const key = (cx, cy) => cx + "," + cy;
const b64 = u8 => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const players = () => game.users.filter(u => !u.isGM);

/** Chunks as bit grids, loaded lazily and written back when changed. */
class Explored {
  constructor(s) { this.s = s; this.cache = new Map(); this.dirty = new Set(); }
  chunk(cx, cy, make) {
    const k = key(cx, cy); let c = this.cache.get(k);
    if (!c) { const packed = this.s.chunks[k]; if (!packed && !make) return null; c = packed ? unb64(packed) : new Uint8Array(N * N / 8); this.cache.set(k, c); }
    return c;
  }
  has(x, y) { const ci = Math.floor(x / RES), cj = Math.floor(y / RES), c = this.chunk(Math.floor(ci / N), Math.floor(cj / N)); if (!c) return false; const b = ((cj - Math.floor(cj / N) * N) * N + (ci - Math.floor(ci / N) * N)); return (c[b >> 3] >> (b & 7)) & 1; }
  mark(x, y) { const ci = Math.floor(x / RES), cj = Math.floor(y / RES), cx = Math.floor(ci / N), cy = Math.floor(cj / N), c = this.chunk(cx, cy, true), b = (cj - cy * N) * N + (ci - cx * N); const m = 1 << (b & 7); if (!(c[b >> 3] & m)) { c[b >> 3] |= m; this.dirty.add(key(cx, cy)); } }
  commit() { for (const k of this.dirty) this.s.chunks[k] = b64(this.cache.get(k)); const n = this.dirty.size; this.dirty.clear(); return n; }
  countCells() { let n = 0; for (const p of Object.values(this.s.chunks)) for (let v of unb64(p)) while (v) { n += v & 1; v >>= 1; } return n; }
  /** Every explored cell centre inside a world box, from the stored chunks. */
  *cells(x0, y0, x1, y1) {
    for (const k of Object.keys(this.s.chunks)) {
      const [cx, cy] = k.split(",").map(Number), bx = cx * CHUNK, by = cy * CHUNK;
      if (bx > x1 || bx + CHUNK < x0 || by > y1 || by + CHUNK < y0) continue;
      const c = this.chunk(cx, cy);
      for (let b = 0; b < N * N; b++) if ((c[b >> 3] >> (b & 7)) & 1) { const x = bx + ((b % N) + .5) * RES, y = by + (Math.floor(b / N) + .5) * RES; if (x >= x0 && x <= x1 && y >= y0 && y <= y1) yield [x, y]; }
    }
  }
}

/* A sheet's explored image covers the scene rect. Pixel (u, v) is at scene point rect.x + u / w * rect.width. */
async function imageOf(doc) { if (!doc?.explored) return null; const img = new Image(); img.src = doc.explored; await img.decode(); return img; }
const frameOf = scene => scene.getFlag(ID, "state")?.frame;
const geometry = scene => {
  const f = frameOf(scene), r = scene.dimensions.sceneRect;
  if (f) { const ppm = r.width / (f.x1 - f.x0); return { toWorld: (sx, sy) => ({ x: f.x0 + (sx - r.x) / ppm, y: f.y1 - (sy - r.y) / ppm }), toScene: (x, y) => ({ x: r.x + (x - f.x0) * ppm, y: r.y + (f.y1 - y) * ppm }), x0: f.x0, x1: f.x1, y0: f.y0, y1: f.y1 }; }
  const meta = game.settings.get(ID, "survey"); if (!meta || meta.sceneId !== scene.id) return null;
  const p = meta.pxPerMile, o = meta.originScene;
  return { toWorld: (sx, sy) => ({ x: (sx - o.x) / p, y: (o.y - sy) / p }), toScene: (x, y) => ({ x: o.x + x * p, y: o.y - y * p }), x0: (r.x - o.x) / p, x1: (r.x + r.width - o.x) / p, y0: (o.y - r.y - r.height) / p, y1: (o.y - r.y) / p };
};

/** Read the players' explored records on a scene into the world store. Returns how many chunks changed. */
export async function harvestScene(scene, { force = false } = {}) {
  const g = geometry(scene); if (!g) return 0;
  const s = store(), ex = new Explored(s), r = scene.dimensions.sceneRect, h = (s.harvested[scene.id] ??= {});
  const docs = await F().database.get(F(), { query: { scene: scene.id } });
  for (const d of docs) {
    const uid = d.user?.id ?? d.user, user = game.users.get(uid); if (!user || user.isGM) continue;
    if (!force && h[uid] && h[uid] >= (d.timestamp ?? 0)) continue;
    const img = await imageOf(d); if (!img) continue;
    const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
    const c = cv.getContext("2d", { willReadFrequently: true }); c.drawImage(img, 0, 0);
    const px = c.getImageData(0, 0, cv.width, cv.height).data;
    /* every explored pixel marks the world cells under it */
    const pw = r.width / cv.width, ph = r.height / cv.height;
    for (let v = 0; v < cv.height; v++) for (let u = 0; u < cv.width; u++) {
      const k = (v * cv.width + u) * 4; if (px[k] <= 8 && px[k + 1] <= 8 && px[k + 2] <= 8) continue;
      const a = g.toWorld(r.x + u * pw, r.y + v * ph), b = g.toWorld(r.x + (u + 1) * pw, r.y + (v + 1) * ph);
      for (let y = Math.floor(b.y / RES) * RES + RES / 2; y < a.y; y += RES) for (let x = Math.floor(a.x / RES) * RES + RES / 2; x < b.x; x += RES) ex.mark(x, y);
    }
    h[uid] = d.timestamp ?? Date.now();
  }
  const n = ex.commit();
  await saveStore(s);
  return n;
}

/** Write the world store into a scene's player records, so the land the party has walked is already revealed. */
export async function restoreScene(scene) {
  const g = geometry(scene); if (!g) return 0;
  const s = store(), ex = new Explored(s), r = scene.dimensions.sceneRect;
  const scale = Math.min(1, 4096 / Math.max(r.width, r.height)), W = Math.max(1, Math.round(r.width * scale)), H = Math.max(1, Math.round(r.height * scale));
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H; const c = cv.getContext("2d");
  c.fillStyle = "#000"; c.fillRect(0, 0, W, H); c.fillStyle = "#fff";
  let cells = 0; const ppm = r.width / (g.x1 - g.x0), cw = Math.max(1, Math.ceil(RES * ppm * scale));
  for (const [x, y] of ex.cells(g.x0, g.y0, g.x1, g.y1)) { const p = g.toScene(x - RES / 2, y + RES / 2); c.fillRect((p.x - r.x) * scale, (p.y - r.y) * scale, cw, cw); cells++; }
  if (!cells) return 0;
  const level = scene.levels.contents[0].id, docs = await F().database.get(F(), { query: { scene: scene.id } });
  for (const user of players()) {
    const own = docs.find(d => (d.user?.id ?? d.user) === user.id);
    const out = document.createElement("canvas"); out.width = W; out.height = H; const oc = out.getContext("2d");
    oc.fillStyle = "#000"; oc.fillRect(0, 0, W, H);
    const old = await imageOf(own); if (old) oc.drawImage(old, 0, 0, W, H);
    oc.drawImage(cv, 0, 0);
    const data = { explored: out.toDataURL("image/png"), timestamp: Date.now() };
    if (own) {
      /* records fetched by query aren't in the client collection unless this GM has viewed the scene, and update() refuses a document it can't find there */
      const coll = game.collections.get("FogExploration"); if (!coll.has(own.id)) coll.set(own.id, own);
      await own.update(data);
    } else await F().create({ scene: scene.id, level, user: user.id, ...data });
    const h = (s.harvested[scene.id] ??= {}); h[user.id] = data.timestamp;
  }
  await saveStore(s);
  if (canvas.scene?.id === scene.id) await canvas.fog.load();
  return cells;
}

/** All sheets and the World Map: read everything the players have seen, then write it back everywhere. */
export async function syncExploration({ restore = true } = {}) {
  const scenes = game.scenes.filter(s => geometry(s)), out = { harvested: 0, restored: [] };
  for (const s of scenes) out.harvested += await harvestScene(s);
  if (restore) for (const s of scenes) out.restored.push([s.name, await restoreScene(s)]);
  return out;
}

/** How much of the world the party has seen, in square miles. */
export function exploredArea() { return +(new Explored(store()).countCells() * RES * RES).toFixed(2); }
