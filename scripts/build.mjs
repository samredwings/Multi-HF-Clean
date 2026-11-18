// Static build: copy the shell, then stamp the service worker with a content hash
// so every release gets a fresh cache and an old cache is evicted on activate.
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = resolve(root, "dist");
const required = [
  "index.html", "manifest.webmanifest", "favicon.svg", "service-worker.js",
  "src/app.js", "src/styles.css",
  "src/lib/util.js", "src/lib/hosts.js", "src/lib/protocol.js", "src/lib/state.js", "src/lib/queue.js",
];

for (const rel of required) {
  const info = await stat(resolve(root, rel)).catch(() => null);
  if (!info?.isFile()) throw new Error(`Required build file missing: ${rel}`);
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const rel of ["index.html", "manifest.webmanifest", "favicon.svg", "service-worker.js", "src"]) {
  await cp(resolve(root, rel), resolve(out, rel), { recursive: true });
}

async function files(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) found.push(...await files(full));
    else found.push(full);
  }
  return found.sort();
}

const hash = createHash("sha256");
for (const file of await files(out)) {
  if (!file.endsWith("service-worker.js")) hash.update(await readFile(file));
}
const swPath = resolve(out, "service-worker.js");
const stamp = hash.digest("hex").slice(0, 12);
await writeFile(swPath, (await readFile(swPath, "utf8")).replaceAll("__BUILD__", stamp));

const bytes = (await files(out)).length;
console.log(`Built static app to dist/ (${bytes} files, build ${stamp})`);

