// Build the web app, then sync it into the APK's asset directory.
// The Gradle build consumes whatever is in assets/, so this must run first.
import { cp, readdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const assets = resolve(root, "android/app/src/main/assets");

const build = spawnSync(process.execPath, [resolve(root, "scripts/build.mjs")], { stdio: "inherit", cwd: root });
if (build.status !== 0) process.exit(build.status ?? 1);

const info = await stat(dist).catch(() => null);
if (!info?.isDirectory()) throw new Error("dist/ is missing; the web build did not complete.");

await rm(assets, { recursive: true, force: true });
await cp(dist, assets, { recursive: true });

const index = await stat(resolve(assets, "index.html")).catch(() => null);
if (!index?.isFile()) throw new Error("android assets are missing index.html");

const count = async (dir) => {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    total += entry.isDirectory() ? await count(resolve(dir, entry.name)) : 1;
  }
  return total;
};
console.log(`Synced ${await count(assets)} file(s) into android/app/src/main/assets`);

