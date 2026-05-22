# Shared server

Shared WebSocket server for the four `@csbc-dev/s3-uploader` clients. Runs
`S3Core` server-side (CSBC **Case C**) and exposes it to browser-side
`<s3-uploader>` elements through `RemoteShellProxy` + `WebSocketServerTransport`
from `@wc-bindable/remote`.

The AWS credentials live only in this process's environment. The browser
receives nothing but short-lived presigned URLs, and the file bytes go straight
from the browser to S3 — they never pass through this server.

## Setup

```bash
cp .env.example .env       # then edit S3_BUCKET / AWS_*
npm install
npm run dev                # ws://localhost:8080/s3-uploader
```

> `@csbc-dev/s3-uploader` is referenced as `file:../..`. Run `npm install` and
> `npm run build` in the repo root once first so `dist/` exists.

Requires Node 20.12+ (uses `node --env-file-if-exists`).

## Configuration

Edit `.env` (see [`.env.example`](.env.example)):

| Variable | Required | Notes |
|---|---|---|
| `S3_BUCKET` | ✅ | Target bucket. The client never sets it — the server pins it |
| `AWS_ACCESS_KEY_ID` | ✅¹ | Stays on the server |
| `AWS_SECRET_ACCESS_KEY` | ✅¹ | Stays on the server |
| `AWS_SESSION_TOKEN` | — | For temporary STS credentials |
| `AWS_REGION` | ✅ | Bucket region (`AWS_DEFAULT_REGION` also accepted) |
| `S3_PREFIX` | — | Base prefix; server appends a per-connection segment. Default `s3-uploader-demo/` |
| `S3_ENDPOINT` | — | Custom endpoint for S3-compatible stores (MinIO, R2, Wasabi) |
| `S3_FORCE_PATH_STYLE` | — | `true` for MinIO; optional for R2 |
| `PORT` | — | WebSocket port. Default `8080`. If you change it, update every client's connection URL too: the Vite clients' `VITE_S3_REMOTE_URL` (each `.env`) and `wcstack-state`'s `window.S3_REMOTE_CORE_URL` (`index.html`). |

¹ `AwsS3Provider` throws at startup if credentials or region are missing — the
server exits with a readable message rather than failing per-connection.

### IAM permissions (real AWS)

The server's credentials sign every request, so the IAM identity behind
`AWS_ACCESS_KEY_ID` needs permission for the S3 operations this demo actually
performs. With a least-privilege policy, CORS can pass yet the *signed* request
still 403s — so grant exactly these (no more):

| Action | Why it is needed |
|---|---|
| `s3:PutObject` | The single-PUT upload **and** every multipart phase — CreateMultipartUpload, UploadPart, CompleteMultipartUpload all authorize under `s3:PutObject` (AWS has no separate per-phase action) |
| `s3:GetObject` | The post-upload preview link — `<s3-uploader>` shows a presigned GET URL for the finished object |
| `s3:AbortMultipartUpload` | The load-bearing `core.abort()` cleanup on WebSocket close — aborts an interrupted multipart so S3 does not retain (and bill for) orphan parts |

`s3:DeleteObject` is **not** needed for the upload flow; add it only if your app
calls the Core's `deleteObject` command. This demo never does. The demo also
does not list parts/uploads, so no `s3:ListMultipartUploadParts` /
`s3:ListBucketMultipartUploads` is required (the part list is tracked
client-side and sent in the Complete request body).

Minimal policy (scope `Resource` to the bucket + prefix you actually use):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:AbortMultipartUpload"],
      "Resource": "arn:aws:s3:::YOUR_BUCKET/s3-uploader-demo/*"
    }
  ]
}
```

> CORS (the [examples README](../README.md#s3-bucket-cors)) and IAM are
> **independent** gates: CORS lets the browser's request reach S3; IAM decides
> whether the *signed* request is allowed. A pass on one does not imply the
> other — an `AccessDenied` after CORS succeeds points at the IAM policy.

### S3-compatible stores

The easiest zero-AWS setup is [MinIO](https://min.io/) — no IAM policy to
attach (the root credentials below can do everything the demo needs).

**1. Start MinIO** (Docker; API on `:9000`, web console on `:9001`):

```bash
docker run -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=minioadmin \
  -e MINIO_ROOT_PASSWORD=minioadmin \
  minio/minio server /data --console-address ":9001"
```

**2. Create the bucket.** Open the console at <http://localhost:9001> (log in
with the credentials above) and create a bucket named `my-uploads` — or, if you
have the [MinIO client](https://min.io/docs/minio/linux/reference/minio-mc.html)
`mc` installed:

```bash
mc alias set local http://localhost:9000 minioadmin minioadmin
mc mb local/my-uploads
```

**3. Point the server at it** (`.env`):

```bash
S3_ENDPOINT=http://localhost:9000
S3_FORCE_PATH_STYLE=true
S3_BUCKET=my-uploads
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=minioadmin
AWS_SECRET_ACCESS_KEY=minioadmin
```

**4. CORS still applies.** The browser PUTs **directly** to MinIO, so MinIO must
allow the client origins just like an S3 bucket does. MinIO manages CORS at the
server level (its handling has changed across releases) — see the
[MinIO documentation](https://min.io/docs/minio/linux/index.html) for the
configuration matching your version. The required origins/methods are the same
as the AWS list in the [examples README](../README.md#s3-bucket-cors).

## How it works

- **One `S3Core` per WebSocket connection.** It owns the upload state machine
  and the active multipart `uploadId`, so it must not be shared across sessions.
  `ws.on("close")` calls `core.abort()` + `shell.dispose()`.
- **`core.abort()` on close is load-bearing.** Without it, an interrupted
  multipart leaves orphan parts in S3 (which you keep paying for) — the client
  cannot reach `abortMultipart` through a dead control channel, so this
  server-side hook is the only path that actually cancels.
- **`ScopedS3Core extends S3Core`** pins `bucket` and `prefix` server-side.
  They are wcBindable *inputs*, so a client could otherwise mirror
  `<s3-uploader bucket="…">` into the Core and escape its namespace or target
  another bucket. The overridden setters ignore the client value — the security
  boundary the README's "Security — your responsibilities" section requires.
- **Per-connection prefix** stands in for per-user scoping. In production you'd
  derive it from the authenticated session during the WS upgrade.
- **`registerPostProcess` hook** runs after the browser confirms completion.
  Here it just logs; a real app would insert a DB row, scan, thumbnail, etc.
- The four clients all connect to this one server. See [`../README.md`](../README.md).

## Production hardening (not done here, on purpose)

This demo is deliberately minimal. Before exposing it to real users, also:

- **Authenticate the WebSocket upgrade** (`wss.on("upgrade", …)`) — the bare
  `WebSocketServer` accepts anyone who can reach the port.
- **Validate `key`** (reject `..`, control chars, absolute paths, overlong keys).
- **Constrain `content-type`** and **enforce a max file size** — wrap
  `IS3Provider` and throw from `presignUpload` / `initiateMultipart` before any
  URL is minted. See the README's "Extension points" recipe.
- **Add a bucket lifecycle rule** (`AbortIncompleteMultipartUpload`) as the
  backstop for the residual "best-effort abort itself failed" case.
