import { HEXES, HEX_RADIUS, MAP, renderMap } from "./render.mjs";

const ID = "lythara-survey-sheet";
const IMAGE_DIR = "assets/map-tools";
const PIN_FOLDER = "Survey Sheet Pins";
const KIND_ICON = { village: "icons/svg/village.svg", camp: `modules/${ID}/icons/camp.svg`, ruin: `modules/${ID}/icons/ruin.svg`, gate: `modules/${ID}/icons/gate.svg`, site: `modules/${ID}/icons/site.svg` };
const RENDER_VERSION = 3;
const PIN_STYLE = { hasBackground: false, alwaysShowTooltip: true, dropShadowEnabled: true, dropShadowColor: "#000000", dropShadowAlpha: 0.8, dropShadowDistance: 0, dropShadowBlur: 2, dropShadowAngle: 0, strokeColor: "#000000", strokeAlpha: 1, strokeThickness: 4 };

const FP = () => foundry.applications.apps.FilePicker.implementation;
let busy = false;

/* ---------- checking what comes in ---------- */
function clean(data) {
  if (!data || typeof data !== "object") throw new Error("That isn't Survey Sheet data.");
  const seed = Number(data.seed);
  if (!Number.isInteger(seed)) throw new Error("The seed must be a whole number.");
  const paint = data.paint ?? "";
  if (typeof paint !== "string" || !/^[\d,;-]*$/.test(paint)) throw new Error("The painted terrain data is damaged.");
  if (!Array.isArray(data.pins) || data.pins.length > 300) throw new Error("The pin list is missing or too long.");
  const pins = data.pins.map(p => {
    const x = Number(p.x), y = Number(p.y);
    if (typeof p.id !== "string" || !/^[\w-]{1,60}$/.test(p.id) || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error("A pin is damaged.");
    return { id: p.id, name: String(p.name ?? "Unnamed pin").slice(0, 120), kind: KIND_ICON[p.kind] ? p.kind : "site", src: String(p.src ?? "").slice(0, 60), icon: typeof p.icon === "string" ? p.icon.slice(0, 200) : null, known: !!p.known, x, y };
  });
  return { seed, paint, pins, bake: { road: data.bake?.road !== false, creek: !!data.bake?.creek } };
}

/* ---------- position conversion ---------- */
const rectOf = scene => scene.dimensions.sceneRect;
const toScene = (scene, x, y) => { const r = rectOf(scene); return { x: Math.round(r.x + (x - MAP.x0) * MAP.ppm), y: Math.round(r.y + (MAP.y1 - y) * MAP.ppm) }; };
const toMiles = (scene, sx, sy) => { const r = rectOf(scene); return { x: +(MAP.x0 + (sx - r.x) / MAP.ppm).toFixed(3), y: +(MAP.y1 - (sy - r.y) / MAP.ppm).toFixed(3) }; };

/* ---------- scene ---------- */
export async function createScene(name = "Survey Sheet") {
  return Scene.create({
    name,
    width: Math.round((MAP.x1 - MAP.x0) * MAP.ppm),
    height: Math.round((MAP.y1 - MAP.y0) * MAP.ppm),
    padding: 0.05,
    grid: { type: 2, size: MAP.ppm, distance: 1, units: "mi", alpha: 0.12 },
    tokenVision: true,
    fog: { mode: 2 },
    environment: { globalLight: { enabled: false } },
    flags: { pf2e: { rulesBasedVision: false } }
  });
}

async function uploadMap(scene, data, rev) {
  const R = renderMap({ seed: data.seed, paint: data.paint, creek: data.bake.creek, road: data.bake.road });
  const blob = await new Promise(res => R.canvas.toBlob(res, "image/webp", 0.82));
  if (!blob) throw new Error("This browser couldn't make the map image.");
  try { await FP().createDirectory("data", IMAGE_DIR); } catch (e) { /* already there */ }
  const slot = scene.getFlag(ID, "slot") === "a" ? "b" : "a";
  const file = new File([blob], `${scene.id}-${slot}.webp`, { type: "image/webp" });
  const up = await FP().upload("data", IMAGE_DIR, file, {}, { notify: false });
  if (!up?.path) throw new Error("Foundry refused the map upload. Check this user can upload files.");
  await scene.levels.contents[0].update({ background: { src: `${up.path}?v=${rev}` } });
  await scene.setFlag(ID, "slot", slot);
  return { fingerprint: R.fingerprint, bytes: blob.size };
}

/* ---------- pins ---------- */
async function pinFolder() {
  return game.folders.find(f => f.type === "JournalEntry" && f.name === PIN_FOLDER) ?? Folder.create({ name: PIN_FOLDER, type: "JournalEntry" });
}
async function syncPins(scene, pins) {
  const keptMoves = [], notes = scene.notes.contents, seen = new Set();
  const creates = [], updates = [];
  const folder = await pinFolder();
  for (const p of pins) {
    seen.add(p.id);
    const note = notes.find(n => n.getFlag(ID, "pinId") === p.id);
    const at = toScene(scene, p.x, p.y);
    if (note) {
      const last = note.getFlag(ID, "last");
      const movedHere = last && (Math.abs(note.x - last.x) > 1 || Math.abs(note.y - last.y) > 1);
      if (movedHere) keptMoves.push(p.id);
      const pos = movedHere ? { x: note.x, y: note.y } : at;
      updates.push({ _id: note.id, ...pos, text: p.name, "texture.src": p.icon || KIND_ICON[p.kind], [`flags.${ID}.last`]: pos });
      if (note.entry?.getFlag(ID, "managed")) await note.entry.update({ name: p.name, "ownership.default": p.known ? 1 : 0 });
    } else {
      const entry = await JournalEntry.create({ name: p.name, folder: folder.id, ownership: { default: p.known ? 1 : 0 }, flags: { [ID]: { managed: true } }, pages: [{ name: p.name, type: "text", text: { content: "", format: 1 } }] });
      creates.push({ ...at, entryId: entry.id, text: p.name, global: true, iconSize: 180, fontSize: 48, textColor: "#ffffff", textAnchor: CONST.TEXT_ANCHOR_POINTS.BOTTOM, texture: { src: p.icon || KIND_ICON[p.kind] }, flags: { [ID]: { pinId: p.id, last: at }, "more-pin-options": PIN_STYLE } });
    }
  }
  const removed = notes.filter(n => n.getFlag(ID, "pinId") && !seen.has(n.getFlag(ID, "pinId"))).map(n => n.id);
  if (creates.length) await scene.createEmbeddedDocuments("Note", creates);
  if (updates.length) await scene.updateEmbeddedDocuments("Note", updates);
  if (removed.length) await scene.deleteEmbeddedDocuments("Note", removed);
  if (canvas.scene?.id === scene.id) for (const n of canvas.notes.placeables) await n.draw();
  return { created: creates.length, updated: updates.length, removed: removed.length, keptMoves };
}

/* ---------- the two jobs ---------- */
export async function applySheet(raw, sceneArg) {
  if (!game.user.isGM) throw new Error("Only a GM can update the map.");
  if (busy) throw new Error("An update is already running.");
  busy = true;
  try {
    const data = clean(raw);
    const scene = sceneArg ?? game.scenes.find(s => s.getFlag(ID, "state")) ?? await createScene();
    const before = scene.getFlag(ID, "state");
    const rev = foundry.utils.randomID(8);
    const landKey = JSON.stringify([RENDER_VERSION, data.seed, data.paint, data.bake]);
    const sameLand = before && JSON.stringify([before.renderVersion, before.seed, before.paint, before.bake]) === landKey;
    const map = sameLand ? { fingerprint: before.fingerprint, skipped: true } : await uploadMap(scene, data, rev);
    const pins = await syncPins(scene, data.pins);
    await scene.setFlag(ID, "state", { renderVersion: RENDER_VERSION, seed: data.seed, paint: data.paint, bake: data.bake, rev, fingerprint: map.fingerprint, pins: data.pins.map(({ id, src, kind, icon }) => ({ id, src, kind, icon })) });
    return { ok: true, scene: scene.id, name: scene.name, rev, map, pins };
  } finally { busy = false; }
}

export function exportSheet(sceneArg) {
  const scene = sceneArg ?? game.scenes.find(s => s.getFlag(ID, "state"));
  if (!scene) throw new Error("No Survey Sheet scene exists yet.");
  const st = scene.getFlag(ID, "state");
  const info = Object.fromEntries((st.pins ?? []).map(p => [p.id, p]));
  const pins = scene.notes.contents.filter(n => n.getFlag(ID, "pinId")).map(n => {
    const id = n.getFlag(ID, "pinId"), m = toMiles(scene, n.x, n.y), i = info[id] ?? {};
    return { id, name: n.text, kind: i.kind ?? "site", src: i.src ?? "", icon: i.icon ?? null, known: (n.entry?.ownership?.default ?? 0) >= 1, x: m.x, y: m.y };
  });
  return { ok: true, scene: scene.id, name: scene.name, seed: st.seed, paint: st.paint, bake: st.bake, rev: st.rev, fingerprint: st.fingerprint, pins };
}

async function run(text) {
  const msg = JSON.parse(text);
  if (msg.cmd === "export") return { req: msg.req, ...exportSheet() };
  if (msg.cmd === "apply") return { req: msg.req, ...(await applySheet(msg.data)) };
  throw new Error("Unknown request.");
}

/* ---------- the link the sheet talks to ---------- */
function mountLink() {
  if (document.getElementById("lss-link")) return;
  const box = document.createElement("div");
  box.id = "lss-link";
  box.innerHTML = `<textarea id="lss-in" aria-label="Survey sheet incoming data"></textarea><button type="button" id="lss-run">Run sheet link</button><div id="lss-out" role="status"><div id="lss-head">LSS-RESULT Ready</div><div id="lss-parts" role="group" aria-label="LSS-PARTS"></div></div>`;
  document.body.append(box);
  const head = box.querySelector("#lss-head"), parts = box.querySelector("#lss-parts"), input = box.querySelector("#lss-in");
  const show = (req, obj) => {
    /* The app's page reader cuts long text, so the answer goes out as short base64 lines. */
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
    const b64 = btoa(bin), frag = document.createDocumentFragment();
    for (let i = 0, n = 0; i < b64.length; i += 80, n++) { const d = document.createElement("div"); d.textContent = `L${n}:${b64.slice(i, i + 80)}`; frag.append(d); }
    parts.replaceChildren(frag);
    head.textContent = `LSS-RESULT Done ${req ?? "none"}`;
  };
  box.querySelector("#lss-run").addEventListener("click", async () => {
    head.textContent = "LSS-RESULT Working"; parts.replaceChildren();
    let req;
    try { req = JSON.parse(input.value).req; show(req, await run(input.value)); }
    catch (e) { show(req, { req, ok: false, error: e.message }); }
    input.value = "";
  });
}

/* ---------- GM window for pasting by hand ---------- */
class SheetPanel extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = { id: "lss-panel", classes: ["lss-panel"], window: { title: "Survey Sheet", resizable: true }, position: { width: 460, height: "auto" } };
  async _renderHTML() {
    const el = document.createElement("div");
    el.innerHTML = `<p>Paste data copied from the Survey Sheet, then apply it. Copy current map gives you data to paste back into the sheet.</p>
      <textarea id="lss-paste" aria-label="Survey Sheet data"></textarea>
      <div class="lss-row"><button type="button" data-do="apply">Apply to map</button><button type="button" data-do="copy">Copy current map</button></div>
      <div class="lss-status" id="lss-status" role="status"></div>`;
    return el;
  }
  _replaceHTML(result, content) {
    content.replaceChildren(result);
    const status = t => { result.querySelector("#lss-status").textContent = t; };
    const area = result.querySelector("#lss-paste");
    result.querySelector('[data-do="apply"]').addEventListener("click", async () => {
      status("Working…");
      try {
        const r = await applySheet(JSON.parse(area.value));
        status(`Updated ${r.name}. ${r.pins.keptMoves.length ? `Kept ${r.pins.keptMoves.length} pin position(s) moved in Foundry.` : ""}`);
      } catch (e) { status(e instanceof SyntaxError ? "That isn't Survey Sheet data. Copy it from the sheet again." : e.message); }
    });
    result.querySelector('[data-do="copy"]').addEventListener("click", async () => {
      try { const t = JSON.stringify(exportSheet()); area.value = t; area.select(); await navigator.clipboard?.writeText(t); status("Copied. If pasting doesn't work, copy the text in the box."); }
      catch (e) { status(e.message); }
    });
  }
}

/* ---------- pins keep one screen size, and crowded minor pins wait until you zoom in ---------- */
const PIN_PX = 48, LABEL_PX = 15, RANK = { village: 0, gate: 1, ruin: 2, camp: 3, site: 4 };
let hexLines = null;
function drawHexLines(zoom) {
  if (!hexLines || hexLines.destroyed || !hexLines.parent) { hexLines = new PIXI.Graphics(); canvas.interface.addChild(hexLines); }
  hexLines.clear();
  hexLines.lineStyle(1.5 / zoom, 0x1f2a24, 0.85);
  for (const H of HEXES) {
    for (let i = 0; i <= 6; i++) {
      const a = Math.PI / 180 * (60 * i + 30), p = toScene(canvas.scene, H.cx + Math.cos(a) * HEX_RADIUS, H.cy + Math.sin(a) * HEX_RADIUS);
      i ? hexLines.lineTo(p.x, p.y) : hexLines.moveTo(p.x, p.y);
    }
  }
}
function layoutPins() {
  if (!canvas?.ready) return;
  if (!canvas.scene?.getFlag(ID, "state")) { if (hexLines && !hexLines.destroyed) hexLines.clear(); return; }
  drawHexLines(canvas.stage.scale.x);
  const kinds = Object.fromEntries((canvas.scene.getFlag(ID, "state").pins ?? []).map(p => [p.id, p.kind]));
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
  requestAnimationFrame(() => { layoutQueued = false; layoutPins(); });
}
for (const hook of ["canvasReady", "canvasPan", "drawNote", "refreshNote", "createNote", "updateNote", "deleteNote"]) Hooks.on(hook, queueLayout);

/* ---------- start ---------- */
Hooks.once("init", () => {
  game.settings.register(ID, "showLink", { name: "Show the sheet link", hint: "Shows the small link bar the Survey Sheet uses in the Claude app. Leave it off in your normal browser.", scope: "client", config: true, type: Boolean, default: false, requiresReload: true });
});
Hooks.on("getSceneControlButtons", controls => {
  if (!game.user.isGM || !controls.notes?.tools) return;
  controls.notes.tools.surveySheet = { name: "surveySheet", title: "Survey Sheet", icon: "fa-solid fa-map-location-dot", button: true, order: 99, onChange: () => new SheetPanel().render(true) };
});
Hooks.once("ready", () => {
  game.modules.get(ID).api = { applySheet, exportSheet, createScene, renderMap, MAP };
  if (game.user.isGM && game.settings.get(ID, "showLink")) mountLink();
});
