import { PPM, renderMap } from "./render.mjs";
import { CELL, lineCourse, T as TERRAIN } from "./land.mjs";
import { classifyImage, surveyToPng, surveyFromPng, surveySlice, SURVEY_FILE, SURVEY_VERSION } from "./survey.mjs";
import { harvestScene, restoreScene, syncExploration, exploredArea } from "./explore.mjs";
import { planEncounter, drawEncounter, parseNotes, FT_PER_MI, SQ_FT } from "./encounter.mjs";

const ID = "lythara-survey-sheet";
const IMAGE_DIR = "assets/map-tools";
const PIN_FOLDER = "Survey Sheet Pins";
const KIND_ICON = { village: "icons/svg/village.svg", camp: `modules/${ID}/icons/camp.svg`, ruin: `modules/${ID}/icons/ruin.svg`, gate: `modules/${ID}/icons/gate.svg`, site: `modules/${ID}/icons/site.svg` };
const LINE_KINDS = ["creek", "river", "road", "track"];
const RENDER_VERSION = 8, MAX_PX = 16000, MARGIN = 3;
const PIN_STYLE = { hasBackground: false, alwaysShowTooltip: true, dropShadowEnabled: true, dropShadowColor: "#000000", dropShadowAlpha: 0.8, dropShadowDistance: 0, dropShadowBlur: 2, dropShadowAngle: 0, strokeColor: "#000000", strokeAlpha: 1, strokeThickness: 4 };

const FP = () => foundry.applications.apps.FilePicker.implementation;
const route = p => foundry.utils.getRoute(p);
let busy = false;

/* ---------- world data: one seed, one pin list, one set of lines and one paint store for the whole world ---------- */
const WORLD_DEFAULT = { version: 1, seed: 1147, origin: null, pins: [], lines: [], paint: "" };
const world = () => foundry.utils.mergeObject(foundry.utils.deepClone(WORLD_DEFAULT), game.settings.get(ID, "world") ?? {});
const saveWorld = w => game.settings.set(ID, "world", w);
const survey = () => game.settings.get(ID, "survey") ?? null;

/* ---------- checking what comes in ---------- */
/* Pin icons must be image files on this server, so pasted data can't make every player's browser load an outside address. */
const safeIcon = v => typeof v === "string" && v.length <= 200 && /^[\w][\w\- .%/]*\.(svg|webp|png|jpe?g|avif|gif)$/i.test(v) && !v.includes("..") && !v.includes("//") ? v : null;
const num = (v, lim) => { const n = Number(v); if (!Number.isFinite(n) || Math.abs(n) > lim) throw new Error("A position is damaged."); return +n.toFixed(3); };
function cleanPins(list) {
  if (!Array.isArray(list) || list.length > 300) throw new Error("The pin list is missing or too long.");
  return list.map(p => {
    if (typeof p?.id !== "string" || !/^[\w-]{1,60}$/.test(p.id)) throw new Error("A pin is damaged.");
    return { id: p.id, name: String(p.name ?? "Unnamed pin").slice(0, 120), kind: Object.hasOwn(KIND_ICON, p.kind) ? p.kind : "site", src: String(p.src ?? "").slice(0, 60), icon: safeIcon(p.icon), known: !!p.known, home: !!p.home, x: num(p.x, 20000), y: num(p.y, 20000) };
  });
}
function cleanLines(list) {
  if (!Array.isArray(list) || list.length > 200) throw new Error("The line list is missing or too long.");
  return list.map(l => {
    if (typeof l?.id !== "string" || !/^[\w-]{1,60}$/.test(l.id) || !Array.isArray(l.pts) || l.pts.length < 2 || l.pts.length > 400) throw new Error("A line is damaged.");
    return { id: l.id, kind: LINE_KINDS.includes(l.kind) ? l.kind : "track", name: String(l.name ?? "").slice(0, 120), pts: l.pts.map(p => ({ x: num(p?.x, 20000), y: num(p?.y, 20000) })) };
  });
}
function cleanPaint(text) {
  const paint = text ?? "";
  if (typeof paint !== "string" || paint.length > 4000000 || !/^[\d:*,;-]*$/.test(paint)) throw new Error("The painted terrain data is damaged.");
  return paint;
}
function cleanHexes(list) {
  if (!Array.isArray(list) || !list.length || list.length > 60) throw new Error("Pick between 1 and 60 hexes.");
  return list.map(h => { const i = Number(h?.i), j = Number(h?.j); if (!Number.isInteger(i) || !Number.isInteger(j)) throw new Error("A hex is damaged."); return { i, j }; });
}

/* ---------- the world map and its grid ---------- */
function mapGeometry() {
  const meta = survey();
  if (!meta) throw new Error("Survey the World Map first.");
  const grid = new foundry.grid.HexagonalGrid(meta.grid), ppm = meta.pxPerMile, o = meta.originScene;
  return {
    meta, grid, ppm,
    toWorld: p => ({ x: (p.x - o.x) / ppm, y: (o.y - p.y) / ppm }),
    toMap: p => ({ x: o.x + p.x * ppm, y: o.y - p.y * ppm }),
    hex(off) { const c = grid.getCenterPoint(off), v = grid.getVertices(off); return { i: off.i, j: off.j, center: this.toWorld(c), vertices: v.map(this.toWorld) }; }
  };
}

/** Mark a point on a map scene as the world origin. All sheet coordinates are miles from here. */
export async function setWorldOrigin(scene, x, y) {
  if (!game.user.isGM) throw new Error("Only a GM can do this.");
  const w = world(); w.origin = { sceneId: scene.id, x: num(x, 1e6), y: num(y, 1e6) }; await saveWorld(w);
  return w.origin;
}

/** Read the painted World Map and save one byte per mile for the whole world. */
export async function surveyWorldMap(scene, onProgress) {
  if (!game.user.isGM) throw new Error("Only a GM can do this.");
  const w = world();
  if (!w.origin || w.origin.sceneId !== scene.id) throw new Error("Set the world origin on this scene first.");
  if (scene.grid.type < 2) throw new Error("The World Map needs a hex grid.");
  const src = scene.levels?.contents?.[0]?.background?.src;
  if (!src) throw new Error("This scene has no map image.");
  const img = new Image(); img.src = route(src); await img.decode();
  const d = scene.dimensions, pxPerMile = scene.grid.size / scene.grid.distance;
  const sv = classifyImage(img, pxPerMile, onProgress);
  const blob = await surveyToPng(sv), file = new File([blob], SURVEY_FILE, { type: "image/png" });
  try { await FP().createDirectory("data", IMAGE_DIR); } catch (e) { /* already there */ }
  const up = await FP().upload("data", IMAGE_DIR, file, {}, { notify: false });
  if (!up?.path) throw new Error("Foundry refused the survey upload.");
  const P = Math.round(pxPerMile);
  const meta = { version: SURVEY_VERSION, path: up.path, pxPerMile, w: sv.w, h: sv.h, sceneId: scene.id, date: Date.now(),
    grid: { type: scene.grid.type, size: scene.grid.size, distance: scene.grid.distance, units: scene.grid.units },
    sceneRect: { x: d.sceneX, y: d.sceneY, width: d.sceneWidth, height: d.sceneHeight },
    originScene: { x: w.origin.x, y: w.origin.y },
    origin: { x: (w.origin.x - d.sceneX) / P, y: (w.origin.y - d.sceneY) / P } };
  await game.settings.set(ID, "survey", meta);
  surveyCache = null;
  return meta;
}
let surveyCache = null;
async function loadSurvey() {
  const meta = survey();
  if (!meta) throw new Error("Survey the World Map first.");
  if ((meta.version ?? 1) < SURVEY_VERSION) { const w = "The survey is from an older version and has no heights. Survey the World Map again from the Survey Sheet window."; if (!loadSurvey.warned) { loadSurvey.warned = true; ui.notifications?.warn(w); } }
  if (!surveyCache || surveyCache.path !== meta.path || surveyCache.date !== meta.date) surveyCache = { path: meta.path, date: meta.date, data: await surveyFromPng(route(meta.path) + "?v=" + meta.date) };
  return { meta, data: surveyCache.data };
}

/* ---------- sheets ---------- */
const snap = v => Math.round(v / CELL) * CELL;
function frameOfHexes(hexes, margin) {
  const g = mapGeometry(); let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const h of hexes) for (const v of g.hex(h).vertices) { x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y); }
  const frame = { x0: snap(x0 - margin), x1: snap(x1 + margin), y0: snap(y0 - margin), y1: snap(y1 + margin) };
  if ((frame.x1 - frame.x0) * PPM > MAX_PX || (frame.y1 - frame.y0) * PPM > MAX_PX) throw new Error(`That is too big for one sheet. Keep it under about ${Math.floor(MAX_PX / PPM)} miles across.`);
  return frame;
}
const rectOf = scene => scene.dimensions.sceneRect;
const toScene = (scene, x, y) => { const f = scene.getFlag(ID, "state").frame, r = rectOf(scene); return { x: Math.round(r.x + (x - f.x0) * PPM), y: Math.round(r.y + (f.y1 - y) * PPM) }; };
const toMiles = (scene, sx, sy) => { const f = scene.getFlag(ID, "state").frame, r = rectOf(scene); return { x: +(f.x0 + (sx - r.x) / PPM).toFixed(3), y: +(f.y1 - (sy - r.y) / PPM).toFixed(3) }; };
const inFrame = (f, p, m = 0) => p.x >= f.x0 - m && p.x <= f.x1 + m && p.y >= f.y0 - m && p.y <= f.y1 + m;
const sheetScenes = () => game.scenes.filter(s => s.getFlag(ID, "state")?.frame);

/** Make a new sheet scene from hexes picked on the World Map. */
export async function createSheet({ hexes, name, margin = MARGIN, link = true } = {}) {
  if (!game.user.isGM) throw new Error("Only a GM can make a sheet.");
  hexes = cleanHexes(hexes);
  const frame = frameOfHexes(hexes, Math.max(0, Math.min(20, Number(margin) || 0)));
  const g = mapGeometry();
  name = String(name ?? "").trim().slice(0, 120);
  if (!name) throw new Error("Give the sheet its region name first (the name field above the button).");
  if (sheetScenes().some(s => s.name.toLowerCase() === name.toLowerCase())) throw new Error(`There is already a sheet called ${name}.`);
  const scene = await Scene.create({
    name, folder: (await sheetFolder()).id, navigation: game.settings.get(ID, "sheetNav"),
    width: Math.round((frame.x1 - frame.x0) * PPM), height: Math.round((frame.y1 - frame.y0) * PPM), padding: 0.05,
    grid: { type: 2, size: PPM, distance: 1, units: "mi", alpha: 0.12 }, tokenVision: true, fog: { mode: 2 },
    environment: { globalLight: { enabled: false } }, flags: { pf2e: { rulesBasedVision: false }, [ID]: { state: { version: 1, frame, hexes: hexes.map(h => ({ ...h, center: g.hex(h).center })), rev: null } } }
  });
  const r = await renderSheet(scene, { force: true });
  if (link && g.meta.sceneId) await linkOnMap(scene, frame, g);
  await linkSheets();
  /* the party arrives with the land it has already walked revealed */
  let explored = 0, party = false;
  try { await syncExploration({ restore: false }); explored = await restoreScene(scene); } catch (e) { console.warn(`${ID} | exploration not carried over`, e); }
  try { party = await placePartyOnNewSheet(scene); } catch (e) { console.warn(`${ID} | party token not placed`, e); }
  return { ok: true, scene: scene.id, name: scene.name, frame, explored, party, ...r };
}
const SHEET_FOLDER = "Overland Sheets";
async function sheetFolder() {
  return game.folders.find(f => f.type === "Scene" && f.name === SHEET_FOLDER) ?? Folder.create({ name: SHEET_FOLDER, type: "Scene" });
}
/** Put every sheet in the Overland Sheets folder and set whether sheets show in the navigation bar. */
export async function organizeSheets() {
  const folder = await sheetFolder(), nav = game.settings.get(ID, "sheetNav"), updates = [];
  for (const s of sheetScenes()) if (s.folder?.id !== folder.id || s.navigation !== nav) updates.push({ _id: s.id, folder: folder.id, navigation: nav });
  if (updates.length) await Scene.updateDocuments(updates);
  return { moved: updates.length, folder: folder.name };
}

/* ---------- gates between sheets ----------
   Where one sheet runs past the edge of another, a strip half a mile wide along that edge teleports tokens onto the other
   sheet at the same place in the world (a landing region, plain, on the far sheet). Walking off the east edge of one sheet
   puts the party on the next sheet east, where it was heading. Teleport arrivals land just outside the landing strip, so a
   gate back the other way does not fire on arrival (checked on 14.369). */
const GATE_W = .5, SIDES = [["east", "x1"], ["west", "x0"], ["north", "y1"], ["south", "y0"]];
function gateRects(A, B) {
  /* strips on sheet A's edges where sheet B continues beyond; each with the matching landing rect on B */
  const out = [], ix0 = Math.max(A.x0, B.x0), ix1 = Math.min(A.x1, B.x1), iy0 = Math.max(A.y0, B.y0), iy1 = Math.min(A.y1, B.y1);
  if (ix1 - ix0 < .5 || iy1 - iy0 < .5) return out;             /* the sheets do not share enough ground for a gate */
  const shift = (edge, far) => Math.abs(edge - far) < 2 * GATE_W;  /* overlap thinner than a mile: land just past the far sheet's own gate */
  if (B.x1 > A.x1 + 1e-6) out.push({ side: "east", gate: { x0: A.x1 - GATE_W, x1: A.x1, y0: iy0, y1: iy1 }, land: shift(A.x1, B.x0) ? { x0: B.x0 + GATE_W, x1: B.x0 + 2 * GATE_W, y0: iy0, y1: iy1 } : { x0: A.x1 - GATE_W, x1: A.x1, y0: iy0, y1: iy1 } });
  if (B.x0 < A.x0 - 1e-6) out.push({ side: "west", gate: { x0: A.x0, x1: A.x0 + GATE_W, y0: iy0, y1: iy1 }, land: shift(A.x0, B.x1) ? { x0: B.x1 - 2 * GATE_W, x1: B.x1 - GATE_W, y0: iy0, y1: iy1 } : { x0: A.x0, x1: A.x0 + GATE_W, y0: iy0, y1: iy1 } });
  if (B.y1 > A.y1 + 1e-6) out.push({ side: "north", gate: { x0: ix0, x1: ix1, y0: A.y1 - GATE_W, y1: A.y1 }, land: shift(A.y1, B.y0) ? { x0: ix0, x1: ix1, y0: B.y0 + GATE_W, y1: B.y0 + 2 * GATE_W } : { x0: ix0, x1: ix1, y0: A.y1 - GATE_W, y1: A.y1 } });
  if (B.y0 < A.y0 - 1e-6) out.push({ side: "south", gate: { x0: ix0, x1: ix1, y0: A.y0, y1: A.y0 + GATE_W }, land: shift(A.y0, B.y1) ? { x0: ix0, x1: ix1, y0: B.y1 - 2 * GATE_W, y1: B.y1 - GATE_W } : { x0: ix0, x1: ix1, y0: A.y0, y1: A.y0 + GATE_W } });
  return out;
}
const rectShape = (scene, r) => { const p = toScene(scene, r.x0, r.y1), q = toScene(scene, r.x1, r.y0); return { type: "rectangle", x: p.x, y: p.y, width: q.x - p.x, height: q.y - p.y, rotation: 0, hole: false }; };
/** Rebuild the gates between every pair of sheets. Safe to run any time; it removes the old gates first. */
export async function linkSheets() {
  if (!game.user.isGM) throw new Error("Only a GM can link sheets.");
  const sheets = sheetScenes();
  for (const s of sheets) { const ids = s.regions.filter(r => r.getFlag(ID, "gate")).map(r => r.id); if (ids.length) await s.deleteEmbeddedDocuments("Region", ids); }
  let gates = 0;
  for (const A of sheets) for (const B of sheets) {
    if (A === B) continue;
    const fa = A.getFlag(ID, "state").frame, fb = B.getFlag(ID, "state").frame;
    for (const g of gateRects(fa, fb)) {
      const [land] = await B.createEmbeddedDocuments("Region", [{ name: `Landing from ${A.name}`, color: "#c9a227", visibility: CONST.REGION_VISIBILITY.LAYER, shapes: [rectShape(B, g.land)], flags: { [ID]: { gate: { kind: "landing", from: A.id, side: g.side } } } }]);
      const [gate] = await A.createEmbeddedDocuments("Region", [{ name: `${g.side[0].toUpperCase() + g.side.slice(1)} to ${B.name}`, color: "#c9a227", visibility: CONST.REGION_VISIBILITY.LAYER, shapes: [rectShape(A, g.gate)], flags: { [ID]: { gate: { kind: "gate", to: B.id, side: g.side } } } }]);
      await gate.createEmbeddedDocuments("RegionBehavior", [{ name: `To ${B.name}`, type: "teleportToken", system: { destinations: [land.uuid], placement: "relative", snap: false, choice: false, revealed: true, transition: { type: "fade", duration: 800 } } }]);
      gates++;
    }
  }
  return { sheets: sheets.length, gates };
}
Hooks.on("deleteScene", (scene, opts, userId) => { if (userId === game.user.id && game.user.isGM && scene.getFlag(ID, "state")?.frame) linkSheets().catch(e => console.warn(`${ID} | gates`, e)); });

/* ---------- the party marker on the World Map ----------
   The PF2e party actor's token on the World Map is the party's marker. Its members' tokens on the sheets are the party itself.
   When a member moves on a sheet (or arrives through a gate), the marker is put at the centre of the members on that sheet.
   When the marker is dragged on the World Map onto ground some sheet covers, the members are moved there in formation,
   changing sheet if they have to. Only the active GM does the moving; echoes carry a sync flag and are ignored. */
const SYNC = "sync", isActiveGM = () => game.users.activeGM?.id === game.user.id;
const partyActor = () => game.actors.find(a => a.type === "party" && a.members?.length) ?? game.actors.find(a => a.type === "party");
const memberIds = party => new Set((party?.members ?? []).map(m => m.id));
/* pos may carry the new x/y from an update's change, which on the client that started a drag can be ahead of the document */
const tokenCentre = (t, pos = t) => ({ x: (pos.x ?? t.x) + (t.width ?? 1) * (t.parent.grid.sizeX ?? t.parent.grid.size) / 2, y: (pos.y ?? t.y) + (t.height ?? 1) * (t.parent.grid.sizeY ?? t.parent.grid.size) / 2 });
const placeAt = (t, c, scene = t.parent) => ({ x: Math.round(c.x - (t.width ?? 1) * (scene.grid.sizeX ?? scene.grid.size) / 2), y: Math.round(c.y - (t.height ?? 1) * (scene.grid.sizeY ?? scene.grid.size) / 2) });
/* the party on a sheet: its party token if it has one, else its members' tokens */
const partyOn = (scene, party) => { const own = scene.tokens.filter(t => t.actorId === party.id); return own.length ? own : scene.tokens.filter(t => memberIds(party).has(t.actorId)); };
const centroid = (toks, moved) => { const c = toks.map(t => tokenCentre(t, moved?.id === t.id ? moved : t)); return { x: c.reduce((a, p) => a + p.x, 0) / c.length, y: c.reduce((a, p) => a + p.y, 0) / c.length }; };
async function markerFollow(scene, moved) {
  const party = partyActor(), meta = survey(); if (!party || !meta?.sceneId) return;
  const map = game.scenes.get(meta.sceneId); if (!map) return;
  const toks = partyOn(scene, party); if (!toks.length) return;
  const g = mapGeometry(), c = centroid(toks, moved), w = toMiles(scene, c.x, c.y), at = g.toMap(w);
  let marker = map.tokens.find(t => t.actorId === party.id);
  if (!marker) { const data = (await party.getTokenDocument({ x: 0, y: 0 })).toObject(); Object.assign(data, placeAt(data, at, map)); await map.createEmbeddedDocuments("Token", [data], { [ID]: { [SYNC]: true } }); }
  else { const pos = placeAt(marker, at); if (Math.abs(pos.x - marker.x) >= 1 || Math.abs(pos.y - marker.y) >= 1) await marker.update(pos, { animate: false, [ID]: { [SYNC]: true } }); }
  if (scene.tokens.some(t => t.actorId === party.id)) await syncPartyTokens(w, party, scene);   /* the party token moved: every other sheet covering the spot gets it too */
}
/** Put a fresh party token on a sheet at a scene point. */
async function placeParty(scene, party, at) {
  const data = (await party.getTokenDocument({ x: 0, y: 0 })).toObject(); Object.assign(data, placeAt(data, at, scene));
  await scene.createEmbeddedDocuments("Token", [data], { [ID]: { [SYNC]: true } });
}
/* a scene point inside one of this sheet's gate strips: a party token put there would be bounced to the next sheet */
const inGate = (scene, p) => scene.regions.some(r => r.getFlag(ID, "gate")?.kind === "gate" && r.shapes.some(sh => sh.type === "rectangle" && p.x >= sh.x && p.x <= sh.x + sh.width && p.y >= sh.y && p.y <= sh.y + sh.height));
/** The party token is on every sheet whose ground holds the party's world point, and on no other. origin is a sheet already right. */
async function syncPartyTokens(w, party, origin) {
  for (const s of sheetScenes()) {
    if (s === origin) continue;
    const own = s.tokens.filter(t => t.actorId === party.id), covers = inFrame(s.getFlag(ID, "state").frame, w);
    if (!covers) { if (own.length) await s.deleteEmbeddedDocuments("Token", own.map(t => t.id), { [ID]: { [SYNC]: true } }); continue; }
    const at = toScene(s, w.x, w.y);
    if (inGate(s, at)) continue;
    if (!own.length) { await placeParty(s, party, at); continue; }
    const pos = placeAt(own[0], at);
    if (Math.abs(pos.x - own[0].x) >= 1 || Math.abs(pos.y - own[0].y) >= 1) await own[0].update(pos, { animate: false, [ID]: { [SYNC]: true } });
    if (own.length > 1) await s.deleteEmbeddedDocuments("Token", own.slice(1).map(t => t.id), { [ID]: { [SYNC]: true } });
  }
}
/** When a sheet is made, the party token appears on it if the party's marker is inside the frame. */
async function placePartyOnNewSheet(scene) {
  const party = partyActor(), meta = survey(); if (!party || !meta?.sceneId) return false;
  const marker = game.scenes.get(meta.sceneId)?.tokens.find(t => t.actorId === party.id); if (!marker) return false;
  const w = mapGeometry().toWorld(tokenCentre(marker)); if (!inFrame(scene.getFlag(ID, "state").frame, w)) return false;
  if (scene.tokens.some(t => t.actorId === party.id)) return false;
  await placeParty(scene, party, toScene(scene, w.x, w.y)); return true;
}
async function partyFollowMarker(marker, pos) {
  const party = partyActor(), meta = survey(); if (!party || !meta?.sceneId || marker.parent.id !== meta.sceneId || marker.actorId !== party.id) return;
  const g = mapGeometry(), w = g.toWorld(tokenCentre(marker, pos)), ids = memberIds(party);
  const sheets = sheetScenes(), here = sheets.filter(s => inFrame(s.getFlag(ID, "state").frame, w)); if (!here.length) return;   /* dropped on ground no sheet covers */
  /* the members go to one sheet: the covering sheet they are already on, else the active scene, else the nearest-centred */
  const near = s => { const f = s.getFlag(ID, "state").frame; return Math.hypot((f.x0 + f.x1) / 2 - w.x, (f.y0 + f.y1) / 2 - w.y); };
  const members = sheets.flatMap(s => s.tokens.filter(t => ids.has(t.actorId)).map(t => ({ t, s })));
  const target = here.find(s => members.some(m => m.s === s)) ?? here.find(s => s.active) ?? here.slice().sort((a, b) => near(a) - near(b))[0];
  const dest = toScene(target, w.x, w.y);
  /* members keep their offsets from the party token on their own sheet (or from their centre), measured before anything moves */
  /* a marker drag gathers the party: a member more than half a mile from the party token is pulled in to half a mile, same bearing */
  const gather = (tc, c, s) => { const dx = tc.x - c.x, dy = tc.y - c.y, d = Math.hypot(dx, dy), lim = .5 * (s.grid.size ?? PPM); return d > lim ? { x: c.x + dx / d * lim, y: c.y + dy / d * lim } : tc; };
  const groups = [...new Set(members.map(m => m.s))].map(s => { const toks = members.filter(m => m.s === s).map(m => m.t), anchor = s.tokens.find(t => t.actorId === party.id), c = anchor ? tokenCentre(anchor) : centroid(toks); return { s, toks, c, from: toks.map(t => gather(tokenCentre(t), c, s)) }; });
  /* party tokens: one on every covering sheet, none elsewhere */
  await syncPartyTokens(w, party);
  for (const { s, toks, c, from } of groups) {
    if (s === target) {
      const updates = toks.map((t, i) => { const tc = from[i]; return { _id: t.id, ...placeAt(t, { x: dest.x + tc.x - c.x, y: dest.y + tc.y - c.y }) }; });
      await s.updateEmbeddedDocuments("Token", updates, { animate: false, [ID]: { [SYNC]: true } });
    } else {
      const k = (target.grid.size ?? PPM) / (s.grid.size ?? PPM);
      const creates = toks.map((t, i) => { const d = t.toObject(); delete d._id; const tc = from[i]; Object.assign(d, placeAt(d, { x: dest.x + (tc.x - c.x) * k, y: dest.y + (tc.y - c.y) * k }, target)); return d; });
      await target.createEmbeddedDocuments("Token", creates, { [ID]: { [SYNC]: true } });
      await s.deleteEmbeddedDocuments("Token", toks.map(t => t.id), { [ID]: { [SYNC]: true } });
      const owners = game.users.filter(u => u.active && !u.isGM && toks.some(t => t.actor?.testUserPermission(u, "OWNER")));
      if (owners.length) await target.pullUsers?.(owners);
    }
  }
}
Hooks.on("updateToken", (tok, change, opts) => {
  if (!isActiveGM() || opts?.[ID]?.[SYNC] || !("x" in change || "y" in change)) return;
  const pos = { id: tok.id, x: change.x ?? tok.x, y: change.y ?? tok.y };
  const task = tok.parent.getFlag(ID, "state")?.frame ? markerFollow(tok.parent, pos) : partyFollowMarker(tok, pos);
  task.catch(e => console.warn(`${ID} | party marker`, e));
});
Hooks.on("createToken", (tok, opts) => {   /* a member arriving on a sheet through a gate */
  if (!isActiveGM() || opts?.[ID]?.[SYNC] || !tok.parent.getFlag(ID, "state")?.frame) return;
  markerFollow(tok.parent).catch(e => console.warn(`${ID} | party marker`, e));
});

/** A pin on the World Map that opens the sheet. */
async function linkOnMap(scene, frame, g) {
  const map = game.scenes.get(g.meta.sceneId); if (!map) return;
  const c = g.toMap({ x: (frame.x0 + frame.x1) / 2, y: (frame.y0 + frame.y1) / 2 });
  const entry = await JournalEntry.create({ name: scene.name, folder: (await pinFolder()).id, ownership: { default: 0 }, flags: { [ID]: { managed: true, sheet: scene.id } },
    pages: [{ name: scene.name, type: "text", text: { content: `<p>@UUID[Scene.${scene.id}]{${scene.name}}</p>`, format: 1 } }] });
  await map.createEmbeddedDocuments("Note", [{ x: Math.round(c.x), y: Math.round(c.y), entryId: entry.id, text: scene.name, global: true, iconSize: 32, fontSize: 12, textColor: "#ffffff", texture: { src: `modules/${ID}/icons/site.svg` }, flags: { [ID]: { sheet: scene.id }, "more-pin-options": PIN_STYLE } }]);
}

/** Draw a sheet's land from the world data. Skips the image when nothing that shapes land has changed. */
export async function renderSheet(scene, { force = false } = {}) {
  if (!game.user.isGM) throw new Error("Only a GM can update the map.");
  const st = scene.getFlag(ID, "state"); if (!st?.frame) throw new Error("That scene is not a sheet.");
  const w = world(), { meta, data } = await loadSurvey();
  const slice = surveySlice(data, meta, st.frame), villages = w.pins.filter(p => p.kind === "village" && inFrame(st.frame, p, 12));
  const key = JSON.stringify([RENDER_VERSION, meta.date, w.seed, st.frame, w.paint, w.lines, villages]);
  let map;
  if (!force && st.renderKey === key) map = { fingerprint: st.fingerprint, skipped: true };
  else {
    const R = renderMap({ seed: w.seed, frame: st.frame, slice, paint: w.paint, lines: w.lines, pins: w.pins });
    const blob = await new Promise(res => R.canvas.toBlob(res, "image/webp", 0.82));
    if (!blob) throw new Error("This browser couldn't make the map image.");
    try { await FP().createDirectory("data", IMAGE_DIR); } catch (e) { /* already there */ }
    const slot = st.slot === "a" ? "b" : "a", rev = foundry.utils.randomID(8);
    const up = await FP().upload("data", IMAGE_DIR, new File([blob], `${scene.id}-${slot}.webp`, { type: "image/webp" }), {}, { notify: false });
    if (!up?.path) throw new Error("Foundry refused the map upload. Check this user can upload files.");
    await scene.levels.contents[0].update({ background: { src: `${up.path}?v=${rev}` } });
    map = { fingerprint: R.fingerprint, bytes: blob.size, rev, slot };
  }
  const pins = await syncPins(scene, w.pins.filter(p => inFrame(st.frame, p)));
  await scene.setFlag(ID, "state", { ...st, renderKey: key, rev: map.rev ?? st.rev, slot: map.slot ?? st.slot, fingerprint: map.fingerprint, slice: slice.data, sliceBox: { x0: slice.x0, y1: slice.y1, w: slice.w, h: slice.h } });
  if (canvas.scene?.id === scene.id) queueLayout();
  return { map, pins };
}

/* ---------- pins ---------- */
async function pinFolder() {
  return game.folders.find(f => f.type === "JournalEntry" && f.name === PIN_FOLDER) ?? Folder.create({ name: PIN_FOLDER, type: "JournalEntry" });
}
async function syncPins(scene, pins) {
  const notes = scene.notes.contents, seen = new Set(), creates = [], updates = [], folder = await pinFolder();
  for (const p of pins) {
    seen.add(p.id);
    const note = notes.find(n => n.getFlag(ID, "pinId") === p.id), at = toScene(scene, p.x, p.y);
    if (note) {
      updates.push({ _id: note.id, ...at, text: p.name, "texture.src": p.icon || KIND_ICON[p.kind] });
      if (note.entry?.getFlag(ID, "managed")) await note.entry.update({ name: p.name, "ownership.default": p.known ? 1 : 0 });
    } else {
      const entry = game.journal.find(j => j.getFlag(ID, "pinId") === p.id) ?? await JournalEntry.create({ name: p.name, folder: folder.id, ownership: { default: p.known ? 1 : 0 }, flags: { [ID]: { managed: true, pinId: p.id } }, pages: [{ name: p.name, type: "text", text: { content: "", format: 1 } }] });
      creates.push({ ...at, entryId: entry.id, text: p.name, global: true, iconSize: 180, fontSize: 48, textColor: "#ffffff", textAnchor: CONST.TEXT_ANCHOR_POINTS.BOTTOM, texture: { src: p.icon || KIND_ICON[p.kind] }, flags: { [ID]: { pinId: p.id }, "more-pin-options": PIN_STYLE } });
    }
  }
  const removed = notes.filter(n => n.getFlag(ID, "pinId") && !seen.has(n.getFlag(ID, "pinId"))).map(n => n.id);
  if (creates.length) await scene.createEmbeddedDocuments("Note", creates, { lssSync: true });
  if (updates.length) await scene.updateEmbeddedDocuments("Note", updates, { lssSync: true });
  if (removed.length) await scene.deleteEmbeddedDocuments("Note", removed, { lssSync: true });
  if (canvas.scene?.id === scene.id) for (const n of canvas.notes.placeables) await n.draw();
  return { created: creates.length, updated: updates.length, removed: removed.length };
}
/* A pin dragged on any sheet moves in the world, and so on every other sheet that shows it. */
Hooks.on("updateNote", async (doc, change, opts, userId) => {
  if (opts.lssSync || !game.users.activeGM?.isSelf || !("x" in change || "y" in change)) return;
  const pinId = doc.getFlag(ID, "pinId"), scene = doc.parent; if (!pinId || !scene?.getFlag(ID, "state")?.frame) return;
  const w = world(), pin = w.pins.find(p => p.id === pinId); if (!pin) return;
  const m = toMiles(scene, doc.x, doc.y); if (Math.abs(m.x - pin.x) < .001 && Math.abs(m.y - pin.y) < .001) return;
  pin.x = m.x; pin.y = m.y; await saveWorld(w);
  for (const other of sheetScenes()) if (other.id !== scene.id) await syncPins(other, w.pins.filter(p => inFrame(other.getFlag(ID, "state").frame, p)));
});

/* ---------- the two jobs the Survey Sheet artifact uses ---------- */
/** Take sheet data (pins, lines, paint, seed) into the world and redraw the sheets it changes. */
export async function applySheet(raw, sceneArg) {
  if (!game.user.isGM) throw new Error("Only a GM can update the map.");
  if (busy) throw new Error("An update is already running.");
  busy = true;
  try {
    if (!raw || typeof raw !== "object") throw new Error("That isn't Survey Sheet data.");
    const w = world();
    if (raw.seed !== undefined) { const seed = Number(raw.seed); if (!Number.isInteger(seed)) throw new Error("The seed must be a whole number."); w.seed = seed; }
    if (raw.pins !== undefined) w.pins = cleanPins(raw.pins);
    if (raw.lines !== undefined) w.lines = cleanLines(raw.lines);
    if (raw.paint !== undefined) w.paint = cleanPaint(raw.paint);
    await saveWorld(w);
    const scenes = sceneArg ? [sceneArg] : sheetScenes(), results = [];
    for (const s of scenes) results.push({ scene: s.id, name: s.name, ...(await renderSheet(s)) });
    return { ok: true, sheets: results };
  } finally { busy = false; }
}
/** Everything the Survey Sheet artifact needs to show and edit a sheet. */
export function exportSheet(sceneArg) {
  if (!game.user.isGM) throw new Error("Only a GM can read the sheet data.");
  const scene = sceneArg ?? (canvas.scene?.getFlag(ID, "state")?.frame ? canvas.scene : sheetScenes()[0]);
  if (!scene) throw new Error("No sheet exists yet.");
  const st = scene.getFlag(ID, "state"), w = world();
  const meta = survey(), hexR = meta ? +(new foundry.grid.HexagonalGrid(meta.grid).sizeY / 2 / meta.pxPerMile).toFixed(4) : undefined;
  return { ok: true, scene: scene.id, name: scene.name, frame: st.frame, hexes: st.hexes, hexR, slice: { ...st.sliceBox, data: st.slice }, seed: w.seed, paint: w.paint, lines: w.lines, pins: w.pins, rev: st.rev, fingerprint: st.fingerprint };
}

/* ---------- picking hexes on the World Map ---------- */
const picked = new Map(); let pickGfx = null, pickHandler = null;
function pickKey(o) { return o.i + "," + o.j; }
function drawPicked() {
  if (!canvas.ready) return;
  if (!pickGfx || pickGfx.destroyed) { pickGfx = new PIXI.Graphics(); canvas.interface.addChild(pickGfx); }
  pickGfx.clear();
  if (!isWorldMap(canvas.scene)) return;
  for (const o of picked.values()) {
    const v = canvas.grid.getVertices(o);
    pickGfx.lineStyle(3 / canvas.stage.scale.x, 0xffd166, 1); pickGfx.beginFill(0xffd166, .18); pickGfx.drawPolygon(v.flatMap(p => [p.x, p.y])); pickGfx.endFill();
  }
}
const isWorldMap = scene => !!scene && scene.id === survey()?.sceneId;
function setPicking(on) {
  if (pickHandler) { canvas.stage.off("pointerdown", pickHandler); pickHandler = null; }
  if (!on) return;
  pickHandler = ev => {
    if (ev.button !== 0 || !isWorldMap(canvas.scene) || ui.controls.tool?.name !== "pickHexes") return;
    const o = canvas.grid.getOffset(ev.getLocalPosition(canvas.stage)), k = pickKey(o);
    if (picked.has(k)) picked.delete(k); else picked.set(k, { i: o.i, j: o.j });
    drawPicked();
    ui.notifications.info(`${picked.size} hex${picked.size === 1 ? "" : "es"} picked. Use the Survey Sheet window to make the sheet.`);
  };
  canvas.stage.on("pointerdown", pickHandler);
}

/* ---------- placing an encounter map by clicking a spot on a sheet or the World Map ---------- */
let encHandler = null;
const TUNE_LABELS = [["trees", "Tree cover", "clearing", "dense"], ["brush", "Rough going", "easy", "hard"], ["rocks", "Rocks", "none", "boulder field"],
  ["water", "Water", "narrower", "wider"], ["relief", "Elevation", "flat", "hilly"], ["decay", "Growth", "blighted", "lush"]];
/** The world point (miles) under a click on a sheet or the World Map, or null on any other scene. */
function worldPointAt(scene, p) {
  if (scene?.getFlag(ID, "state")?.frame) return toMiles(scene, p.x, p.y);
  if (isWorldMap(scene)) { const w = mapGeometry().toWorld(p); return { x: +w.x.toFixed(3), y: +w.y.toFixed(3) }; }
  return null;
}
/* What you see is what you get. Sheet trees are drawn side-on, standing on their ground, so a crown shows up to ~.35 mi north
   of where the tree grows. A click on a crown (not forest underneath, forest just south) is moved to the trees' ground, onto
   the wood's edge, so the map shows the edge. Also names the ground at the spot for the dialog. */
const GROUND_NAMES = { 0: "fields", 1: "open rough ground", 2: "woods", 3: "old growth", 4: "damp low ground", 5: "water", 6: "hills", 7: "bad ground", 8: "bare crag", 9: "snowfield" };
/* Fuzzy match: what does the sheet show around the cursor, and where nearby does an encounter map have that same mix?
   Ground is grouped as woods / snow / crag / water / open. On a sheet a spot counts as woods if a tree's crown is drawn over it
   (crowns stand up to ~.3 mi north of their ground). Candidate centres within ~half a mile are scored on how closely the map's
   ground mix matches, plus a little for distance; if the mix can't fit in the chosen size, bigger maps are tried. */
const GROUP = t => t === TERRAIN.woods || t === TERRAIN.old ? "woods" : t === TERRAIN.snow ? "snow" : t === TERRAIN.crag || t === TERRAIN.bad ? "crag" : t === TERRAIN.water ? "water" : "open";
/* the sheet picture's mix around a world point: tree green, snow white, crag grey, water blue, open tan (ink and shadow skipped) */
const sheetImgs = new Map();
async function sheetImage(scene) {
  if (!scene?.getFlag(ID, "state")?.frame) return null;
  const src = scene.levels.contents[0]?.background?.src; if (!src) return null;
  let img = sheetImgs.get(src); if (!img) { img = new Image(); img.src = route(src.split("?")[0]) + "?" + (src.split("?")[1] ?? ""); await img.decode(); sheetImgs.clear(); sheetImgs.set(src, img); }
  return img;
}
/* one pixel of the sheet picture: what ground it shows (null for ink and shadow) */
const pixClass = (r, gg, b) => { const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), L = (r + gg + b) / 3, sat = mx ? (mx - mn) / mx : 0;
  if (L < 70) return null; return b > r + 12 && b >= gg - 4 ? "water" : gg >= r - 2 && gg - b > 22 ? "woods" : sat < .14 ? (L > 175 ? "snow" : "crag") : "open"; };
/* the sheet picture around a world point, half-size R miles: pixels and where they sit */
async function sheetPatch(scene, w, R) {
  const img = await sheetImage(scene); if (!img) return null;
  const f = scene.getFlag(ID, "state").frame, px = Math.round((w.x - f.x0) * PPM), py = Math.round((f.y1 - w.y) * PPM), n = Math.ceil(R * PPM), N = 2 * n + 1;
  const c = document.createElement("canvas"); c.width = c.height = N; const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(img, px - n, py - n, N, N, 0, 0, N, N);
  return { d: g.getImageData(0, 0, N, N).data, N, x0: f.x0 + (px - n) / PPM, y1: f.y1 - (py - n) / PPM };
}
async function sheetMix(scene, w, R) {
  try {
    const P = await sheetPatch(scene, w, R); if (!P) return null; const m = {}; let tot = 0;
    for (let k = 0; k < P.d.length; k += 4) { const t = pixClass(P.d[k], P.d[k + 1], P.d[k + 2]); if (!t) continue; m[t] = (m[t] ?? 0) + 1; tot++; }
    if (!tot) return null; for (const k in m) m[k] /= tot; return m;
  } catch (e) { console.warn(`${ID} | sheet mix`, e); return null; }
}
/* What you see is what you get: where the sheet picture shows tree crowns around an encounter (crowns are drawn standing up to
   ~.3 mi north of their ground, over rough ground or snow). A 0/1 grid, one cell per picture pixel (~35 ft), kept on the scene. */
async function sheetCover(scene, cx, cy, cols, rows) {
  try {
    const R = Math.max(cols, rows) * SQ_FT / FT_PER_MI / 2 + .04, P = await sheetPatch(scene, { x: cx, y: cy }, R); if (!P) return null;
    let b = "", any = 0; for (let k = 0; k < P.d.length; k += 4) { const w = pixClass(P.d[k], P.d[k + 1], P.d[k + 2]) === "woods" ? 1 : 0; any += w; b += w; }
    return any ? { x0: +P.x0.toFixed(5), y1: +P.y1.toFixed(5), ppm: PPM, n: P.N, b } : null;
  } catch (e) { console.warn(`${ID} | sheet cover`, e); return null; }
}
async function groundAt(scene, w, cols = 40, rows = 40) {
  try {
    const plan = planEncounter(await encounterInput(w.x, w.y, 10, 10), { cx: w.x, cy: w.y, cols: 10, rows: 10 });
    /* on a sheet the map grows trees wherever the picture shows crowns, so candidates count those as woods too */
    const P = await sheetPatch(scene, w, .6).catch(() => null), picWoods = (x, y) => { if (!P) return false; const i = Math.floor((x - P.x0) * PPM), j = Math.floor((P.y1 - y) * PPM);
      if (i < 0 || j < 0 || i >= P.N || j >= P.N) return false; const k = (j * P.N + i) * 4; return pixClass(P.d[k], P.d[k + 1], P.d[k + 2]) === "woods"; };
    const tAt = (x, y) => plan.terrainAt(x, y), grp = (x, y) => picWoods(x, y) ? "woods" : GROUP(tAt(x, y));
    const mixOf = (fn, cx, cy, half, n) => { const m = {}; for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) { const g = fn(cx + (a / (n - 1) - .5) * 2 * half, cy + (b / (n - 1) - .5) * 2 * half); m[g] = (m[g] ?? 0) + 1 / (n * n); } return m; };
    /* what you see: on a sheet, the picture itself around the cursor (~700 ft across); elsewhere, the land */
    const target = (scene.getFlag(ID, "state")?.frame && await sheetMix(scene, w, .065)) || mixOf(grp, w.x, w.y, .04, 7);
    const score = (m) => { let d = 0; for (const k of new Set([...Object.keys(m), ...Object.keys(target)])) d += Math.abs((m[k] ?? 0) - (target[k] ?? 0)); return d; };
    const search = (c, r) => { const half = c * SQ_FT / FT_PER_MI / 2; let best = null;
      for (let dx = -.45; dx <= .45; dx += .025) for (let dy = -.45; dy <= .45; dy += .025) { const dist = Math.hypot(dx, dy); if (dist > .45) continue;
        const m = mixOf(grp, w.x + dx, w.y + dy, half, 6), sc = score(m) + dist * .25;
        if (!best || sc < best.sc) best = { sc, at: { x: +(w.x + dx).toFixed(4), y: +(w.y + dy).toFixed(4) }, m, cols: c, rows: r, dist }; }
      return best; };
    let best = search(cols, rows);
    const mixed = Object.values(target).filter(v => v >= .2).length >= 2;
    if (mixed && best.sc - best.dist * .25 > .5) for (const n of [60, 80]) { if (n <= cols) continue; const b = search(n, n); if (b.sc < best.sc - .2) { best = b; } if (best.sc - best.dist * .25 <= .5) break; }
    const pct = m => Object.entries(m).filter(([, v]) => v >= .05).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(", ");
    return { at: best.at, moved: best.dist, cols: best.cols, rows: best.rows, ground: pct(best.m), wanted: pct(target) };
  } catch (e) { console.warn(`${ID} | ground`, e); return { at: w, moved: 0, ground: "" }; }
}
const esc = t => String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
/* the dialog's layout, added to the page once (Foundry strips <style> from dialog content, and a cached sheet.css can lag a release) */
function encStyle() { if (document.getElementById("lss-enc-style")) return; const st = document.createElement("style"); st.id = "lss-enc-style";
  st.textContent = `.lss-enc .window-content{overflow-y:auto!important}.lss-enc .lss-tune{display:grid!important;grid-template-columns:1fr 1fr;gap:4px 14px}.lss-enc .lss-tune legend{grid-column:1/-1}.lss-enc .lss-slider{display:grid;grid-template-columns:6.5em 1fr;align-items:center;gap:6px}.lss-enc .lss-slider input[type=range]{width:100%;margin:0}.lss-enc .lss-slider .hint{font-size:10px;margin:0}.lss-enc textarea{width:100%}`; document.head.appendChild(st); }
async function askEncounter(scene, w, g = {}) {
  encStyle();
  const D = foundry.applications.api.DialogV2, def = `Encounter: ${scene.name} (${w.x.toFixed(2)}, ${w.y.toFixed(2)})`;
  return D.input({ window: { title: "Encounter map here", resizable: true }, classes: ["lss-enc"], position: { width: 640, height: Math.min(window.innerHeight - 40, 760), top: 20 }, ok: { label: "Make the map" },
    content: `<p>An encounter map centred on the spot you clicked, ${Math.abs(w.x).toFixed(2)} mi ${w.x < 0 ? "west" : "east"} and ${Math.abs(w.y).toFixed(2)} mi ${w.y < 0 ? "south" : "north"} of the world origin.</p>${g.ground ? `<p>Around your click the sheet shows <b>${esc(g.wanted)}</b>. Best match nearby: <b>${esc(g.ground)}</b>${g.moved > .005 ? `, ${Math.round(g.moved * FT_PER_MI)} ft from your click` : ""}${g.cols && g.cols !== 40 ? `, on a ${g.cols}×${g.rows} map so it all fits` : ""}.</p>` : ""}
      <div class="form-group"><label>Name</label><input type="text" name="name" value="${esc(def)}"></div>
      <div class="form-group"><label>Squares across</label><input type="number" name="cols" value="${g.cols ?? 40}" min="10" max="${ENC_MAX}" step="1"></div>
      <div class="form-group"><label>Squares down</label><input type="number" name="rows" value="${g.rows ?? 40}" min="10" max="${ENC_MAX}" step="1"></div>
      <div class="form-group"><label>Put the party there</label><input type="checkbox" name="party"></div>
      <div class="form-group stacked"><label>Add to the map</label><textarea name="notes" rows="2" placeholder="e.g. a pond in the north-east, a stand of dead trees, a cave entrance on the west side facing east"></textarea>
        <p class="hint">Known: lake, pond, stream, dead trees, clearing, boulders, rock outcrop, cave entrance, standing stones, ruins, campsite, fallen giant tree. Places: north, south-east, middle, edge… Anything else is kept on the scene for Claude.</p></div>
      <fieldset class="lss-tune"><legend>Tune the spot (middle = the land as it is)</legend>${TUNE_LABELS.map(([k, label, lo, hi]) =>
        `<div class="lss-slider"><label>${label}</label><div><input type="range" name="tune_${k}" min="-100" max="100" step="10" value="0"><span class="hint">${lo}</span><span class="hint" style="float:right">${hi}</span></div></div>`).join("")}</fieldset>
      <p class="hint">Leave the party unticked to plan ahead. The map opens for you only; players don't see it until you activate it.</p>` }).catch(() => null);
}
function setEncPlacing(on) {
  if (encHandler) { canvas.stage.off("pointerdown", encHandler); encHandler = null; }
  if (!on) return;
  encHandler = async ev => {
    if (ev.button !== 0 || ui.controls.tool?.name !== "encounterHere" || busy) return;
    const scene = canvas.scene; let w = worldPointAt(scene, ev.getLocalPosition(canvas.stage));
    if (!w) return ui.notifications.warn("Click on an overland sheet or the World Map.");
    const g = await groundAt(scene, w); w = g.at;
    const opts = await askEncounter(scene, w, g); if (!opts) return;
    busy = true; const note = ui.notifications.info("Drawing the encounter map… about 15 seconds.", { permanent: true });
    try {
      const tune = Object.fromEntries(TUNE_LABELS.map(([k]) => [k, (k === "decay" ? -1 : 1) * (Number(opts[`tune_${k}`]) || 0) / 100]));   /* Growth runs lush to the right: stored as decay, flipped */
      const r = await createEncounter({ x: w.x, y: w.y, from: scene.id, name: opts.name, cols: opts.cols, rows: opts.rows, party: !!opts.party, view: true, tune, notes: opts.notes });
      ui.notifications.info(`Made ${r.name}: ${r.cols}×${r.rows} squares${r.members ? `, party placed` : ""}${r.features.length ? `, with ${r.features.join(", ")}` : ""}. It's in the Encounter Maps folder.`);
      if (r.unknown.length) ui.notifications.warn(`Not built yet (kept on the scene for Claude): ${r.unknown.join("; ")}`, { permanent: true });
      ui.controls.activate({ control: CONTROL, tool: "select" });
    } catch (e) { ui.notifications.error(e.message); console.error(e); }
    finally { busy = false; ui.notifications.remove?.(note); }
  };
  canvas.stage.on("pointerdown", encHandler);
}

/* ---------- GM window ---------- */
class SheetPanel extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = { id: "lss-panel", classes: ["lss-panel"], window: { title: "Survey Sheet", resizable: true }, position: { width: 480, height: "auto" } };
  async _renderHTML() {
    const el = document.createElement("div"), sv = survey(), here = canvas.scene, isMap = isWorldMap(here), isSheet = !!here?.getFlag(ID, "state")?.frame, w = world();
    const status = sv ? `Surveyed ${new Date(sv.date).toLocaleDateString()}: ${sv.w} by ${sv.h} miles.` : "The World Map hasn't been surveyed yet.";
    el.innerHTML = `
      <section><h3>World Map</h3>
        <p>${status} ${w.origin ? "" : "No world origin is set."}</p>
        <div class="lss-row">
          <button type="button" data-do="origin" ${here?.grid?.type >= 2 && !isSheet ? "" : "disabled"}>Set origin at the selected pin</button>
          <button type="button" data-do="survey" ${here?.grid?.type >= 2 && !isSheet && w.origin ? "" : "disabled"}>Survey this map</button>
        </div>
        <p>${isMap ? "Pick hexes with the Pick Hexes tool, then:" : "Open the World Map to pick hexes."}</p>
        <div class="lss-row"><input type="text" id="lss-name" placeholder="Region name, e.g. Redthorn Hills" ${isMap ? "" : "disabled"}><button type="button" data-do="make" ${isMap ? "" : "disabled"}>Make a sheet from ${picked.size} picked hex${picked.size === 1 ? "" : "es"}</button></div>
      </section>
      <section><h3>Encounter maps</h3>
        <p>To plan one ahead, pick the Encounter Map Here tool (the chessboard, in the Lythara Maps group of the left-hand bar) and click a spot on any sheet or the World Map. Or make one where the party is now:</p>
        <div class="lss-row"><button type="button" data-do="encParty">Encounter map where the party is</button></div>
      </section>
      <section><h3>This sheet</h3>
        <div class="lss-row"><button type="button" data-do="refresh" ${isSheet ? "" : "disabled"}>Redraw this sheet</button><button type="button" data-do="refreshAll">Redraw all sheets</button></div>
        <p>Sheets live in the ${SHEET_FOLDER} folder. Where sheets meet, a strip along the edge carries tokens onto the next sheet.</p>
        <div class="lss-row"><button type="button" data-do="link">Link sheets at their edges</button><button type="button" data-do="organize">Tidy sheets into the folder</button></div>
        <p>The party has seen about ${exploredArea()} square miles. Carrying exploration reads what the players' characters have revealed on every sheet, then shows it on every sheet and the World Map.</p>
        <div class="lss-row"><button type="button" data-do="explore">Carry exploration everywhere</button></div>
        <p>Paste data copied from the Survey Sheet, then apply it. Copy current sheet gives you data to paste back into the sheet.</p>
        <textarea id="lss-paste" aria-label="Survey Sheet data"></textarea>
        <div class="lss-row"><button type="button" data-do="apply">Apply to map</button><button type="button" data-do="copy" ${isSheet ? "" : "disabled"}>Copy current sheet</button></div>
      </section>
      <div class="lss-status" id="lss-status" role="status"></div>`;
    return el;
  }
  _replaceHTML(result, content) {
    content.replaceChildren(result);
    const status = t => { result.querySelector("#lss-status").textContent = t; };
    const run = async (fn, done) => { status("Working…"); try { status(await fn()); if (done) this.render(); } catch (e) { status(e instanceof SyntaxError ? "That isn't Survey Sheet data. Copy it from the sheet again." : e.message); } };
    const on = (sel, fn) => result.querySelector(sel).addEventListener("click", fn);
    on('[data-do="origin"]', () => run(async () => {
      const n = canvas.notes.controlled[0]; if (!n) throw new Error("Select a pin on this map first.");
      const o = await setWorldOrigin(canvas.scene, n.document.x, n.document.y); return `Origin set at ${n.document.text} (${o.x}, ${o.y}).`;
    }, true));
    on('[data-do="survey"]', () => run(async () => { const m = await surveyWorldMap(canvas.scene, f => status(`Surveying… ${Math.round(f * 100)}%`)); return `Surveyed ${m.w} by ${m.h} miles.`; }, true));
    on('[data-do="make"]', () => run(async () => {
      const r = await createSheet({ hexes: [...picked.values()], name: result.querySelector("#lss-name").value });
      picked.clear(); drawPicked();
      if (ui.controls.tool?.name === "pickHexes") ui.controls.activate({ control: CONTROL, tool: "select" });   /* leave the pick tool so pins can be dragged again */
      return `Made ${r.name}.`;
    }, true));
    on('[data-do="encParty"]', () => run(async () => { status("Drawing the encounter map… about 15 seconds."); const r = await createEncounter({ view: true }); return `Made ${r.name} with ${r.members} party member${r.members === 1 ? "" : "s"}. It opened for you only; activate it to bring the players.`; }));
    on('[data-do="link"]', () => run(async () => { const r = await linkSheets(); return `${r.gates} gate${r.gates === 1 ? "" : "s"} between ${r.sheets} sheet${r.sheets === 1 ? "" : "s"}.`; }));
    on('[data-do="organize"]', () => run(async () => { const r = await organizeSheets(); return `${r.moved} sheet${r.moved === 1 ? "" : "s"} moved into ${r.folder}.`; }, true));
    on('[data-do="refresh"]', () => run(async () => { const r = await renderSheet(canvas.scene, { force: true }); return `Redrawn (${Math.round((r.map.bytes || 0) / 1024)} KB).`; }));
    on('[data-do="refreshAll"]', () => run(async () => { let n = 0; for (const s of sheetScenes()) { await renderSheet(s); n++; } return `Checked ${n} sheet${n === 1 ? "" : "s"}.`; }));
    on('[data-do="explore"]', () => run(async () => { const r = await syncExploration(); return `Read ${r.harvested} changed area${r.harvested === 1 ? "" : "s"}; revealed on ${r.restored.filter(x => x[1]).length} scene${r.restored.filter(x => x[1]).length === 1 ? "" : "s"}.`; }, true));
    on('[data-do="apply"]', () => run(async () => { const r = await applySheet(JSON.parse(result.querySelector("#lss-paste").value)); return `Updated ${r.sheets.length} sheet${r.sheets.length === 1 ? "" : "s"}.`; }));
    on('[data-do="copy"]', () => run(async () => { const t = JSON.stringify(exportSheet(canvas.scene)); const area = result.querySelector("#lss-paste"); area.value = t; area.select(); await navigator.clipboard?.writeText(t); return "Copied. If pasting doesn't work, copy the text in the box."; }));
  }
}

/* ---------- pins keep one screen size, and crowded minor pins wait until you zoom in ---------- */
const PIN_PX = 48, LABEL_PX = 15, RANK = { village: 0, gate: 1, ruin: 2, camp: 3, site: 4 };
let hexLines = null, lineCache = null;
function drawHexLines(zoom, state) {
  /* Drawn below the fog of war, so unexplored land still hides the road and creek. */
  const parent = canvas.environment ?? canvas.interface;
  if (!hexLines || hexLines.destroyed || hexLines.parent !== parent) { hexLines = new PIXI.Graphics(); parent.addChild(hexLines); }
  /* lines run on across the world, so stop them at the map's edge */
  const r = canvas.dimensions.sceneRect; if (hexLines.mask && !hexLines.mask.destroyed) hexLines.mask.destroy();
  hexLines.mask = parent.addChild(new PIXI.Graphics().beginFill(0xffffff).drawRect(r.x, r.y, r.width, r.height).endFill());
  const w = world(), lk = JSON.stringify([w.seed, w.lines]);
  if (lineCache?.key !== lk) lineCache = { key: lk, courses: w.lines.map(l => ({ kind: l.kind, course: lineCourse(l, w.seed) })) };
  const trace = pts => pts.forEach((pt, i) => { const p = toScene(canvas.scene, pt.x, pt.y); i ? hexLines.lineTo(p.x, p.y) : hexLines.moveTo(p.x, p.y); });
  hexLines.clear();
  for (const l of lineCache.courses) {
    if (!l.course.some(p => inFrame(state.frame, p, 2))) continue;
    const water = l.kind === "creek" || l.kind === "river";
    hexLines.lineStyle((l.kind === "river" ? 3.5 : l.kind === "track" ? 1.6 : 2.2) / zoom, water ? 0x2f7ea6 : 0x6d5a44, 1); trace(l.course);
  }
  /* A pale line under a dark one keeps the hex edges readable on both dark forest and pale pasture. */
  const g = survey() ? mapGeometry() : null;
  if (g) for (const [width, color, alpha] of [[3.2, 0xf1e6c9, 0.45], [1.3, 0x1f2a24, 0.9]]) {
    hexLines.lineStyle(width / zoom, color, alpha);
    for (const h of state.hexes ?? []) { const v = g.hex(h).vertices; trace([...v, v[0]]); }
  }
}
function layoutPins() {
  if (!canvas?.ready) return;
  const state = canvas.scene?.getFlag(ID, "state");
  if (!state?.frame) { if (hexLines && !hexLines.destroyed) hexLines.clear(); return; }
  drawHexLines(canvas.stage.scale.x, state);
  const kinds = Object.fromEntries(world().pins.map(p => [p.id, p.kind]));
  const rank = n => RANK[kinds[n.document.getFlag(ID, "pinId")]] ?? 5;
  const zoom = canvas.stage.scale.x, kept = [];
  const notes = canvas.notes.placeables.filter(n => n.document.getFlag(ID, "pinId") && n.isVisible && n.controlIcon);
  for (const n of notes.sort((a, b) => rank(a) - rank(b))) {
    const d = n.document, t = n.tooltip;
    n.controlIcon.scale.set(PIN_PX / (d.iconSize * zoom));
    if (t) { t.scale.set(LABEL_PX / (d.fontSize * zoom)); t.position.set(0, (PIN_PX / 2 + 2) / zoom); }
    const p = canvas.stage.worldTransform.apply({ x: d.x, y: d.y }), w = Math.max(PIN_PX, d.text.length * 8);
    const box = { x: p.x - w / 2, y: p.y - PIN_PX / 2, w, h: PIN_PX + LABEL_PX + 4 };
    const crowded = kept.some(o => box.x < o.x + o.w && o.x < box.x + box.w && box.y < o.y + o.h && o.y < box.y + box.h);
    const show = !crowded || n.hover;
    n.controlIcon.visible = show;
    if (t) t.visible = show;
    if (show) kept.push(box);
  }
}
let layoutQueued = false;
function queueLayout() {
  if (layoutQueued) return;
  layoutQueued = true;
  requestAnimationFrame(() => { layoutQueued = false; layoutPins(); drawPicked(); });
}
for (const hook of ["canvasReady", "canvasPan", "drawNote", "refreshNote", "createNote", "updateNote", "deleteNote"]) Hooks.on(hook, queueLayout);

/* ---------- encounter maps ----------
   A battle map at 5-ft squares for any point in the world, drawn from the same land as the sheets. The ground (with
   undergrowth) is the level's background; tree crowns are one overhead tile that fades when a token walks beneath;
   thick trunks are short walls; undergrowth and water are PF2e difficult terrain. The map remembers where in the world
   it sits, so it can grow at an edge and the party can go back to the same spot on the sheet afterwards. */
const ENC_FOLDER = "Encounter Maps", ENC_PX = 100, ENC_MAX = 120, CANOPY_ELEV = 20, TRUNK_THIN = .75, TRUNK_THICK = 1.6;
const encFolder = async () => game.folders.find(f => f.type === "Scene" && f.name === ENC_FOLDER) ?? Folder.create({ name: ENC_FOLDER, type: "Scene" });
async function uploadCanvas(cv, name) {
  const blob = await new Promise(res => cv.toBlob(res, "image/webp", 0.86));
  if (!blob) throw new Error("This browser couldn't make the map image.");
  try { await FP().createDirectory("data", IMAGE_DIR); } catch (e) { /* already there */ }
  const up = await FP().upload("data", IMAGE_DIR, new File([blob], name, { type: "image/webp" }), {}, { notify: false });
  if (!up?.path) throw new Error("Foundry refused the map upload. Check this user can upload files.");
  return { path: up.path, bytes: blob.size };
}
/** The world data an encounter map is planned from: the survey around the point, the seed, paint and lines. */
async function encounterInput(cx, cy, cols, rows) {
  const w = world(), { meta, data } = await loadSurvey(), m = Math.max(cols, rows) * SQ_FT / FT_PER_MI / 2 + 1.5;
  return { seed: w.seed, slice: surveySlice(data, meta, { x0: cx - m, x1: cx + m, y0: cy - m, y1: cy + m }), paint: w.paint, lines: w.lines, pins: w.pins };
}
/* each 5-ft square: 0 plain, 1 difficult (undergrowth or shallow water), 2 greater difficult (deep water: the middle of a river or wide creek; a
   narrow creek is shallow throughout); 25 samples a square */
function squareCosts(plan) {
  const { cols, rows } = plan, out = new Uint8Array(cols * rows), B = plan.feats.brush;
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
    out[j * cols + i] = deep >= 20 ? 2 : wet >= 13 || brush + wet >= 12 || go > .5 ? 1 : 0;
  }
  return out;
}
/* squares of one cost as rectangles: runs along each row, merged down while the run below matches */
function costRects(costs, cols, rows, want) {
  const runs = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols;) { if (costs[j * cols + i] !== want) { i++; continue; } let e = i; while (e < cols && costs[j * cols + e] === want) e++; runs.push({ i, e, j, h: 1 }); i = e; }
  const out = [];
  for (const r of runs) { const up = out.find(o => o.i === r.i && o.e === r.e && o.j + o.h === r.j); if (up) up.h++; else out.push({ ...r }); }
  return out;
}
/* ---------- the calendar: where in the year and the day we are ----------
   Simple Calendar (Reborn) when it is running, so Lythara's own months and seasons count; the coldest day is the middle of
   its Winter season. Without it, the Gregorian year with the coldest day on 20 January. */
function calendarNow() {
  const SC = globalThis.SimpleCalendar?.api, wt = game.time.worldTime;
  try {
    const d = SC?.timestampToDate?.(wt), months = SC?.getAllMonths?.(), seasons = SC?.getAllSeasons?.();
    if (d && months?.length) {
      const len = months.map(m => m.numberOfDays), total = len.reduce((a, b) => a + b, 0), doy = (m, day) => len.slice(0, m).reduce((a, b) => a + b, 0) + day;
      const iw = seasons?.findIndex(x => /winter/i.test(x.name)) ?? -1;
      let cold = 20;
      if (iw >= 0) { const w = seasons[iw], nx = seasons[(iw + 1) % seasons.length], a = doy(w.startingMonth, w.startingDay); let b = doy(nx.startingMonth, nx.startingDay); if (b <= a) b += total; cold = (a + (b - a) / 2) % total; }
      const now = doy(d.month, d.day) + (d.hour + d.minute / 60) / 24;
      return { yearFrac: (((now - cold) / total) % 1 + 1) % 1, hour: d.hour + d.minute / 60, label: d.display?.date ?? "", source: "Simple Calendar" };
    }
  } catch (e) { console.warn(`${ID} | calendar`, e); }
  const t = new Date(wt * 1000), start = Date.UTC(t.getUTCFullYear(), 0, 1), doy = (t - start) / 864e5;
  return { yearFrac: (((doy - 20) / 365) % 1 + 1) % 1, hour: t.getUTCHours() + t.getUTCMinutes() / 60, label: t.toISOString().slice(0, 10), source: "world clock" };
}
/* Day length from latitude and date. World y (miles north of Stoneclaim) is taken as latitude 45° at Stoneclaim, rising to
   70° where snow reaches the sea 1,150 miles north. The solstices fall about ten days before the coldest and warmest days. */
function sunTimes(yearFrac, y) {
  const lat = Math.max(-80, Math.min(80, 45 + y / 1150 * 25)) * Math.PI / 180, dec = -23.44 * Math.cos(2 * Math.PI * (yearFrac + 10 / 365)) * Math.PI / 180;
  const ch = -Math.tan(lat) * Math.tan(dec), h0 = ch <= -1 ? Math.PI : ch >= 1 ? 0 : Math.acos(ch), day = 24 * h0 / Math.PI;
  return { sunrise: 12 - day / 2, sunset: 12 + day / 2, day };
}
/* Darkness at an hour: day 0, night .95, an hour of twilight either side of sunrise and sunset. */
function darknessAt(hour, sun) {
  if (sun.day >= 23.99) return 0; if (sun.day <= .01) return .95;
  const tw = (h, edge) => Math.max(0, Math.min(1, (h - edge) / 1 + .5));
  const light = Math.min(tw(hour, sun.sunrise), 1 - tw(hour, sun.sunset));
  return +(.95 * (1 - light)).toFixed(3);
}
async function syncEncounterDarkness(scenes = game.scenes.filter(s => s.getFlag(ID, "encounter"))) {
  const now = calendarNow();
  for (const s of scenes) { const st = s.getFlag(ID, "encounter"), dk = darknessAt(now.hour, sunTimes(now.yearFrac, st.cy));
    if (Math.abs((s.environment?.darknessLevel ?? 0) - dk) >= .02) await s.update({ "environment.darknessLevel": dk }, { [ID]: { [SYNC]: true } }); }
}
Hooks.on("updateWorldTime", () => { if (isActiveGM()) syncEncounterDarkness().catch(e => console.warn(`${ID} | darkness`, e)); });

/** Build (or rebuild) the encounter scene's images, walls and terrain from its saved world position. */
async function drawEncounterScene(scene) {
  const st = scene.getFlag(ID, "encounter"), { cx, cy, cols, rows, tune } = st;
  const cal = calendarNow(), plan = planEncounter(await encounterInput(cx, cy, cols, rows), { cx, cy, cols, rows, tune, yearFrac: cal.yearFrac, features: st.features ?? [], cover: st.cover ?? null });
  const ground = drawEncounter(plan, "real", ENC_PX, "ground"), canopy = drawEncounter(plan, "real", ENC_PX, "canopy");
  const rev = foundry.utils.randomID(6), slot = st.slot === "a" ? "b" : "a";
  const g = await uploadCanvas(ground, `${scene.id}-enc-${slot}.webp`), c = await uploadCanvas(canopy, `${scene.id}-enc-${slot}-canopy.webp`);
  await scene.levels.contents[0].update({ background: { src: `${g.path}?v=${rev}` } });
  const d = scene.dimensions, ox = d.sceneX, oy = d.sceneY, ppf = ENC_PX / SQ_FT;
  /* clear what this module drew before */
  for (const type of ["Tile", "Wall", "Region", "AmbientLight"]) { const ids = scene.getEmbeddedCollection(type).filter(x => x.getFlag(ID, "enc")).map(x => x.id); if (ids.length) await scene.deleteEmbeddedDocuments(type, ids); }
  /* one canopy tile over the whole map (in v14 a tile's x/y is its centre). Radial occlusion cuts a see-through hole around
     each token beneath it; a fade would turn the whole canopy see-through as soon as any token stood under any tree. */
  await scene.createEmbeddedDocuments("Tile", [{ x: ox + d.sceneWidth / 2, y: oy + d.sceneHeight / 2, width: d.sceneWidth, height: d.sceneHeight, elevation: CANOPY_ELEV, texture: { src: `${c.path}?v=${rev}` },
    occlusion: { modes: [CONST.OCCLUSION_MODES.RADIAL], alpha: 0.2 }, flags: { [ID]: { enc: "canopy" } } }]);
  /* trunks, graded by thickness. Thin (under TRUNK_THIN ft radius): nothing. Medium: blocks movement, and sight "limited":
     you can see past one such tree but not past two in a row. Thick (TRUNK_THICK ft and over): blocks movement and sight.
     Each trunk is a one-way ring (dir LEFT, vertices clockwise on screen): it stops tokens walking in, and a sight line through
     it counts as one wall, not two (checked on 14.369: behind one medium trunk visible, behind two hidden). */
  const walls = [], WS = CONST.WALL_SENSE_TYPES, LEFT = CONST.WALL_DIRECTIONS.LEFT;
  for (const t of plan.feats.trees) { if (t.trunk < TRUNK_THIN || t.u < 0 || t.v < 0 || t.u > plan.Wft || t.v > plan.Hft) continue;
    const sense = t.trunk >= TRUNK_THICK && !t.dead ? WS.NORMAL : WS.LIMITED;
    const x = ox + t.u * ppf, y = oy + t.v * ppf, r = t.trunk * ppf, pts = [...Array(6)].map((_, k) => [Math.round(x + Math.cos(k * Math.PI / 3) * r), Math.round(y + Math.sin(k * Math.PI / 3) * r)]);
    for (let k = 0; k < 6; k++) walls.push({ c: [...pts[k], ...pts[(k + 1) % 6]], move: CONST.WALL_MOVEMENT_TYPES.NORMAL, sight: sense, light: sense, sound: WS.NONE, dir: LEFT, flags: { [ID]: { enc: "trunk" } } }); }
  /* placed features: stones, ruined walls, outcrops and the cave's rock block movement and sight */
  const P = (u, v) => [Math.round(ox + u * ppf), Math.round(oy + v * ppf)], fw = (a, b, sense = WS.NORMAL) => walls.push({ c: [...a, ...b], move: CONST.WALL_MOVEMENT_TYPES.NORMAL, sight: sense, light: sense, sound: WS.NONE, flags: { [ID]: { enc: "feature" } } });
  const ringW = (u, v, r, n, sense) => { const pts = [...Array(n)].map((_, k) => P(u + Math.cos(k / n * 6.283) * r, v + Math.sin(k / n * 6.283) * r)); for (let k = 0; k < n; k++) walls.push({ c: [...pts[k], ...pts[(k + 1) % n]], move: CONST.WALL_MOVEMENT_TYPES.NORMAL, sight: sense, light: sense, sound: WS.NONE, dir: LEFT, flags: { [ID]: { enc: "feature" } } }); };
  for (const q of plan.feats.stones ?? []) { const len = q.fallen ? q.w * 1.8 : q.w, ca = Math.cos(q.ang), sa = Math.sin(q.ang), c4 = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => P(q.u + (a * len / 2) * ca - (b * q.h / 2) * sa, q.v + (a * len / 2) * sa + (b * q.h / 2) * ca));
    for (let k = 0; k < 4; k++) fw(c4[k], c4[(k + 1) % 4], q.fallen || q.altar ? WS.NONE : WS.NORMAL); }
  for (const w of plan.feats.ruins ?? []) fw(P(w.a.u, w.a.v), P(w.b.u, w.b.v));
  for (const r of plan.feats.outcrops ?? []) ringW(r.u, r.v, r.r * .8, 8, WS.NORMAL);
  for (const q of plan.feats.caves ?? []) { const R = q.r * .62, n = 9, a0 = q.face + 1.15, a1 = q.face + 6.283 - 1.15, pts = [...Array(n + 1)].map((_, k) => { const a = a0 + (a1 - a0) * k / n; return P(q.u + Math.cos(a) * R, q.v + Math.sin(a) * R); });
    for (let k = 0; k < n; k++) fw(pts[k], pts[k + 1]); }
  if (walls.length) await scene.createEmbeddedDocuments("Wall", walls);
  /* campfires give light */
  const lights = (plan.feats.camps ?? []).map(q => { const [x, y] = P(q.u, q.v); return { x, y, config: { bright: 10, dim: 25, color: "#ff9a40", alpha: .45, animation: { type: "torch", speed: 3, intensity: 4 } }, flags: { [ID]: { enc: "camp" } } }; });
  if (lights.length) await scene.createEmbeddedDocuments("AmbientLight", lights);
  /* difficult terrain */
  const costs = squareCosts(plan), regions = [];
  for (const [want, name, walk, color] of [[1, "Difficult terrain (undergrowth, shallow water)", 2, "#8a7a2a"], [2, "Deep water (greater difficult)", 3, "#2a5a8a"]]) {
    const rects = costRects(costs, cols, rows, want); if (!rects.length) continue;
    regions.push({ name, color, visibility: CONST.REGION_VISIBILITY.LAYER, flags: { [ID]: { enc: "terrain" } },
      shapes: rects.map(r => ({ type: "rectangle", x: ox + r.i * ENC_PX, y: oy + r.j * ENC_PX, width: (r.e - r.i) * ENC_PX, height: r.h * ENC_PX, rotation: 0, hole: false })),
      behaviors: [{ name, type: "modifyMovementCost", system: { difficulties: { walk, travel: walk } } }] });   /* PF2e tokens move with the "travel" action outside combat */
  }
  if (regions.length) await scene.createEmbeddedDocuments("Region", regions);
  await scene.setFlag(ID, "encounter", { ...st, slot, rev, drawnFor: cal.label, yearFrac: +cal.yearFrac.toFixed(4) });
  /* this module sets the darkness (day length by latitude), so PF2e's own world-clock sync is switched off for the scene;
     global light only while it is light enough */
  if (scene.getFlag("pf2e", "syncDarkness") !== "disabled" || (scene.environment?.globalLight?.darkness?.max ?? 1) > .5)
    await scene.update({ "flags.pf2e.syncDarkness": "disabled", "environment.globalLight.darkness.max": .5 });
  await syncEncounterDarkness([scene]);
  const sea = plan.season;
  return { date: cal.label, season: { warmth: +sea.T.toFixed(2), leaf: +sea.leaf.toFixed(2), autumn: +sea.autumn.toFixed(2), snow: +sea.snow.toFixed(2) }, darkness: scene.environment?.darknessLevel, trees: plan.feats.trees.length, brush: plan.feats.brush.length, walls: walls.length, difficult: costs.filter(v => v === 1).length, deep: costs.filter(v => v === 2).length, bytes: g.bytes + c.bytes };
}
/** Add features to an existing encounter map from notes ("a pond in the north-east") and redraw it. Unknown parts are kept. */
export async function addEncounterNotes(scene, notes) {
  if (!game.user.isGM) throw new Error("Only a GM can change an encounter map.");
  const st = scene?.getFlag(ID, "encounter"); if (!st) throw new Error("That scene is not an encounter map.");
  const parsed = parseNotes(notes), wmi = st.cols * SQ_FT / FT_PER_MI, hmi = st.rows * SQ_FT / FT_PER_MI;
  const add = parsed.features.map(f => ({ kind: f.kind, x: +(st.cx - wmi / 2 + f.fx * wmi).toFixed(5), y: +(st.cy + hmi / 2 - f.fy * hmi).toFixed(5), size: f.size, ang: f.ang, text: f.text }));
  await scene.setFlag(ID, "encounter", { ...st, features: [...(st.features ?? []), ...add], notes: [st.notes, notes].filter(Boolean).join("; ").slice(0, 4000), unknown: [...(st.unknown ?? []), ...parsed.unknown] });
  const r = await drawEncounterScene(scene);
  return { added: add.map(f => f.kind), unknown: parsed.unknown, ...r };
}
/* where the party is in the world: its token on the active sheet, else its marker on the World Map */
function partyWorldPoint() {
  const party = partyActor(); if (!party) return null;
  const s = game.scenes.active, own = s?.getFlag(ID, "state")?.frame ? partyOn(s, party) : [];
  if (own.length) { const c = centroid(own); return { ...toMiles(s, c.x, c.y), from: s.id }; }
  const meta = survey(), marker = meta?.sceneId && game.scenes.get(meta.sceneId)?.tokens.find(t => t.actorId === party.id);
  return marker ? { ...mapGeometry().toWorld(tokenCentre(marker)), from: meta.sceneId } : null;
}
/** Make an encounter map at a world point (default: where the party is). The party's members are put in the middle when the
    map is made where the party is, or when party is true; a map planned ahead at a chosen spot leaves the party alone. */
export async function createEncounter({ x, y, cols = 40, rows = 40, name, from, activate = false, view = false, party, tune, notes } = {}) {
  if (!game.user.isGM) throw new Error("Only a GM can make an encounter map.");
  const chosen = x !== undefined && y !== undefined && Number.isFinite(+x) && Number.isFinite(+y);
  party ??= !chosen;
  let at = chosen ? { x: num(x, 20000), y: num(y, 20000), from } : partyWorldPoint();
  if (!at) throw new Error("Couldn't find the party. Give a world point, or put the party token on a sheet or the World Map.");
  cols = Math.max(10, Math.min(ENC_MAX, Math.round(+cols) || 40)); rows = Math.max(10, Math.min(ENC_MAX, Math.round(+rows) || 40));
  /* notes: known features go on the map (kept in world miles), anything else is kept for Claude */
  const parsed = parseNotes(notes ?? ""), wmi = cols * SQ_FT / FT_PER_MI, hmi = rows * SQ_FT / FT_PER_MI;
  const features = parsed.features.map(f => ({ kind: f.kind, x: +(at.x - wmi / 2 + f.fx * wmi).toFixed(5), y: +(at.y + hmi / 2 - f.fy * hmi).toFixed(5), size: f.size, ang: f.ang, text: f.text }));
  const src = game.scenes.get(at.from), cover = src ? await sheetCover(src, at.x, at.y, ENC_MAX, ENC_MAX) : null;   /* room to extend */
  name = String(name ?? "").trim().slice(0, 120) || `Encounter: ${src?.name ?? "the wilds"} (${at.x.toFixed(2)}, ${at.y.toFixed(2)})`;
  const scene = await Scene.create({ name, folder: (await encFolder()).id, navigation: false, width: cols * ENC_PX, height: rows * ENC_PX, padding: 0.1,
    grid: { type: CONST.GRID_TYPES.SQUARE, size: ENC_PX, distance: SQ_FT, units: "ft", alpha: 0.18 }, tokenVision: true, fog: { mode: 2 },
    environment: { globalLight: { enabled: true, darkness: { min: 0, max: .5 } } }, flags: { pf2e: { syncDarkness: "disabled" }, [ID]: { encounter: { version: 1, cx: at.x, cy: at.y, cols, rows, from: at.from ?? null, tune: tune ?? null, features, notes: String(notes ?? "").slice(0, 2000), unknown: parsed.unknown, cover } } } });
  const drawn = await drawEncounterScene(scene);
  const members = party ? await placeMembers(scene) : 0;
  if (activate) await scene.activate(); else if (view) await scene.view();
  return { ok: true, scene: scene.id, name: scene.name, at, cols, rows, members, features: features.map(f => f.kind), unknown: parsed.unknown, ...drawn };
}
/** Grow an encounter map at one edge by some squares. The land is fixed to the world, so what is already there stays put;
    everything placed by hand (tokens, notes, drawings, templates, lights and walls you added) is shifted with it. */
export async function extendEncounter(scene, side, squares = 10) {
  if (!game.user.isGM) throw new Error("Only a GM can change an encounter map.");
  const st = scene?.getFlag(ID, "encounter"); if (!st) throw new Error("That scene is not an encounter map.");
  side = String(side).toLowerCase(); if (!["north", "south", "east", "west"].includes(side)) throw new Error("Pick an edge: north, south, east or west.");
  const n = Math.max(1, Math.min(60, Math.round(+squares) || 10)), mi = n * SQ_FT / FT_PER_MI, horiz = side === "east" || side === "west";
  const cols = st.cols + (horiz ? n : 0), rows = st.rows + (horiz ? 0 : n);
  if (cols > ENC_MAX || rows > ENC_MAX) throw new Error(`Encounter maps stop at ${ENC_MAX} squares a side.`);
  const cx = st.cx + (side === "east" ? mi / 2 : side === "west" ? -mi / 2 : 0), cy = st.cy + (side === "north" ? mi / 2 : side === "south" ? -mi / 2 : 0);
  const before = scene.dimensions;
  await scene.update({ width: cols * ENC_PX, height: rows * ENC_PX });
  await scene.setFlag(ID, "encounter", { ...scene.getFlag(ID, "encounter"), cx: +cx.toFixed(5), cy: +cy.toFixed(5), cols, rows });
  /* the old top-left square moves by the padding change, plus the new strip when growing west or north */
  const after = scene.dimensions, dx = after.sceneX - before.sceneX + (side === "west" ? n * ENC_PX : 0), dy = after.sceneY - before.sceneY + (side === "north" ? n * ENC_PX : 0);
  if (dx || dy) for (const type of ["Token", "Note", "Drawing", "MeasuredTemplate", "AmbientLight", "AmbientSound", "Wall", "Tile", "Region"]) {
    const docs = scene.getEmbeddedCollection(type)?.filter(x => !x.getFlag(ID, "enc")) ?? []; if (!docs.length) continue;
    const ups = docs.map(x => type === "Wall" ? { _id: x.id, c: [x.c[0] + dx, x.c[1] + dy, x.c[2] + dx, x.c[3] + dy] }
      : type === "Region" ? { _id: x.id, shapes: x.toObject().shapes.map(sh => sh.points ? { ...sh, points: sh.points.map((v, i) => v + (i % 2 ? dy : dx)) } : { ...sh, x: (sh.x ?? 0) + dx, y: (sh.y ?? 0) + dy }) }
      : { _id: x.id, x: x.x + dx, y: x.y + dy });
    await scene.updateEmbeddedDocuments(type, ups, { animate: false, [ID]: { [SYNC]: true } });
  }
  const r = await drawEncounterScene(scene);
  return { side, squares: n, cols, rows, shifted: [dx, dy], ...r };
}
/** End an encounter: the party goes back to the overland at the spot where the fight was (the sheet covering it, through the
    World Map marker), that sheet is activated, and the members' tokens on the encounter map are removed. */
export async function returnFromEncounter(scene, { activate = true, removeTokens = true } = {}) {
  if (!game.user.isGM) throw new Error("Only a GM can do this.");
  const st = scene?.getFlag(ID, "encounter"); if (!st) throw new Error("That scene is not an encounter map.");
  const party = partyActor(), meta = survey(); if (!party || !meta?.sceneId) throw new Error("No party, or no surveyed World Map.");
  const ids = memberIds(party), toks = scene.tokens.filter(t => ids.has(t.actorId) || t.actorId === party.id), d = scene.dimensions;
  const c = toks.length ? centroid(toks) : { x: d.sceneX + d.sceneWidth / 2, y: d.sceneY + d.sceneHeight / 2 };
  const wmi = st.cols * SQ_FT / FT_PER_MI, hmi = st.rows * SQ_FT / FT_PER_MI, ft = 1 / ENC_PX * SQ_FT / FT_PER_MI;
  const w = { x: st.cx - wmi / 2 + (c.x - d.sceneX) * ft, y: st.cy + hmi / 2 - (c.y - d.sceneY) * ft };
  const map = game.scenes.get(meta.sceneId), g = mapGeometry();
  let marker = map?.tokens.find(t => t.actorId === party.id);
  if (!marker && map) { const data = (await party.getTokenDocument({ x: 0, y: 0 })).toObject(); Object.assign(data, placeAt(data, g.toMap(w), map)); [marker] = await map.createEmbeddedDocuments("Token", [data], { [ID]: { [SYNC]: true } }); }
  if (!marker) throw new Error("The World Map isn't there.");
  const pos = placeAt(marker, g.toMap(w));
  await marker.update(pos, { animate: false, [ID]: { [SYNC]: true } });
  await partyFollowMarker(marker, { id: marker.id, ...pos });
  const sheet = sheetScenes().find(s => inFrame(s.getFlag(ID, "state").frame, w) && s.tokens.some(t => ids.has(t.actorId))) ?? sheetScenes().find(s => inFrame(s.getFlag(ID, "state").frame, w));
  if (removeTokens && toks.length) await scene.deleteEmbeddedDocuments("Token", toks.map(t => t.id), { [ID]: { [SYNC]: true } });
  if (activate) await (sheet ?? map).activate();
  return { at: { x: +w.x.toFixed(3), y: +w.y.toFixed(3) }, to: (sheet ?? map).name, removed: removeTokens ? toks.length : 0 };
}
/* the party's members around the middle of the map, on open squares, in a loose ring */
async function placeMembers(scene) {
  const party = partyActor(); if (!party) return 0;
  const st = scene.getFlag(ID, "encounter"), d = scene.dimensions, actors = party.members.filter(a => !scene.tokens.some(t => t.actorId === a.id));
  const blocked = new Set(scene.regions.filter(r => r.getFlag(ID, "enc")).flatMap(r => r.shapes.flatMap(sh => { const out = []; for (let x = sh.x; x < sh.x + sh.width; x += ENC_PX) for (let y = sh.y; y < sh.y + sh.height; y += ENC_PX) out.push(`${x},${y}`); return out; })));
  const ci = Math.floor(st.cols / 2), cj = Math.floor(st.rows / 2), spots = [];
  for (let ring = 0; spots.length < actors.length && ring < 12; ring++) for (let di = -ring; di <= ring; di++) for (let dj = -ring; dj <= ring; dj++) {
    if (Math.max(Math.abs(di), Math.abs(dj)) !== ring || spots.length >= actors.length) continue;
    const x = d.sceneX + (ci + di) * ENC_PX, y = d.sceneY + (cj + dj) * ENC_PX; if (!blocked.has(`${x},${y}`) && !spots.some(s => Math.abs(s.x - x) < ENC_PX * 2 && Math.abs(s.y - y) < ENC_PX * 2)) spots.push({ x, y });
  }
  const data = [];
  for (let k = 0; k < actors.length && k < spots.length; k++) { const t = (await actors[k].getTokenDocument({ x: 0, y: 0 })).toObject(); Object.assign(t, spots[k]); data.push(t); }
  if (data.length) await scene.createEmbeddedDocuments("Token", data, { [ID]: { [SYNC]: true } });
  return data.length;
}

/* ---------- start ---------- */
Hooks.once("init", () => {
  game.settings.register(ID, "world", { scope: "world", config: false, type: Object, default: WORLD_DEFAULT });
  game.settings.register(ID, "sheetNav", { name: "Show sheets in the navigation bar", hint: "Off keeps the bar to the World Map and the active sheet; sheets stay in the Overland Sheets folder of the Scenes tab.", scope: "world", config: true, type: Boolean, default: false, onChange: () => organizeSheets().catch(() => {}) });
  game.settings.register(ID, "survey", { scope: "world", config: false, type: Object, default: null });
  game.settings.register(ID, "explored", { scope: "world", config: false, type: Object, default: { version: 1, chunks: {}, harvested: {} } });
});
async function askExtend() {
  const scene = canvas.scene; if (!scene?.getFlag(ID, "encounter")) throw new Error("Open an encounter map first.");
  const st = scene.getFlag(ID, "encounter"), D = foundry.applications.api.DialogV2;
  const o = await D.input({ window: { title: "Extend this map" }, ok: { label: "Extend" }, content: `<p>${st.cols}×${st.rows} squares now. Everything on the map stays where it is.</p>
    <div class="form-group"><label>Edge</label><select name="side"><option value="north">North (top)</option><option value="east" selected>East (right)</option><option value="south">South (bottom)</option><option value="west">West (left)</option></select></div>
    <div class="form-group"><label>Squares to add</label><input type="number" name="squares" value="10" min="1" max="60"></div>` }).catch(() => null);
  if (!o) return;
  const note = ui.notifications.info("Extending the map… about 15 seconds.", { permanent: true });
  try { const r = await extendEncounter(scene, o.side, o.squares); ui.notifications.info(`Now ${r.cols}×${r.rows} squares.`); } finally { ui.notifications.remove?.(note); }
}
async function askReturn() {
  const scene = canvas.scene; if (!scene?.getFlag(ID, "encounter")) throw new Error("Open an encounter map first.");
  const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: "Back to the overland" }, content: "<p>Move the party back to the overland sheet at this spot, make that sheet active, and remove the party's tokens from this encounter map?</p>" }).catch(() => false);
  if (!ok) return;
  const r = await returnFromEncounter(scene); ui.notifications.info(`The party is back on ${r.to}.`);
}
/* the module's own group in the left-hand bar (GM only). It works on the notes layer, so pins stay visible and draggable
   with its Select tool. */
const CONTROL = "lythara";
Hooks.on("getSceneControlButtons", controls => {
  if (!game.user.isGM) return;
  controls[CONTROL] = { name: CONTROL, title: "Lythara Maps", icon: "fa-solid fa-map-location-dot", layer: "notes", order: (controls.notes?.order ?? 10) + 0.5, activeTool: "select",
    onChange: (ev, active) => { if (!active) { setPicking(false); setEncPlacing(false); } },
    tools: {
      select: { name: "select", title: "Select and move pins", icon: "fa-solid fa-expand", order: 1 },
      pickHexes: { name: "pickHexes", title: "Pick Hexes for a Sheet (click hexes on the World Map)", icon: "fa-solid fa-draw-polygon", order: 2, onChange: (ev, active) => setPicking(active) },
      encounterHere: { name: "encounterHere", title: "Encounter Map Here (click a spot on a sheet or the World Map)", icon: "fa-solid fa-chess-board", order: 3, onChange: (ev, active) => setEncPlacing(active) },
      extendMap: { name: "extendMap", title: "Extend this encounter map at an edge", icon: "fa-solid fa-expand-arrows-alt", button: true, order: 4, onChange: () => askExtend().catch(e => ui.notifications.error(e.message)) },
      backOverland: { name: "backOverland", title: "Back to the overland (party returns to the sheet at this spot)", icon: "fa-solid fa-person-walking-arrow-right", button: true, order: 5, onChange: () => askReturn().catch(e => ui.notifications.error(e.message)) },
      surveySheet: { name: "surveySheet", title: "Survey Sheet window", icon: "fa-solid fa-sliders", button: true, order: 6, onChange: () => new SheetPanel().render(true) }
    } };
});
Hooks.once("ready", () => {
  game.modules.get(ID).api = { applySheet, exportSheet, createSheet, renderSheet, linkSheets, organizeSheets, placePartyOnNewSheet, createEncounter, drawEncounterScene, addEncounterNotes, extendEncounter, returnFromEncounter, surveyWorldMap, setWorldOrigin, harvestScene, restoreScene, syncExploration, exploredArea, renderMap, world, picked, PPM, CELL };
  /* the active GM quietly keeps the world record up to date from whatever sheet the party is on */
  if (game.user.isGM) setInterval(() => { const s = game.scenes.active; if (s?.getFlag(ID, "state")?.frame && game.users.activeGM?.isSelf) harvestScene(s).catch(() => {}); }, 120000);
});
