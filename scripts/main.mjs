import { PPM, renderMap } from "./render.mjs";
import { CELL, lineCourse } from "./land.mjs";
import { classifyImage, surveyToPng, surveyFromPng, surveySlice, SURVEY_FILE, SURVEY_VERSION } from "./survey.mjs";
import { harvestScene, restoreScene, syncExploration, exploredArea } from "./explore.mjs";

const ID = "lythara-survey-sheet";
const IMAGE_DIR = "assets/map-tools";
const PIN_FOLDER = "Survey Sheet Pins";
const KIND_ICON = { village: "icons/svg/village.svg", camp: `modules/${ID}/icons/camp.svg`, ruin: `modules/${ID}/icons/ruin.svg`, gate: `modules/${ID}/icons/gate.svg`, site: `modules/${ID}/icons/site.svg` };
const LINE_KINDS = ["creek", "river", "road", "track"];
const RENDER_VERSION = 6, MAX_PX = 16000, MARGIN = 3;
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
  const g = mapGeometry(), ids = hexes.map(h => `row ${h.i}, col ${h.j}`);
  name = String(name || `Sheet: ${ids.join("; ")}`).slice(0, 120);
  const scene = await Scene.create({
    name, width: Math.round((frame.x1 - frame.x0) * PPM), height: Math.round((frame.y1 - frame.y0) * PPM), padding: 0.05,
    grid: { type: 2, size: PPM, distance: 1, units: "mi", alpha: 0.12 }, tokenVision: true, fog: { mode: 2 },
    environment: { globalLight: { enabled: false } }, flags: { pf2e: { rulesBasedVision: false }, [ID]: { state: { version: 1, frame, hexes: hexes.map(h => ({ ...h, center: g.hex(h).center })), rev: null } } }
  });
  const r = await renderSheet(scene, { force: true });
  if (link && g.meta.sceneId) await linkOnMap(scene, frame, g);
  /* the party arrives with the land it has already walked revealed */
  let explored = 0;
  try { await syncExploration({ restore: false }); explored = await restoreScene(scene); } catch (e) { console.warn(`${ID} | exploration not carried over`, e); }
  return { ok: true, scene: scene.id, name: scene.name, frame, explored, ...r };
}
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
        <div class="lss-row"><input type="text" id="lss-name" placeholder="Sheet name" ${isMap ? "" : "disabled"}><button type="button" data-do="make" ${isMap ? "" : "disabled"}>Make a sheet from ${picked.size} picked hex${picked.size === 1 ? "" : "es"}</button></div>
      </section>
      <section><h3>This sheet</h3>
        <div class="lss-row"><button type="button" data-do="refresh" ${isSheet ? "" : "disabled"}>Redraw this sheet</button><button type="button" data-do="refreshAll">Redraw all sheets</button></div>
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
      picked.clear(); drawPicked(); return `Made ${r.name}.`;
    }, true));
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

/* ---------- start ---------- */
Hooks.once("init", () => {
  game.settings.register(ID, "world", { scope: "world", config: false, type: Object, default: WORLD_DEFAULT });
  game.settings.register(ID, "survey", { scope: "world", config: false, type: Object, default: null });
  game.settings.register(ID, "explored", { scope: "world", config: false, type: Object, default: { version: 1, chunks: {}, harvested: {} } });
});
Hooks.on("getSceneControlButtons", controls => {
  if (!game.user.isGM || !controls.notes?.tools) return;
  controls.notes.tools.pickHexes = { name: "pickHexes", title: "Pick Hexes for a Sheet", icon: "fa-solid fa-draw-polygon", order: 98, onChange: (ev, active) => setPicking(active) };
  controls.notes.tools.surveySheet = { name: "surveySheet", title: "Survey Sheet", icon: "fa-solid fa-map-location-dot", button: true, order: 99, onChange: () => new SheetPanel().render(true) };
});
Hooks.once("ready", () => {
  game.modules.get(ID).api = { applySheet, exportSheet, createSheet, renderSheet, surveyWorldMap, setWorldOrigin, harvestScene, restoreScene, syncExploration, exploredArea, renderMap, world, picked, PPM, CELL };
  /* the active GM quietly keeps the world record up to date from whatever sheet the party is on */
  if (game.user.isGM) setInterval(() => { const s = game.scenes.active; if (s?.getFlag(ID, "state")?.frame && game.users.activeGM?.isSelf) harvestScene(s).catch(() => {}); }, 120000);
});
