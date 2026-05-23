/**
 * Shared static delivery server for ALL @csbc-dev/s3-uploader front-end demos —
 * one dependency-free Node process that listens on each front-end's port and
 * serves its built files:
 *
 *   :5173  vanilla        -> ../vanilla/dist        (vite build output)
 *   :5174  react          -> ../react/dist          (vite build output)
 *   :5175  vue            -> ../vue/dist            (vite build output)
 *   :5176  wcstack-state  -> ../wcstack-state/index.html  (served verbatim)
 *                            + /src/ and /dist/ from the repo root, so the
 *                            pre-publish local-build path resolves (see below)
 *
 * It does NO S3 work and holds NO credentials — that is the Core host
 * (../server), a separate WebSocket process. Each page connects to it directly:
 * the Vite clients bake `VITE_S3_REMOTE_URL` in at build time, wcstack-state
 * sets `window.S3_REMOTE_CORE_URL`. And the file BYTES never touch this server
 * either — the browser PUTs them straight to S3.
 *
 * Build the Vite demos first (vanilla/react/vue: `npm run build`), then:
 *   node server.js          (with ../server — the Core host — running)
 *
 * Ports are overridable: VANILLA_PORT / REACT_PORT / VUE_PORT / WCSTACK_PORT.
 * Each port is the page's browser origin, so if you change one, add
 * http://localhost:<port> to the target bucket's CORS AllowedOrigins or the
 * browser's direct PUT to S3 is blocked. See examples/README.md#s3-bucket-cors.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url)); // examples/delivery/
const examples = resolve(here, "..");                      // examples/
const repoRoot = resolve(here, "../..");                   // @csbc-dev/s3-uploader

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function safe(root, pathname) {
  const abs = resolve(root, pathname.replace(/^\/+/, ""));
  // `abs === root` allows the root itself; requiring `root + sep` otherwise stops
  // a sibling like `<root>-evil/...` from passing a bare `startsWith(root)` check.
  return abs === root || abs.startsWith(root + sep) ? abs : null;
}

async function sendFile(res, abs) {
  if (!abs) { res.writeHead(403); res.end("Forbidden"); return; }
  try {
    const body = await readFile(abs);
    res.writeHead(200, { "Content-Type": MIME[extname(abs)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404); res.end("Not Found");
  }
}

// --- vanilla / react / vue: serve the built dist/ at the port root ---
function staticDist(distDir) {
  return async (req, res) => {
    const { pathname } = new URL(req.url || "/", "http://localhost");
    await sendFile(res, safe(distDir, pathname === "/" ? "index.html" : pathname));
  };
}

// --- wcstack-state: one self-contained file (served verbatim) ---
//
// Post-publish, index.html loads @csbc-dev/s3-uploader from a CDN and only `/`
// is requested. Pre-publish, swap that one <script src> to "/src/auto/remoteEnv.js"
// (see wcstack-state/README.md): remoteEnv.js then does `import "../../dist/index.js"`,
// so BOTH /src/ and /dist/ must resolve from the repo root — which is why this
// handler maps them. (The CDN's @wcstack/state line never needs them.)
const wcsIndex = resolve(examples, "wcstack-state/index.html");
const repoSrc = resolve(repoRoot, "src");
const repoDist = resolve(repoRoot, "dist");

async function wcstackHandler(req, res) {
  const { pathname } = new URL(req.url || "/", "http://localhost");
  if (pathname.startsWith("/src/")) {
    await sendFile(res, safe(repoSrc, pathname.replace(/^\/src\//, "")));
    return;
  }
  if (pathname.startsWith("/dist/")) {
    await sendFile(res, safe(repoDist, pathname.replace(/^\/dist\//, "")));
    return;
  }
  if (pathname === "/" || pathname === "/index.html") {
    await sendFile(res, wcsIndex); // served verbatim — one self-contained file
    return;
  }
  res.writeHead(404); res.end("Not Found");
}

// `env` is the override variable read below; it is stored explicitly (not
// derived from `name`) because wcstack-state's variable is WCSTACK_PORT, not
// WCSTACK_STATE_PORT — a derived name would mislead the in-use message.
const FRONTS = [
  { name: "vanilla", env: "VANILLA_PORT", def: 5173, handler: staticDist(resolve(examples, "vanilla/dist")) },
  { name: "react", env: "REACT_PORT", def: 5174, handler: staticDist(resolve(examples, "react/dist")) },
  { name: "vue", env: "VUE_PORT", def: 5175, handler: staticDist(resolve(examples, "vue/dist")) },
  { name: "wcstack-state", env: "WCSTACK_PORT", def: 5176, handler: wcstackHandler },
].map((f) => ({ ...f, port: Number(process.env[f.env] || f.def) }));

for (const f of FRONTS) {
  const srv = createServer((req, res) =>
    f.handler(req, res).catch((e) => { res.writeHead(500); res.end(String(e?.message ?? e)); }),
  );
  // Without this, a single in-use port throws an uncaught exception that takes
  // the whole process (all four listeners) down with a raw stack trace.
  srv.on("error", (e) => {
    console.error(
      e.code === "EADDRINUSE"
        ? `  ${f.name.padEnd(14)} port ${f.port} in use — free it or set ${f.env}=<port>`
        : `  ${f.name.padEnd(14)} ${e.message}`,
    );
  });
  srv.listen(f.port, () => console.log(`  ${f.name.padEnd(14)} http://localhost:${f.port}`));
}
console.log("static delivery for all front-ends:");
console.log("(pages connect to the Core host directly — start it: cd ../server && npm run dev)");
