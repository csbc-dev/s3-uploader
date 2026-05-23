# Vanilla example (remote mode)

Pure-JS upload client for `<s3-uploader>` running in **remote mode** — `S3Core`
runs on the [shared server](../server/), the browser PUTs the file straight to
S3. Binding is done imperatively with `bind()` from
[`@wc-bindable/core`](https://www.npmjs.com/package/@wc-bindable/core).

## Setup

Start the [Core host](../server/) first. Then build this client and serve it via
the shared [delivery server](../delivery/):

```bash
cp .env.example .env       # then edit VITE_S3_REMOTE_URL if needed (baked in at build time)
npm install
npm run build              # → dist/
cd ../delivery && npm start   # serves this client on http://localhost:5173
```

> `@csbc-dev/s3-uploader` is referenced as `file:../..`. Run `npm install` and
> `npm run build` in the repo root once first so `dist/` exists.
>
> For hot-reload during development you can run `npm run dev` here instead (Vite
> dev server on :5173); the canonical run is build + delivery.

## Configuration

| Variable | Notes |
|---|---|
| `VITE_S3_REMOTE_URL` | WebSocket URL of the server. Default `ws://localhost:8080/s3-uploader` |

There is **no bucket or AWS key** here — that is the point of remote mode. They
live only in [`../server/.env`](../server/.env.example).

## Things this example demonstrates

- `bootstrapS3({ remote: { enableRemote: true, remoteSettingType: "config", remoteCoreUrl } })`
  — applies the config, then registers the elements, so `<s3-uploader>` upgrades
  straight into remote mode.
- `bind(el, cb)` mirrors `progress` / `loading` / `uploading` / `completed` /
  `url` / `key` / `etag` / `metadata` / `error` from the server-side Core over
  WebSocket — identical to how you'd bind a local element.
- The only imperative lines are the two browser gestures: `s3.file = file` on
  the picker's `change`, and `s3.upload()` on the button click. Everything else
  is reactive.
- Connection / transport failures surface through the same `error` property as
  provider errors.
