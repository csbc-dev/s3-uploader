# @wcstack/state example (remote mode)

Static HTML page that uses `data-wcs` declarative bindings to wire
`<s3-uploader>` into a `<wcs-state>` store, with `<s3-uploader>` running in
**remote mode** — `S3Core` runs on the [Core host](../server/), the browser
PUTs the file straight to S3. CDN-loaded — **no bundler, no install step**. The
shared [`delivery/`](../delivery/) server serves this page verbatim on port 5176.

> **Note (running before npm publish):** the CDN URL
> `https://esm.run/@csbc-dev/s3-uploader/auto/remoteEnv` resolves only once the
> package is published to npm. Until then, build the repo (`npm run build` in
> the root) and point that one `<script src>` at the local build using a
> **root-absolute** path: `/src/auto/remoteEnv.js`. Leave the `@wcstack/state`
> `<script src>` on its CDN URL — that package is already published, so only the
> `@csbc-dev/s3-uploader` line changes.
>
> A root-absolute path is used because `src/auto/remoteEnv.js` itself does
> `import "../../dist/index.js"`, so both `src/auto/` and `dist/` must be
> reachable from the serving root. The [`delivery/`](../delivery/) server maps
> `/src/` and `/dist/` to the repo root for exactly this reason — so you do
> **not** need to hand-serve the repo root yourself.
>
> **Verify the `@wcstack/state` CDN line.** This page assumes
> `https://esm.run/@wcstack/state/auto` is the published side-effect bootstrap
> subpath for that package. If the page loads but no `<wcs-state>` bindings
> apply, check the browser console for a 404/module-resolution error on that
> line and adjust the subpath (and consider pinning a version, e.g.
> `@wcstack/state@<version>/auto`) to match the package's actual `exports`.

## Setup

1. Start the [Core host](../server/) first:

   ```bash
   cd ../server
   cp .env.example .env       # edit S3_BUCKET / AWS_* (credentials live here)
   npm install
   npm run dev                # ws://localhost:8080/s3-uploader
   ```

2. Open [`index.html`](index.html) and set `window.S3_REMOTE_CORE_URL` to your
   server's WebSocket URL. `remoteSettingType: "env"` resolves the URL *only*
   from this global, so it is **required** — there is no implicit fallback. The
   committed file already sets the default `ws://localhost:8080/s3-uploader`, so
   you can skip this step unless your server runs elsewhere.

3. Serve it with the shared [`delivery/`](../delivery/) server, which puts this
   page on port **5176** — the origin registered in the bucket's CORS allowlist
   (see the [examples README](../README.md#s3-bucket-cors)). On any other port
   the browser's direct PUT to S3 is blocked by CORS.

   ```bash
   cd ../delivery
   npm start                  # serves wcstack-state on http://localhost:5176
   ```

   It serves `index.html` verbatim (CDN default), and also maps `/src/` and
   `/dist/` to the repo root for the pre-publish local-build swap above — so the
   same command works either way. To serve **only** this page on a custom port:
   `WCSTACK_PORT=5176 node ../delivery/server.js`. `file://` will not work.

## How remote mode is enabled here

- A classic inline `<script>` sets `window.S3_REMOTE_CORE_URL` during parse,
  before the deferred module scripts run.
- `@csbc-dev/s3-uploader/auto/remoteEnv` is the side-effect entrypoint that
  calls `bootstrapS3()` with `remoteSettingType: "env"`. When `<s3-uploader>`
  connects, it resolves `globalThis.S3_REMOTE_CORE_URL` and opens the WebSocket
  to the server-side Core.

## What this example demonstrates

- **`auto/remoteEnv` + `window.S3_REMOTE_CORE_URL`** — remote mode with zero
  bundler config; the URL comes from a global instead of a `bootstrapS3()` call.
- **`data-wcs` directly on `<s3-uploader>`** — `trigger` is a store-driven input
  (the upload command); `progress` / `loading` / `uploading` / `completed` /
  `url` / `key` / `etag` / `metadata` / `error` are outputs mirrored back. The
  Shell exposes the same surface whether the Core is local or remote.
- **The `File` stays imperative.** A `File` object cannot travel through a
  `data-wcs` string, so the file picker's `onPick` handler sets
  `document.getElementById("s3").file` directly. Unlike the framework clients
  (which start the upload imperatively via `el.upload()`), here only `trigger`
  is bound declaratively — `startUpload()` flips a store field that drives
  `data-wcs="trigger: uploadRequested"`, so the *start* gesture is declarative
  while the `File` selection stays imperative.
- **No `bucket` / credentials** on the element — the server owns them.
- `if:` templates render the progress bar, result block, and error banner; the
  native `<progress max="100" data-wcs="value: progressPercent">` is fed a
  rounded `loaded/total` percent (the same basis as the `percentLabel`, so the
  bar and the label never disagree).
