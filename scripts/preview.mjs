// Zero-dependency static server for dist/. Serves the SPA and refuses path escapes.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..", "dist");
const port = Number(process.env.PORT ?? 4173);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const server = createServer(async (request, response) => {
  const requested = new URL(request.url ?? "/", "http://localhost").pathname;
  const relative = normalize(decodeURIComponent(requested === "/" ? "/index.html" : requested)).replace(/^([/\\])+/, "");
  const file = join(root, relative);
  if (!file.startsWith(root + sep)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    }).end(body);
  } catch {
    try {
      response.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" })
        .end(await readFile(join(root, "index.html")));
    } catch {
      response.writeHead(404).end("Not found. Run `npm run build` first.");
    }
  }
});

server.listen(port, () => console.log(`Preview on http://localhost:${port}`));

