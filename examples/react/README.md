# React example (remote mode)

Vite + React 19 upload client for `<s3-uploader>` running in **remote mode** —
`S3Core` runs on the [shared server](../server/), the browser PUTs the file
straight to S3. Uses
[`@wc-bindable/react`](https://www.npmjs.com/package/@wc-bindable/react)'s
`useWcBindable` hook.

## Setup

Start the [Core host](../server/) first. Then build this client and serve it via
the shared [delivery server](../delivery/):

```bash
cp .env.example .env       # then edit VITE_S3_REMOTE_URL if needed (baked in at build time)
npm install
npm run build              # → dist/
cd ../delivery && npm start   # serves this client on http://localhost:5174
```

> `@csbc-dev/s3-uploader` is referenced as `file:../..`. Run `npm install` and
> `npm run build` in the repo root once first so `dist/` exists.
>
> For hot-reload during development you can run `npm run dev` here instead (Vite
> dev server on :5174); the canonical run is build + delivery.

## Configuration

| Variable | Notes |
|---|---|
| `VITE_S3_REMOTE_URL` | WebSocket URL of the server. Default `ws://localhost:8080/s3-uploader` |

There is **no bucket or AWS key** here — they live only in
[`../server/.env`](../server/.env.example).

## The one React-specific detail: callback ref + fan-out

`useWcBindable` returns a **callback ref** (`(node) => void`), *not* a
`RefObject` — there is no `.current`. The state binding only needs that
callback, but the two browser gestures (`el.file = …`, `el.upload()`) need an
imperative handle, so [`src/App.tsx`](src/App.tsx) fans the callback ref out
into a `useState` slot:

```tsx
const [bindRef, values] = useWcBindable<WcsS3, WcsS3Values>();
const [el, setEl] = useState<WcsS3 | null>(null);
const setRef = useCallback((node: WcsS3 | null) => {
  bindRef(node);  // (a) the wcBindable subscriber
  setEl(node);    // (b) our imperative handle
}, [bindRef]);
// …
<s3-uploader ref={setRef} multipart-threshold="8388608" />
```

## Things this example demonstrates

- `bootstrapS3({ remote: { … } })` in [`src/main.tsx`](src/main.tsx) — enables
  remote mode before the elements register.
- `<s3-uploader>` has **no `bucket` / credentials** — the server owns them.
- `useWcBindable` and `el.upload()` are exactly what you'd write for a local
  element — the hook does not care that the Core is proxied over WebSocket.
- `progress` / `loading` / `uploading` / `completed` / `url` / `key` / `etag` /
  `metadata` are synced from the server-side Core; connection failures surface
  through the same `error` property.
- `<s3-uploader>` is typed via [`src/s3-uploader.d.ts`](src/s3-uploader.d.ts)
  (JSX intrinsic-element augmentation).
