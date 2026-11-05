/* Render encounter-map jobs in headless Chromium.
   node render.js '<jobs JSON>' [outDir]
   job: {name, data:"sheetA.json", cx, cy, cols, rows, pxSq, style:"real", yearFrac, tune:{trees,brush,rocks,water,relief,decay}, notes, layers}
   Data files are sheet exports (api.exportSheet) in TEST_DATA (default tools/test/data, git-ignored: they hold campaign pins). */
const { chromium } = require("playwright"), fs = require("fs"), path = require("path");
(async () => {
  const jobs = JSON.parse(process.argv[2]), out = process.argv[3] || path.join(__dirname, "out"), DATA = process.env.TEST_DATA || path.join(__dirname, "data");
  fs.mkdirSync(out, { recursive: true });
  const srv = require("./server.js")(8780), b = await chromium.launch(), p = await b.newPage();
  p.on("pageerror", e => console.log("ERR", e.message)); p.on("console", m => { if (m.type() === "error") console.log("CERR", m.text()); });
  await p.goto("http://localhost:8780/page.html"); await p.waitForFunction(() => window.ready);
  const cache = {}, dataFor = f => cache[f] ??= JSON.parse(fs.readFileSync(path.join(DATA, f || "sheetA.json")));
  for (const j of jobs) {
    const r = await p.evaluate(([d, o]) => render(d, o), [dataFor(j.data), j]);
    fs.writeFileSync(path.join(out, j.name + ".jpg"), Buffer.from(r.url.split(",")[1], "base64"));
    console.log(j.name, r.w + "x" + r.h, "plan", r.plan, "draw", r.draw, JSON.stringify(r.n));
  }
  await b.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });
