/* The world-map survey: three bytes per mile read from the painted World Map, so land can be generated anywhere.
   cells: low 4 bits how open the mile is, 0 (all forest) to 9 (all open); high 4 bits the class.
   Classes: 0 open ground, 1 forest, 2 water, 3 bare rock, 4 snow, 5 hills.
   sea: miles to the ocean (0 on the ocean itself), so the lowland can climb inland from sea level.
   mass: miles into a mountain mass (rock and snow), so a wide range stands higher than a lone crag. Both capped at 255. */
export const SURVEY_FILE = "world-survey.png", SURVEY_META = "world-survey.json", SURVEY_VERSION = 2;
export const CLASS = { open: 0, forest: 1, water: 2, rock: 3, snow: 4, hills: 5 };

/** Classify every mile of an image. pxPerMile is image pixels per mile. Returns {w, h, cells}. */
export function classifyImage(img, pxPerMile, onProgress) {
  const P = Math.max(1, Math.round(pxPerMile)), W = Math.floor(img.naturalWidth / P), H = Math.floor(img.naturalHeight / P);
  const cells = new Uint8Array(W * H), band = document.createElement("canvas"), rowsPerBand = Math.max(1, Math.floor(300 / P));
  band.width = img.naturalWidth; band.height = rowsPerBand * P;
  const g = band.getContext("2d", { willReadFrequently: true }), iw = img.naturalWidth;
  for (let mj0 = 0; mj0 < H; mj0 += rowsPerBand) {
    const rows = Math.min(rowsPerBand, H - mj0);
    g.drawImage(img, 0, mj0 * P, iw, rows * P, 0, 0, iw, rows * P);
    const d = g.getImageData(0, 0, iw, rows * P).data;
    for (let mj = 0; mj < rows; mj++) for (let mi = 0; mi < W; mi++) {
      let open = 0, forest = 0, water = 0, rock = 0, snow = 0, hill = 0;
      for (let y = mj * P; y < (mj + 1) * P; y++) for (let x = mi * P; x < (mi + 1) * P; x++) {
        const k = (y * iw + x) * 4, r = d[k], gg = d[k + 1], b = d[k + 2], l = (r + gg + b) / 3;
        if (l > 205 && Math.abs(r - gg) < 18 && Math.abs(gg - b) < 18) snow++;
        else if (b > r + 15 && b > gg - 5) water++;
        else if (Math.abs(r - gg) < 14 && Math.abs(gg - b) < 16 && l > 105) rock++;
        else if (r > gg + 6 && l > 95) { open++; if (b > .58 * r) hill++; }
        else forest++;
      }
      const n = P * P, land = open + forest || 1;
      let c = CLASS.open;
      if (water * 2 >= n) c = CLASS.water;
      else if (snow * 2 >= n) c = CLASS.snow;
      else if (rock * 2 >= n) c = CLASS.rock;
      else if (open >= forest) c = hill * 2 > open ? CLASS.hills : CLASS.open;
      else c = CLASS.forest;
      cells[(mj0 + mj) * W + mi] = (c << 4) | Math.round(9 * open / land);
    }
    onProgress?.((mj0 + rows) / H);
  }
  /* Painted hill shadows read as forest. Forest cells mostly surrounded by hills are hills. */
  const out = new Uint8Array(cells);
  for (let j = 1; j < H - 1; j++) for (let i = 1; i < W - 1; i++) {
    const k = j * W + i;
    if (cells[k] >> 4 !== CLASS.forest) continue;
    let h = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if ((di || dj) && cells[k + dj * W + di] >> 4 === CLASS.hills) h++;
    if (h >= 5) out[k] = (CLASS.hills << 4) | 9;
  }
  const { sea, mass } = surveyDistances(out, W, H);
  return { w: W, h: H, cells: out, sea, mass };
}

/* Ocean: water joined to the map edge, or any water body over 1,500 square miles (an inland sea). Smaller water is a lake.
   Distances are a two-pass chamfer in miles, capped at 255. */
export function surveyDistances(cells, W, H) {
  const N = W * H, water = new Uint8Array(N), ocean = new Uint8Array(N), seen = new Int32Array(N).fill(-1);
  for (let k = 0; k < N; k++) water[k] = (cells[k] >> 4) === CLASS.water ? 1 : 0;
  const stack = new Int32Array(N); let comp = 0;
  for (let k0 = 0; k0 < N; k0++) {
    if (!water[k0] || seen[k0] >= 0) continue;
    let top = 0, n = 0, edge = false; stack[top++] = k0; seen[k0] = comp; const members = [];
    while (top) { const k = stack[--top]; n++; members.push(k); const i = k % W, j = (k / W) | 0;
      if (i === 0 || j === 0 || i === W - 1 || j === H - 1) edge = true;
      const nb = [k - 1, k + 1, k - W, k + W]; if (i === 0) nb[0] = -1; if (i === W - 1) nb[1] = -1; if (j === 0) nb[2] = -1; if (j === H - 1) nb[3] = -1;
      for (const q of nb) if (q >= 0 && water[q] && seen[q] < 0) { seen[q] = comp; stack[top++] = q; } }
    if (edge || n >= 1500) for (const k of members) ocean[k] = 1;
    comp++;
  }
  const chamfer = src => {
    const d = new Float32Array(N); for (let k = 0; k < N; k++) d[k] = src[k] ? 0 : 1e6;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) { const k = j * W + i; let v = d[k]; if (!v) continue;
      if (i > 0) v = Math.min(v, d[k - 1] + 1); if (j > 0) { v = Math.min(v, d[k - W] + 1); if (i > 0) v = Math.min(v, d[k - W - 1] + 1.4142); if (i < W - 1) v = Math.min(v, d[k - W + 1] + 1.4142); } d[k] = v; }
    for (let j = H - 1; j >= 0; j--) for (let i = W - 1; i >= 0; i--) { const k = j * W + i; let v = d[k]; if (!v) continue;
      if (i < W - 1) v = Math.min(v, d[k + 1] + 1); if (j < H - 1) { v = Math.min(v, d[k + W] + 1); if (i < W - 1) v = Math.min(v, d[k + W + 1] + 1.4142); if (i > 0) v = Math.min(v, d[k + W - 1] + 1.4142); } d[k] = v; }
    const out = new Uint8Array(N); for (let k = 0; k < N; k++) out[k] = Math.min(255, Math.round(d[k])); return out;
  };
  const sea = chamfer(ocean);
  /* mass: distance from a rock or snow mile to the nearest mile that is neither */
  const notMtn = new Uint8Array(N); for (let k = 0; k < N; k++) { const c = cells[k] >> 4; notMtn[k] = (c === CLASS.rock || c === CLASS.snow) ? 0 : 1; }
  const mass = chamfer(notMtn);
  return { sea, mass };
}

/** Pack a survey into a PNG blob: red the cell byte, green miles to the ocean, blue miles into a mountain mass. */
export function surveyToPng(survey) {
  const cv = document.createElement("canvas"); cv.width = survey.w; cv.height = survey.h;
  const c = cv.getContext("2d"), img = c.createImageData(survey.w, survey.h), d = img.data;
  for (let k = 0; k < survey.cells.length; k++) { d[k * 4] = survey.cells[k]; d[k * 4 + 1] = survey.sea ? survey.sea[k] : 0; d[k * 4 + 2] = survey.mass ? survey.mass[k] : 0; d[k * 4 + 3] = 255; }
  c.putImageData(img, 0, 0);
  return new Promise(res => cv.toBlob(res, "image/png"));
}

/** Read a survey back from its PNG. */
export async function surveyFromPng(url) {
  const img = new Image(); img.src = url; await img.decode();
  const cv = document.createElement("canvas"); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
  const c = cv.getContext("2d", { willReadFrequently: true }); c.drawImage(img, 0, 0);
  const d = c.getImageData(0, 0, cv.width, cv.height).data, N = cv.width * cv.height, cells = new Uint8Array(N), sea = new Uint8Array(N), mass = new Uint8Array(N);
  for (let k = 0; k < N; k++) { cells[k] = d[k * 4]; sea[k] = d[k * 4 + 1]; mass[k] = d[k * 4 + 2]; }
  return { w: cv.width, h: cv.height, cells, sea, mass };
}

/** The survey cells covering a frame of world miles, as a compact string for sheet data.
    meta.origin is the world origin in survey cells (fractional). World y points north; survey rows point down. */
export function surveySlice(survey, meta, frame) {
  const x0 = Math.floor(meta.origin.x + frame.x0) - 1, x1 = Math.ceil(meta.origin.x + frame.x1) + 1;
  const y0 = Math.floor(meta.origin.y - frame.y1) - 1, y1 = Math.ceil(meta.origin.y - frame.y0) + 1;
  const w = x1 - x0, h = y1 - y0, out = new Uint8Array(w * h), sea = new Uint8Array(w * h), mass = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const sx = x0 + i, sy = y0 + j, k = j * w + i;
    if (sx < 0 || sy < 0 || sx >= survey.w || sy >= survey.h) { out[k] = CLASS.water << 4; continue; }
    const q = sy * survey.w + sx; out[k] = survey.cells[q]; sea[k] = survey.sea ? survey.sea[q] : 0; mass[k] = survey.mass ? survey.mass[q] : 0;
  }
  const slice = { x0: x0 - meta.origin.x, y1: meta.origin.y - y0, w, h, data: encodeCells(out) };
  if (survey.sea) { slice.sea = encodeCells(sea); slice.mass = encodeCells(mass); }
  return slice;
}

/* Run-length text: "value*count" pairs separated by commas, or a bare value for a run of one. */
export function encodeCells(cells) {
  const parts = [];
  for (let k = 0; k < cells.length;) { const v = cells[k]; let n = 1; while (k + n < cells.length && cells[k + n] === v) n++; parts.push(n > 1 ? v + "*" + n : String(v)); k += n; }
  return parts.join(",");
}
export function decodeCells(text, length) {
  const out = new Uint8Array(length); let k = 0;
  if (text) for (const p of text.split(",")) { const [v, n] = p.split("*").map(Number); const c = n || 1; if (k + c > length || !(v >= 0 && v < 256)) throw new Error("The survey data is damaged."); out.fill(v, k, k + c); k += c; }
  return out;
}

/** Openness and class lookup over a slice. x, y in world miles; y north. */
export function makeSliceReader(slice) {
  const N = slice.w * slice.h, dec = v => v == null ? null : v instanceof Uint8Array ? v : decodeCells(v, N), cells = dec(slice.data), sea = dec(slice.sea), mass = dec(slice.mass);
  const at = (i, j) => cells[Math.max(0, Math.min(slice.h - 1, j)) * slice.w + Math.max(0, Math.min(slice.w - 1, i))];
  /* bilinear read of a byte field between mile centres */
  const bil = (arr, x, y) => { const fx = x - slice.x0 - .5, fy = slice.y1 - y - .5, i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j, g = (a, b) => arr[Math.max(0, Math.min(slice.h - 1, b)) * slice.w + Math.max(0, Math.min(slice.w - 1, a))];
    return (g(i, j) * (1 - u) + g(i + 1, j) * u) * (1 - v) + (g(i, j + 1) * (1 - u) + g(i + 1, j + 1) * u) * v; };
  return {
    cells,
    /** Whether the slice carries the sea and mountain distances (survey version 2). Without them heights fall back to a flat guess. */
    hasHeights: !!(sea && mass),
    /** Miles to the ocean, interpolated. Falls back to 60 miles on an old survey. */
    seaAt(x, y) { return sea ? bil(sea, x, y) : 60; },
    /** Miles into a mountain mass, interpolated. Falls back to 3 on an old survey. */
    massAt(x, y) { return mass ? bil(mass, x, y) : 3; },
    /** Openness 0..1, interpolated between mile centres. Water, rock and snow count as fully open for the tree layer. */
    openAt(x, y) {
      const fx = x - slice.x0 - .5, fy = slice.y1 - y - .5, i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
      const o = c => (c >> 4) === CLASS.forest || (c >> 4) === CLASS.open || (c >> 4) === CLASS.hills ? (c & 15) / 9 : 1;
      return (o(at(i, j)) * (1 - u) + o(at(i + 1, j)) * u) * (1 - v) + (o(at(i, j + 1)) * (1 - u) + o(at(i + 1, j + 1)) * u) * v;
    },
    classAt(x, y) { return at(Math.floor(x - slice.x0), Math.floor(slice.y1 - y)) >> 4; },
    /** How much of the ground around a point is of one class, 0..1, interpolated between mile centres. Smooth edges come from this. */
    fracAt(cls, x, y) {
      const fx = x - slice.x0 - .5, fy = slice.y1 - y - .5, i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
      const f = c => (c >> 4) === cls ? 1 : 0;
      return (f(at(i, j)) * (1 - u) + f(at(i + 1, j)) * u) * (1 - v) + (f(at(i, j + 1)) * (1 - u) + f(at(i + 1, j + 1)) * u) * v;
    }
  };
}
