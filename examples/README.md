# `@csbc-dev/s3-uploader` examples

The same file-upload surface, built four ways — once per framework binding style — all driven by one shared WebSocket Core host and served by one static delivery server.

`@csbc-dev/s3-uploader` is a **Case C** package: the Core (`S3Core`) holds the
AWS credentials and signs every URL on the **server**, while the Shell
(`<s3-uploader>`) runs the browser-anchored data plane — picking the file and
PUTting the bytes **directly to S3**. There is no "local" mode worth shipping:
putting AWS credentials in the browser is a non-starter, so **every example
here is remote**. The browser talks to the server-side Core over WebSocket
through `RemoteCoreProxy` ⇄ `RemoteShellProxy`, and **the file bytes never
traverse that socket** — only signing requests, progress, and completion do.

| Project | Stack | Demonstrates |
|---|---|---|
| [`server/`](server/) | Node + `ws` + `@wc-bindable/remote` | The **Core host**: `S3Core` + `RemoteShellProxy`, server-side credentials, prefix scoping, post-process hook |
| [`delivery/`](delivery/) | Node built-ins only | One **static delivery server** that serves every built client at its fixed port |
| [`vanilla/`](vanilla/) | Vite + `bind()` from `@wc-bindable/core` | Pure-JS imperative binding |
| [`react/`](react/) | Vite + React 19 + `@wc-bindable/react` | `useWcBindable` (callback ref + fan-out) |
| [`vue/`](vue/) | Vite + Vue 3 + `@wc-bindable/vue` | `useWcBindable` composable |
| [`wcstack-state/`](wcstack-state/) | CDN `<wcs-state>` + `data-wcs` | Declarative HTML attribute binding (CDN-loaded; needs a local-build swap pre-publish — see note below) |

All four clients connect to the one shared [`server/`](server/) and render an
identical upload card: a file picker, an Upload/Abort pair, a live progress bar
fed by `progress`, a status pill from `loading` / `uploading` / `completed`,
a result block (`url` / `key` / `etag` / `metadata`), and an error banner from
`error`. They differ only in **how** the framework layer subscribes to
`<s3-uploader>`'s reactive state.

## Prerequisites

Every example references `@csbc-dev/s3-uploader` from the repo via a `file:`
dependency. Build the package once from the repo root so `dist/` exists:

```bash
# in the repo root
npm install
npm run build
```

## Run order

The clients are **built**, then served statically — not run from the Vite dev
server. Start the Core host, build the three Vite clients, then start the
delivery server.

**1. Start the Core host (`server/`):**

```bash
cd examples/server
cp .env.example .env       # edit S3_BUCKET / AWS_* — credentials live here
npm install
npm run dev                # ws://localhost:8080/s3-uploader
```

**2. Build each Vite client (in another terminal):**

```bash
cd examples/vanilla        # then react/, then vue/
cp .env.example .env       # edit VITE_S3_REMOTE_URL if the server is elsewhere
npm install
npm run build              # → dist/  (VITE_S3_REMOTE_URL is baked in HERE)
```

`wcstack-state/` has no build step — it is served verbatim.

**3. Start the static delivery server (`delivery/`):**

```bash
cd examples/delivery
npm start                  # vanilla:5173 react:5174 vue:5175 wcstack-state:5176
```

Open any printed URL. See [`delivery/README.md`](delivery/README.md) for details.

> **During development**, you can instead run a single Vite client with
> `npm run dev` (hot reload) on its dev port — it hits the same Core host over
> WebSocket. That is for iteration only; the canonical run is build + delivery.

> **Pre-publish caveat (wcstack-state only):** unlike the three Vite clients,
> `wcstack-state/index.html` loads `@csbc-dev/s3-uploader` from a CDN URL that
> only resolves once the package is published to npm. Until then, swap that one
> `<script src>` for the root-absolute local build `/src/auto/remoteEnv.js` — the
> `delivery/` server maps `/src/` and `/dist/` to the repo root so it resolves.
> See [`wcstack-state/README.md`](wcstack-state/README.md#setup) for the exact
> steps.

## What all four clients demonstrate

- **Remote mode: AWS credentials never reach the browser.** Clients have no
  `bucket` / credentials — `S3Core` holds them in the server's environment and
  signs every URL there. The browser only receives short-lived presigned URLs.
- **Bytes go browser → S3 directly.** The progress bar is fed by `progress`
  events the Shell reports while it PUTs to S3; the WebSocket only carries the
  signing RPCs and progress/completion notifications.
- **Choosing a `File` is always imperative; starting the upload may not be.**
  A `File` cannot travel through a reactive binding, so all four clients set
  `el.file = …` from the file-picker handler. The *start* gesture differs:
  vanilla / react / vue call `el.upload()` imperatively, while
  `wcstack-state` drives the Shell's `trigger` input **declaratively** — its
  `startUpload()` flips a store field that is bound with
  `data-wcs="trigger: uploadRequested"`, and `<s3-uploader>` resets `trigger`
  when the run settles. Everything downstream — `progress`, `completed`, `url`,
  `error` — is fully reactive in every client.
- **The binding code is unchanged across modes.** `bind()` / `useWcBindable` /
  `data-wcs` work against the proxied `<s3-uploader>` exactly as they would
  against a local element — the Core being on a server is transparent.
- **One `S3Core` per connection** on the server, scoped to its own prefix, with
  a `registerPostProcess` hook and the load-bearing
  `ws.on("close", () => core.abort())` cleanup.

## Port assignments

The Core host owns 8080; the four client ports are served by `delivery/` and are
overridable via `VANILLA_PORT` / `REACT_PORT` / `VUE_PORT` / `WCSTACK_PORT`.

| Project | Port |
|---|---|
| `server` (Core host) | 8080 (WebSocket) |
| `vanilla` | 5173 (served by `delivery/`) |
| `react` | 5174 (served by `delivery/`) |
| `vue` | 5175 (served by `delivery/`) |
| `wcstack-state` | 5176 (served by `delivery/`; matches the CORS allowlist below) |

## S3 bucket CORS

Because the browser PUTs **directly** to S3, the target bucket must allow the
client origin. At minimum:

```json
[
  {
    "AllowedOrigins": ["http://localhost:5173", "http://localhost:5174", "http://localhost:5175", "http://localhost:5176"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"]
  }
]
```

The four origins above match the per-client ports in the table — including
`http://localhost:5176` for `wcstack-state`, so serve that example on **5176**
(as its README does) or the browser's direct PUT is blocked by CORS. If you
serve a client on a different port, add that origin here too.

`ExposeHeaders: ["ETag"]` is required — both the single-PUT and multipart paths
read each PUT's `ETag` header. See [§S3 bucket CORS](../README.md#s3-bucket-cors)
in the package README. For an S3-compatible store (MinIO, R2, …) set
`S3_ENDPOINT` / `S3_FORCE_PATH_STYLE` in the server's `.env`.

## See also

- [`server/README.md`](server/README.md) — Core-host internals: per-connection
  `S3Core`, credential handling, prefix scoping, post-process hooks.
- [`delivery/README.md`](delivery/README.md) — the static delivery server: ports,
  build prerequisites, and the wcstack-state pre-publish mapping.
- [`../README.md`](../README.md) — full component documentation (API surface,
  multipart sizing, retry policy, error taxonomy, security responsibilities).
- [`../CLAUDE.md`](../CLAUDE.md) — CSBC architecture context (why this is Case C).
