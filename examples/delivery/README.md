# Static delivery server

One dependency-free Node process that serves all four front-end demos as
**static files** — each on its own fixed port:

| Front-end | Port | Serves |
|---|---|---|
| `vanilla` | 5173 | `../vanilla/dist` (`vite build` output) |
| `react` | 5174 | `../react/dist` (`vite build` output) |
| `vue` | 5175 | `../vue/dist` (`vite build` output) |
| `wcstack-state` | 5176 | `../wcstack-state/index.html` verbatim (+ `/src/` and `/dist/` from the repo root, pre-publish only) |

This server does **no** S3 work and holds **no** credentials — that is the
[Core host](../server/) (`../server`, a separate WebSocket process on `:8080`).
The file bytes never pass through here either; the browser PUTs them straight to
S3. This process only hands the browser the built HTML/JS/CSS.

## Use

Build the three Vite clients first (each: `npm install && npm run build` →
`dist/`), then:

```bash
npm start        # serves vanilla:5173 react:5174 vue:5175 wcstack-state:5176
```

Start the [Core host](../server/) (`cd ../server && npm run dev`) too — the
pages connect to it directly over WebSocket.

> Each client bakes its `VITE_S3_REMOTE_URL` in at **build time**, so set each
> client's `.env` before `npm run build`. `wcstack-state` reads
> `window.S3_REMOTE_CORE_URL` at runtime from its `index.html` instead.

## Ports

Ports are **fixed** because each is the page's browser origin, which must be in
the target **S3 bucket's CORS `AllowedOrigins`** (see
[examples/README.md](../README.md#s3-bucket-cors)) — otherwise the browser's
direct PUT to S3 is blocked. Override with `VANILLA_PORT` / `REACT_PORT` /
`VUE_PORT` / `WCSTACK_PORT`, but then add the new origin to the bucket CORS too.

## wcstack-state pre-publish note

Until `@csbc-dev/s3-uploader` is published to npm, `wcstack-state/index.html`
must load the package from a local build instead of the CDN. Swap that one
`<script src>` to the root-absolute `/src/auto/remoteEnv.js` (see
[`../wcstack-state/README.md`](../wcstack-state/README.md)); this server already
maps `/src/` and `/dist/` to the repo root so that path — and the
`import "../../dist/index.js"` inside it — resolves. After publish, the page
uses the CDN and neither mapping is touched.
