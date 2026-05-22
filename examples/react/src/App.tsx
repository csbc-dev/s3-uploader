import { useCallback, useState } from "react";
import type { ChangeEvent } from "react";
import { useWcBindable } from "@wc-bindable/react";
import type { WcsS3, WcsS3Values, S3Progress } from "@csbc-dev/s3-uploader";

function pct(p?: S3Progress): number {
  return p && p.total ? Math.round((p.loaded / p.total) * 100) : 0;
}

function fmtBytes(n?: number): string {
  if (n == null || Number.isNaN(n)) return "";
  if (n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// `error` is `WcsS3AnyError` = S3Error | Error | SerializedError | null. Every
// non-null shape carries a `message`; fall back to String() otherwise.
function errorText(err: unknown): string {
  if (!err) return "";
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (m) return String(m);
  }
  return String(err);
}

export default function App() {
  // useWcBindable returns a CALLBACK ref (not a RefObject — there is no
  // `.current`) plus the live value object. The Core being remote is
  // transparent to the hook: it binds the proxied element exactly as a local
  // one. We fan the callback ref out so we ALSO keep an imperative handle for
  // the two browser gestures (`el.file = …`, `el.upload()`). React invokes
  // callback refs with the node on mount and `null` on unmount.
  const [bindRef, values] = useWcBindable<WcsS3, WcsS3Values>();
  const [el, setEl] = useState<WcsS3 | null>(null);
  const setRef = useCallback(
    (node: WcsS3 | null) => {
      bindRef(node);
      setEl(node);
    },
    [bindRef],
  );

  const [file, setFile] = useState<File | null>(null);

  const { progress, loading, uploading, completed, url, key, etag, metadata, error } = values;
  const busy = !!loading || !!uploading;

  const status = error ? "Error" : completed ? "Done" : busy ? progress?.phase ?? "Working" : "Ready";
  const badgeClass = error ? "badge error" : completed ? "badge done" : "badge";

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    if (el) {
      el.file = f;
      // Reset Core state when a NEW file is picked. `completed` is a
      // Core-mirrored output: it stays true after a finished upload and is NOT
      // cleared by setting `file`. Without this, the Upload-disabled-when-
      // `completed` guard would stay stuck and block a second file for the rest
      // of the page load. `abort()` at idle is safe — it dispatches no error,
      // just resets completed / url / etag / metadata / progress to the clean
      // state (verified in S3Core.abort()), also clearing the stale result.
      el.abort();
    }
  }

  function onUpload() {
    // Block once `completed` too — re-pressing would PUT the same file to the
    // same key again.
    if (!el || !file || busy || completed) return;
    // upload() resolves with the download URL; failures surface through the
    // bound `error` (rendered below), so we swallow the rejection here.
    el.upload().catch(() => {});
  }

  return (
    <div className="app">
      <div className="hero">
        <h1>React — @csbc-dev/s3-uploader</h1>
        <p>
          Remote mode. <code>S3Core</code> signs URLs on the server; the browser
          PUTs straight to S3. <code>useWcBindable</code> binds{" "}
          <code>&lt;s3-uploader&gt;</code>.
        </p>
      </div>

      {/* Headless I/O node — proxies a server-side Core over WebSocket.
          No bucket / credentials: the server owns them.
          multipart-threshold="8388608" (8 MiB) is the package DEFAULT, set
          explicitly here only to mark where you'd tune the single-PUT vs.
          multipart cutover; lower it to force the multipart path for demos. */}
      <s3-uploader ref={setRef} multipart-threshold="8388608" />

      <div className="card">
        <div className="card-head">
          <h2>Upload</h2>
          <span className={badgeClass}>{status}</span>
        </div>

        <div className="body">
          <div className="drop">
            <input type="file" onChange={onPick} aria-label="Choose a file to upload" />
            {file && (
              <div className="file-info">
                <strong>{file.name}</strong> · {fmtBytes(file.size)}
              </div>
            )}
          </div>

          <div className="controls">
            <button className="btn" onClick={onUpload} disabled={!file || busy || !!completed}>
              Upload
            </button>
            {busy && (
              <button className="btn ghost" onClick={() => el?.abort()}>
                Abort
              </button>
            )}
          </div>

          {busy && (
            <div className="progress">
              <div className="bar">
                <div className="bar-fill" style={{ width: `${pct(progress)}%` }} />
              </div>
              <div className="progress-meta">
                <span>{progress?.phase}</span>
                <span>{pct(progress)}%</span>
              </div>
            </div>
          )}

          {completed && url && (
            <div className="result">
              <h3>Uploaded ✓</h3>
              <dl>
                <dt>key</dt>
                <dd>{key}</dd>
                <dt>etag</dt>
                <dd>{etag}</dd>
                <dt>size</dt>
                <dd>{metadata?.size != null ? fmtBytes(metadata.size) : ""}</dd>
              </dl>
              <p style={{ margin: "10px 0 0" }}>
                <a href={url} target="_blank" rel="noopener">
                  Open presigned download URL ↗
                </a>
              </p>
            </div>
          )}

          {error && <p className="err">{errorText(error)}</p>}
        </div>
      </div>
    </div>
  );
}
