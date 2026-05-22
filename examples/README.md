# `@csbc-dev/s3-uploader` examples

The same file-upload surface, built four ways — once per framework binding style — all driven by one shared WebSocket server.

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
| [`server/`](server/) | Node + `ws` + `@wc-bindable/remote` | `S3Core` + `RemoteShellProxy`, server-side credentials, prefix scoping, post-process hook |
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

Start the shared server first, then any one client.

**1. Start the shared server:**

```bash
cd examples/server
cp .env.example .env       # edit S3_BUCKET / AWS_* — credentials live here
npm install
npm run dev                # ws://localhost:8080/s3-uploader
```

**2. Start any client (in another terminal):**

```bash
cd examples/vanilla        # or react/, or vue/
cp .env.example .env       # edit VITE_S3_REMOTE_URL if the server is elsewhere
npm install
npm run dev
```

`wcstack-state/` has no bundler — see its [README](wcstack-state/README.md).

> **Pre-publish caveat (wcstack-state only):** unlike the three Vite clients,
> `wcstack-state/index.html` loads `@csbc-dev/s3-uploader` from a CDN URL that
> only resolves once the package is published to npm. Until then, opening the
> committed file as-is gives a 404 — you must serve the repo root and swap that
> one `<script src>` for a local build. The other three clients run from a clean
> clone via `npm run dev`. See [`wcstack-state/README.md`](wcstack-state/README.md#setup)
> for the exact steps.

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

| Project | Port |
|---|---|
| `server` | 8080 (WebSocket) |
| `vanilla` | 5173 |
| `react` | 5174 |
| `vue` | 5175 |
| `wcstack-state` | 5176 (static; the port the CORS allowlist below registers — serve it on 5176) |

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

- [`server/README.md`](server/README.md) — server internals: per-connection
  `S3Core`, credential handling, prefix scoping, post-process hooks.
- [`../README.md`](../README.md) — full component documentation (API surface,
  multipart sizing, retry policy, error taxonomy, security responsibilities).
- [`../CLAUDE.md`](../CLAUDE.md) — CSBC architecture context (why this is Case C).
