// Build a synthetic `packages/` tree the integration server can serve via
// `/packages/<pkg>/dist/...`. The Playwright spec + client.html importmap +
// path-disclosure tests all assume the monorepo layout where `<repo>/packages/`
// holds `s3/`, `core/`, `remote/` — this script reproduces just the `dist/`
// subtree of each, sourced from the standalone build output and the npm
// `@wc-bindable/*` installs. Re-runnable; safe to delete and recreate.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const target = path.join(root, "packages");

const sources = [
  { name: "s3",     from: path.join(root, "dist") },
  { name: "core",   from: path.join(root, "node_modules", "@wc-bindable", "core",   "dist") },
  { name: "remote", from: path.join(root, "node_modules", "@wc-bindable", "remote", "dist") },
];

for (const { name, from } of sources) {
  if (!fs.existsSync(from)) {
    console.error(`[setup-integration-packages] missing source: ${from}`);
    process.exit(1);
  }
}

fs.rmSync(target, { recursive: true, force: true });

for (const { name, from } of sources) {
  const dest = path.join(target, name, "dist");
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(from, dest, { recursive: true });
  console.log(`[setup-integration-packages] ${from} -> ${dest}`);
}
