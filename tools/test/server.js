/* Tiny static server for the test pages: serves this folder, with /scripts mapped to the repo's scripts and /data to TEST_DATA. */
const http = require("http"), fs = require("fs"), path = require("path");
const HERE = __dirname, REPO = path.resolve(HERE, "../.."), DATA = process.env.TEST_DATA || path.join(HERE, "data");
module.exports = (port) => http.createServer((q, r) => {
  const u = decodeURIComponent(q.url.split("?")[0]);
  const p = u.startsWith("/scripts/") ? path.join(REPO, u) : u.startsWith("/data/") ? path.join(DATA, u.slice(6)) : path.join(HERE, u);
  fs.readFile(p, (e, d) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200, { "Content-Type": p.endsWith(".mjs") || p.endsWith(".js") ? "text/javascript" : p.endsWith(".json") ? "application/json" : "text/html" }); r.end(d); });
}).listen(port);
