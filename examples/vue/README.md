# Vue example (remote mode)

Vite + Vue 3 upload client for `<s3-uploader>` running in **remote mode** —
`S3Core` runs on the [shared server](../server/), the browser PUTs the file
straight to S3. Uses
[`@wc-bindable/vue`](https://www.npmjs.com/package/@wc-bindable/vue)'s
`useWcBindable` composable.

## Setup

Start the [shared server](../server/) first, then:

```bash
cp .env.example .env       # then edit VITE_S3_REMOTE_URL if needed
npm install
npm run dev                # http://localhost:5175
```

> `@csbc-dev/s3-uploader` is referenced as `file:../..`. Run `npm install` and
> `npm run build` in the repo root once first so `dist/` exists.

## Configuration

| Variable | Notes |
|---|---|
| `VITE_S3_REMOTE_URL` | WebSocket URL of the server. Default `ws://localhost:8080/s3-uploader` |

There is **no bucket or AWS key** here — they live only in
[`../server/.env`](../server/.env.example).

## Things this example demonstrates

- `bootstrapS3({ remote: { … } })` in [`src/main.ts`](src/main.ts) — enables
  remote mode before the elements register.
- `useWcBindable` returns `{ ref, values }`. `binding.ref` is used both as the
  element's `:ref` and as the imperative handle (`binding.ref.value.upload()`);
  `binding.values` is the live reactive state.
- `<s3-uploader>` has **no `bucket` / credentials** — the server owns them.
- The only imperative lines are the two browser gestures (`el.file = …` on the
  picker `@change`, `el.upload()` on the button). `progress` / `loading` /
  `uploading` / `completed` / `url` / `key` / `etag` / `metadata` / `error` are
  fully reactive.
- `<s3-uploader>` is treated as a native element via `isCustomElement` in
  [`vite.config.ts`](vite.config.ts) and typed via
  [`src/s3-uploader.d.ts`](src/s3-uploader.d.ts).
