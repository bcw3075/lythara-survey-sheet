/* Check the map read on every known spot, with no Foundry: readPlan's grids and things against the plan itself.
   node tools/test/read.js   (needs tools/test/data/spots.json and the sheet exports, git-ignored). */
const { chromium } = require("playwright"), fs = require("fs"), path = require("path");
(async () => {
  const DATA = process.env.TEST_DATA || path.join(__dirname, "data"), spots = JSON.parse(fs.readFileSync(path.join(DATA, "spots.json")));
  const srv = require("./server.js")(8781), b = await chromium.launch(), p = await b.newPage(); let bad = 0;
  p.on("pageerror", e => { console.log("ERR", e.message); bad++; });
  await p.goto("http://localhost:8781/page.html"); await p.waitForFunction(() => window.ready);
  for (const [name, [file, cx, cy]] of Object.entries(spots)) {
    const d = JSON.parse(fs.readFileSync(path.join(DATA, file)));
    const r = await p.evaluate(async ([d, cx, cy]) => {
      const E = await import("./scripts/encounter.mjs"), o = { cx, cy, cols: 40, rows: 40, yearFrac: .55 }, plan = E.planEncounter(d, o);
      const t0 = performance.now(), a = E.readPlan(plan), ms = Math.round(performance.now() - t0), c = E.squareCosts(plan), a2 = E.readPlan(E.planEncounter(d, o)), n = 1600, g = a.grids;
      const lens = Object.values(g).every(v => v.length === n), same = JSON.stringify(a) === JSON.stringify(a2), costOk = g.cost.every((v, k) => v === c[k]);
      const inRange = Object.values(a.things).flat().every(t => !t.at || (t.at[0] >= 0 && t.at[1] >= 0 && t.at[0] < 40 && t.at[1] < 40));
      const lineOk = a.lines.every(l => l.squares.every(q => q[0] >= 0 && q[1] >= 0 && q[0] < 40 && q[1] < 40) && !("id" in l) && !("name" in l));
      const count = g.terrain.reduce((m, t) => (m[t] = (m[t] || 0) + 1, m), {});
      return { ms, lens, same, costOk, inRange, lineOk, json: JSON.stringify(a).length, terrain: count, cost: [0, 1, 2].map(k => g.cost.filter(v => v === k).length), elev: [Math.min(...g.elev), Math.max(...g.elev)], canopy: +(g.canopy.reduce((x, y) => x + y) / n).toFixed(2), brush: +(g.brush.reduce((x, y) => x + y) / n).toFixed(2), water: +(g.water.reduce((x, y) => x + y) / n).toFixed(2), trees: a.things.trees.length, sight: a.things.trees.reduce((m, t) => (m[t.sight] = (m[t.sight] || 0) + 1, m), {}), lines: a.lines.map(l => l.kind + ":" + l.squares.length) };
    }, [d, cx, cy]);
    const ok = r.lens && r.same && r.costOk && r.inRange && r.lineOk; if (!ok) bad++;
    console.log(ok ? "PASS" : "FAIL", name, JSON.stringify(r));
  }
  await b.close(); srv.close(); process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
