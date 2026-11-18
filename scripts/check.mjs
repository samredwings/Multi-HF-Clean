// Syntax check every first-party module without any dependency.
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const skip = new Set(["node_modules", "dist", "android", ".git", "test"]);

async function walk(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) found.push(...await walk(full));
    else if (/\.m?js$/.test(entry.name)) found.push(full);
  }
  return found;
}

let failed = 0;
const files = await walk(root);
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    failed += 1;
    console.error(`\n${file}\n${result.stderr}`);
  }
}
if (failed) {
  console.error(`${failed} file(s) failed the syntax check.`);
  process.exit(1);
}
console.log(`Syntax check passed for ${files.length} file(s).`);

