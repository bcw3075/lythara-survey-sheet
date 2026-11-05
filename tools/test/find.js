/* List solid spots of each terrain type in a sheet export: node find.js sheetA.json */
const { chromium } = require("playwright"), fs = require("fs"), path = require("path");
(async () => {
  const DATA = process.env.TEST_DATA || path.join(__dirname, "data"), d = JSON.parse(fs.readFileSync(path.join(DATA, process.argv[2])));
  const srv = require("./server.js")(8781), b = await chromium.launch(), p = await b.newPage();
  await p.goto("http://localhost:8781/page.html"); await p.waitForFunction(() => window.ready);
  const r = await p.evaluate(async d => { const { planEncounter } = await import("/scripts/encounter.mjs"); const out = {}, f = d.frame;
    for (let x = f.x0 + 2; x <= f.x1 - 2; x += 1.1) for (let y = f.y0 + 2; y <= f.y1 - 2; y += 1.1) { const pl = planEncounter(d, { cx: x, cy: y, cols: 10, rows: 10 }), t = pl.terrainAt(x, y); let n = 0;
      for (let a = -1; a <= 1; a++) for (let c = -1; c <= 1; c++) n += pl.terrainAt(x + a * .01, y + c * .01) === t; if (n === 9) (out[t] ??= []).length < 4 && out[t].push([+x.toFixed(2), +y.toFixed(2)]); } return out; }, d);
  console.log("terrain codes: 0 fields 1 rough 2 woods 3 old 4 damp 5 water 6 hills 7 bad 8 crag 9 snow"); console.log(JSON.stringify(r));
  await b.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });
