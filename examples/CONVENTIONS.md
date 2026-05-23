# Examples conventions

Rules every example under `examples/` follows. Keep new work compliant; if a
rule must change, change it here first.

## 1. Scope — target frameworks

Exactly four front-end demos of `<s3-uploader>`, each binding the element a
different way (and nothing else — keep the set focused):

| Example | Binding |
|---|---|
| `vanilla` | [`@wc-bindable/core`](https://www.npmjs.com/package/@wc-bindable/core) `bind()` |
| `react` | [`@wc-bindable/react`](https://www.npmjs.com/package/@wc-bindable/react) `useWcBindable` |
| `vue` | [`@wc-bindable/vue`](https://www.npmjs.com/package/@wc-bindable/vue) `useWcBindable` |
| `wcstack-state` | [`@wcstack/state`](https://www.npmjs.com/package/@wcstack/state) declarative `data-wcs` |

Use the **off-the-shelf adapter** for each framework — no hand-written binding
glue. All four render an **identical upload card** (file picker, Upload/Abort,
live progress bar, status pill, result block, error banner); they differ only in
**how** the framework layer subscribes to `<s3-uploader>`'s reactive state.

## 2. Architecture — two servers, remote-only (Case C)

Like webauthn, there are **two** backends — but the second is a Core host over
WebSocket (not webauthn's cross-origin RP), and the bytes path is direct
browser → S3.

| Server | Port(s) | Role |
|---|---|---|
| `server/` | `ws://…:8080/s3-uploader` | The **Core host** (analogous to webauthn's `rp-server/`): per-connection `S3Core` + `RemoteShellProxy`. The *only* place AWS credentials live, URLs are signed, the multipart control plane runs, and post-process hooks fire. Shared by all clients. |
| `delivery/` | `5173`/`5174`/`5175`/`5176` | **One** dependency-free static delivery server. Serves each built client (and `wcstack-state` verbatim) at its fixed port. Holds no credentials; carries no bytes. |

- **Remote-only — there is no local mode worth shipping.** Putting AWS
  credentials in the browser is a non-starter, so every client connects to the
  server-side Core over WebSocket via `RemoteCoreProxy` ⇄ `RemoteShellProxy`.
- **Bytes never cross the WebSocket.** Only signing RPCs, rAF-coalesced
  progress, and completion notifications do. Server cost scales as
  `connections × signing_rate`, not with upload size.
- **Clients carry no `bucket` / credentials.** `ScopedS3Core` in
  [`server/server.js`](./server/server.js) **pins `bucket` + `prefix`
  server-side** (overriding the wcBindable input setters) so a client cannot
  redirect uploads to another bucket or escape its prefix.
- **`ws.on("close", () => core.abort())` is load-bearing.** Without it an
  interrupted multipart leaves orphan parts in S3 — the dead control channel is
  the only path that can reach `abortMultipart`. Never omit it.

## 3. Build, then serve statically — not the Vite dev server

Matching webauthn: the three Vite clients are **built**, and the shared
[`delivery/`](./delivery/) server serves the output. The canonical run is
**build + static serve**, not `npm run dev`.

- `vanilla` / `react` / `vue` build with `npm run build` → `dist/` (the
  `tsc --noEmit` / `vue-tsc --noEmit` typecheck runs first in react/vue).
  `delivery/server.js` serves each `dist/` at its port root.
- **Do not serve via the Vite dev server** for the canonical run. `npm run dev`
  exists only for hot-reload during development (it hits the same Core host over
  WebSocket on its dev port).
- `delivery/` is dependency-free (Node built-ins only). Register a new client by
  adding its port + `dist` dir to [`delivery/server.js`](./delivery/server.js).
- The WS URL is read from `import.meta.env.VITE_S3_REMOTE_URL` (each client's
  `.env`, default `ws://localhost:8080/s3-uploader`) and applied through
  `bootstrapS3({ remote: { enableRemote: true, remoteSettingType: "config",
  remoteCoreUrl } })`. **It is baked in at `vite build` time** — set each
  client's `.env` before building, not before serving.

## 4. Workspace wiring — `file:../..`, build the package first

- Every example depends on the package as `"@csbc-dev/s3-uploader": "file:../.."`.
  The package must be built once from the repo root (`npm install && npm run
  build`) so `dist/` exists before any client resolves the dependency.
- The `@wc-bindable/*` adapters are pinned at `^0.7.0`. `@wcstack/state` is
  **not** a dependency — `wcstack-state` loads it from a CDN (see §6).
- The server uses `@csbc-dev/s3-uploader/server` (the Node-safe barrel), never
  the default browser barrel — the latter pulls in `HTMLElement`-based code and
  fails to evaluate under Node.

## 5. The `File` is always imperative; the *start* gesture may not be

- A `File` object cannot travel through a reactive binding, so **every** client
  sets `el.file = …` directly from the file-picker handler.
- Starting the upload differs by client: `vanilla` / `react` / `vue` call
  `el.upload()` imperatively; `wcstack-state` drives the Shell's `trigger` input
  **declaratively** (`data-wcs="trigger: uploadRequested"`), and the Shell resets
  `trigger` when the run settles.
- Everything downstream — `progress` / `loading` / `uploading` / `completed` /
  `url` / `key` / `etag` / `metadata` / `error` — is fully reactive everywhere.
- Keep `errorText()` (the `WcsS3AnyError` → string normalizer) logically
  identical across all four clients.

## 6. `wcstack-state` specifics

- **Single self-contained file** — one `index.html`, no bundler, no build step.
  The [`delivery/`](./delivery/) server serves it **verbatim** at port 5176
  (no injection). The one [`README`](./wcstack-state/README.md) documents the
  pre-publish swap.
- **CDN-based**:
  - `@wcstack/state` → `https://esm.run/@wcstack/state/auto` (already published;
    leave on the CDN).
  - `@csbc-dev/s3-uploader` → `https://esm.run/@csbc-dev/s3-uploader/auto/remoteEnv`
    **once published to npm**. Until then, point that one `<script src>` at the
    **root-absolute** local build `/src/auto/remoteEnv.js`; the `delivery/`
    server maps `/src/` and `/dist/` to the repo root so that path — and the
    `import "../../dist/index.js"` inside it — resolves. (No need to hand-serve
    the repo root with `npx serve`; `delivery/` does the mapping.)
- **Remote URL comes from a global**, not a `bootstrapS3()` call: an inline
  classic `<script>` sets `window.S3_REMOTE_CORE_URL` during parse;
  `auto/remoteEnv` reads it (`remoteSettingType: "env"` has no implicit fallback).

## 7. Ports & origins — the S3 bucket CORS allow-list

Ports are **fixed**: `vanilla 5173`, `react 5174`, `vue 5175`,
`wcstack-state 5176`, server `8080` (WebSocket).

Those four client ports are owned by [`delivery/server.js`](./delivery/server.js)
(overridable via `VANILLA_PORT` / `REACT_PORT` / `VUE_PORT` / `WCSTACK_PORT`).
Because the browser PUTs **directly** to S3, each is an origin that **MUST** be
in the **target bucket's CORS `AllowedOrigins`** (this replaces webauthn's RP
origin allow-list). `AllowedMethods` must include `PUT`/`GET` and `ExposeHeaders`
must include `ETag` (both the single-PUT and multipart paths read it). Changing a
client port means updating it in **both** the delivery server and the bucket CORS
config. See [§S3 bucket CORS](./README.md#s3-bucket-cors).

If the WS port changes, update it everywhere by hand — the Vite clients'
`VITE_S3_REMOTE_URL` and `wcstack-state`'s `window.S3_REMOTE_CORE_URL` are **not**
derived from the server's `PORT`.

## 8. Demo-only shortcuts (never ship)

These keep the demos small; production must replace them:

- **No auth on the WS upgrade.** The per-connection prefix is fabricated
  (`Date.now()`-based session id) so each tab is isolated. In production, derive
  the per-user namespace from an **authenticated** session checked during the WS
  upgrade — bind the prefix to the verified user id.
- **AWS credentials in `server/.env`.** Fine for a local demo; a real deployment
  uses an instance role / STS, not long-lived keys on disk.
- **`contentType` is not restricted.** The demo accepts the client's
  content-type (it legitimately describes the picked file). To *constrain*
  allowed types, wrap `IS3Provider` and throw from `presignUpload` /
  `initiateMultipart` — do **not** add a setter override (that pattern is only
  for security boundaries like `bucket` / `prefix`).
- **The post-process hook just logs.** A real app inserts a DB row, scans, makes
  a thumbnail, etc.; throwing there rejects the upload.

## 9. Adding a new example

1. **Vite framework client**: create the project; depend on
   `@csbc-dev/s3-uploader` via `file:../..` and the framework's `@wc-bindable/*`
   adapter; read the WS URL from `VITE_S3_REMOTE_URL`; `bootstrapS3({ remote: … })`;
   render the same upload-card surface; set `el.file` imperatively; `vite build`;
   register the port + `dist` dir in [`delivery/server.js`](./delivery/server.js);
   add the origin to the bucket CORS allow-list (§7).
2. **Declarative (wcstack-style)**: a single self-contained CDN file using
   `auto/remoteEnv` + `window.S3_REMOTE_CORE_URL` and `data-wcs` on
   `<s3-uploader>`, served verbatim by `delivery/` on a fixed port that is in
   the bucket CORS allow-list.

No new backend — every client shares the one Core host (`server/`) and is served
by the one static `delivery/`.

## Layout

```
examples/
  server/         Core host (ws://…:8080/s3-uploader) — per-conn ScopedS3Core, signing, hooks
  delivery/       static delivery (5173/5174/5175/5176) — serves the built clients
  vanilla/        Vite + @wc-bindable/core   bind()          → dist/  (served on 5173)
  react/          Vite + @wc-bindable/react  useWcBindable   → dist/  (served on 5174)
  vue/            Vite + @wc-bindable/vue    useWcBindable   → dist/  (served on 5175)
  wcstack-state/  single CDN file + @wcstack/state (no build, served verbatim on 5176)
```

See [README.md](./README.md) for run instructions and the S3 bucket CORS config.
