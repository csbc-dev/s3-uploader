// Shared WebSocket server for the @csbc-dev/s3-uploader examples.
//
// CSBC Case C: `S3Core` runs HERE, on the server. It owns the AWS credentials
// (through the `AwsS3Provider` it holds), signs every presigned URL, runs the
// multipart control plane, and fires post-process hooks. Each browser-side
// <s3-uploader> drives its own Core over WebSocket through RemoteCoreProxy
// (client) <-> RemoteShellProxy (server).
//
// The file BYTES never cross this socket — the browser PUTs them straight to
// S3 using the presigned URLs the Core mints. What flows here is signing
// requests, rAF-coalesced progress, and completion notifications. Server cost
// therefore scales with connections × signing rate, NOT with upload size.
//
// Use the `/server` subpath: the default barrel pulls in the browser custom
// elements (HTMLElement-based) and is not safe to load from Node.
import { WebSocketServer } from "ws";
import { RemoteShellProxy, WebSocketServerTransport } from "@wc-bindable/remote";
import { S3Core, AwsS3Provider } from "@csbc-dev/s3-uploader/server";

const port = Number(process.env.PORT ?? 8080);
const bucket = process.env.S3_BUCKET || "";
const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "";
const endpoint = process.env.S3_ENDPOINT || "";
const forcePathStyle = /^(1|true|yes|on)$/i.test(process.env.S3_FORCE_PATH_STYLE || "");
const basePrefix = process.env.S3_PREFIX || "s3-uploader-demo/";

if (!bucket) {
  console.error(
    "[s3-uploader] S3_BUCKET is required. Set it in .env (see .env.example).",
  );
  process.exit(1);
}

// `AwsS3Provider` reads AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION
// from the environment. It throws at construction if credentials or region are
// missing — fail fast with a readable message rather than on every connection.
// For an S3-compatible store (MinIO, R2, Wasabi, …) set S3_ENDPOINT and (for
// MinIO) S3_FORCE_PATH_STYLE.
let provider;
try {
  provider = new AwsS3Provider({
    ...(region ? { region } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(forcePathStyle ? { forcePathStyle } : {}),
  });
} catch (e) {
  console.error(
    "[s3-uploader] failed to construct AwsS3Provider:",
    e instanceof Error ? e.message : e,
  );
  console.error(
    "[s3-uploader] set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION " +
      "in .env (see .env.example).",
  );
  process.exit(1);
}

// S3Core subclass that PINS bucket + prefix server-side.
//
// `bucket` / `prefix` / `contentType` are wcBindable *inputs*: a client can set
// <s3-uploader bucket="…"> and it is mirrored to this Core via the remote
// proxy. That is a privilege-escalation vector — a client could aim uploads at
// any bucket the server's credentials can reach, or escape its own prefix into
// another tenant's namespace. We override the setters to ignore the client
// value and keep the server-resolved one. This is exactly the boundary the
// README's "Security — your responsibilities" section calls out: bind the
// prefix to the authenticated user, never trust the client. (Same pattern
// ai-agent's ServerAiCore uses to pin provider / model.)
//
// NOTE: `contentType` is deliberately NOT pinned here. Unlike bucket/prefix
// (security boundaries), contentType legitimately describes the file the
// client picked, so the server should accept it. If you need to *restrict*
// which types are allowed, that is a validation concern — wrap `IS3Provider`
// and throw from presignUpload / initiateMultipart (see the README's
// "Extension points" recipe and the "Constrain content-type" item under the
// server README's "Production hardening" section), NOT a setter override.
class ScopedS3Core extends S3Core {
  constructor(p, scopedBucket, scopedPrefix) {
    super(p);
    this._scopedBucket = scopedBucket;
    this._scopedPrefix = scopedPrefix;
    super.bucket = scopedBucket;
    super.prefix = scopedPrefix;
  }
  set bucket(_clientValue) {
    super.bucket = this._scopedBucket;
  }
  get bucket() {
    return super.bucket;
  }
  set prefix(_clientValue) {
    super.prefix = this._scopedPrefix;
  }
  get prefix() {
    return super.prefix;
  }
}

const wss = new WebSocketServer({ port, path: "/s3-uploader" });

let connSeq = 0;

wss.on("connection", (ws) => {
  // In production, derive the per-user namespace from the AUTHENTICATED
  // session (e.g. a user id from a verified token checked during the WS
  // upgrade — see `wss.on("upgrade", …)`). Here we fabricate a per-connection
  // prefix so every browser tab uploads into its own isolated folder.
  const sessionId = `${Date.now().toString(36)}-${(connSeq++).toString(36)}`;
  const prefix = `${basePrefix}${sessionId}/`;

  // One S3Core per connection — it owns the in-flight upload state machine and
  // the active multipart uploadId, and must not be shared across sessions.
  const core = new ScopedS3Core(provider, bucket, prefix);

  // Server-side post-process hook: runs AFTER the browser confirms the upload.
  // This is where a real app inserts a DB row, kicks off a virus scan,
  // generates a thumbnail, etc. Throwing here rejects the upload (`completed`
  // stays false, `error` is populated) — see the README's "Post-process
  // failure semantics". Here we just log.
  // The hook receives a `PostProcessContext`: { bucket, key, etag?, size?,
  // contentType? }. `bucket` is the destination the bytes actually landed in
  // (the server-pinned value, not anything the client supplied) — logged here
  // so the full ctx shape is visible; a real app would key its DB row on it.
  core.registerPostProcess(({ bucket, key, etag, size, contentType }) => {
    console.log(
      `[s3-uploader] upload complete: bucket=${bucket} key=${key} etag=${etag} ` +
        `size=${size ?? "?"} type=${contentType ?? "?"}`,
    );
  });

  // Wire the Core to this socket. From now on every Core property change
  // (progress / loading / uploading / completed / url / key / etag / metadata
  // / error) is forwarded across the wire to this client's RemoteCoreProxy,
  // and the client's signing RPCs are dispatched into the Core.
  const transport = new WebSocketServerTransport(ws);
  const shell = new RemoteShellProxy(core, transport);

  ws.on("close", () => {
    // LOAD-BEARING. Without this, an interrupted multipart leaves orphan parts
    // in S3 (and you keep paying for them): the client cannot reach
    // abortMultipart through a dead control channel, so this server-side hook
    // is the only path that actually cancels. Cheap no-op when idle.
    core.abort();
    shell.dispose();
  });

  console.log(`[s3-uploader] client connected — prefix=${prefix}`);
});

console.log(
  `[s3-uploader] remote Core listening on ws://localhost:${port}/s3-uploader`,
);
console.log(
  `[s3-uploader] bucket=${bucket} prefix=${basePrefix}<session>/ ` +
    `${endpoint ? `endpoint=${endpoint} ` : ""}` +
    `${forcePathStyle ? "forcePathStyle=true" : ""}`,
);
