import { describe, it, expect, vi, beforeEach } from "vitest";
import { isJsonValue } from "@wc-bindable/remote";
import { S3Core } from "../src/core/S3Core";
import {
  IS3Provider, S3RequestOptions, PresignedUpload, PresignedDownload, MultipartPart,
} from "../src/types";

class FakeProvider implements IS3Provider {
  uploadCalls: Array<{ key: string; opts: S3RequestOptions }> = [];
  downloadCalls: Array<{ key: string; opts: S3RequestOptions }> = [];
  deleteCalls: Array<{ key: string; opts: S3RequestOptions }> = [];
  initiateCalls: Array<{ key: string; opts: S3RequestOptions }> = [];
  partCalls: Array<{ key: string; uploadId: string; partNumber: number }> = [];
  completeCalls: Array<{ key: string; uploadId: string; parts: MultipartPart[] }> = [];
  abortCalls: Array<{ key: string; uploadId: string }> = [];
  // Typed `unknown` so tests can pin non-Error throws (bare strings, plain
  // objects with a `message` field, etc.) to exercise the `normaliseError`
  // branches that project arbitrary rejection shapes onto `WcsS3AnyError`.
  presignError: unknown = null;
  deleteError: Error | null = null;
  initiateError: Error | null = null;
  presignPartError: Error | null = null;
  completeMultipartError: Error | null = null;
  nextUploadId: string = "upload-1";

  async presignUpload(key: string, opts: S3RequestOptions): Promise<PresignedUpload> {
    if (this.presignError) throw this.presignError;
    this.uploadCalls.push({ key, opts });
    return {
      url: `https://example.com/upload/${key}`,
      method: "PUT",
      headers: opts.contentType ? { "Content-Type": opts.contentType } : {},
      expiresAt: Date.now() + 60_000,
    };
  }

  async presignDownload(key: string, opts: S3RequestOptions): Promise<PresignedDownload> {
    this.downloadCalls.push({ key, opts });
    return {
      url: `https://example.com/download/${key}`,
      method: "GET",
      expiresAt: Date.now() + 60_000,
    };
  }

  async deleteObject(key: string, opts: S3RequestOptions): Promise<void> {
    if (this.deleteError) throw this.deleteError;
    this.deleteCalls.push({ key, opts });
  }

  async initiateMultipart(key: string, opts: S3RequestOptions): Promise<{ uploadId: string }> {
    if (this.initiateError) throw this.initiateError;
    this.initiateCalls.push({ key, opts });
    return { uploadId: this.nextUploadId };
  }

  async presignPart(key: string, uploadId: string, partNumber: number, _opts: S3RequestOptions): Promise<PresignedUpload> {
    if (this.presignPartError) throw this.presignPartError;
    this.partCalls.push({ key, uploadId, partNumber });
    return {
      url: `https://example.com/upload/${key}?partNumber=${partNumber}&uploadId=${uploadId}`,
      method: "PUT",
      headers: {},
      expiresAt: Date.now() + 60_000,
    };
  }

  async completeMultipart(key: string, uploadId: string, parts: MultipartPart[], _opts: S3RequestOptions): Promise<{ etag: string }> {
    if (this.completeMultipartError) throw this.completeMultipartError;
    this.completeCalls.push({ key, uploadId, parts });
    return { etag: "merged-etag" };
  }

  async abortMultipart(key: string, uploadId: string, _opts: S3RequestOptions): Promise<void> {
    this.abortCalls.push({ key, uploadId });
  }
}

function flushRaf(): Promise<void> {
  // happy-dom rAF polyfill is setTimeout(0); two macrotask ticks let it drain.
  return new Promise(r => setTimeout(r, 0));
}

describe("S3Core", () => {
  let provider: FakeProvider;
  let core: S3Core;

  beforeEach(() => {
    provider = new FakeProvider();
    core = new S3Core(provider);
    core.bucket = "test-bucket";
  });

  it("declares the wcBindable protocol", () => {
    expect(S3Core.wcBindable.protocol).toBe("wc-bindable");
    expect(S3Core.wcBindable.version).toBe(1);
    const propNames = S3Core.wcBindable.properties.map(p => p.name);
    expect(propNames).toContain("url");
    expect(propNames).toContain("progress");
    expect(propNames).toContain("completed");
    const cmdNames = (S3Core.wcBindable.commands ?? []).map(c => c.name);
    expect(cmdNames).toContain("requestUpload");
    expect(cmdNames).toContain("complete");
  });

  it("requestUpload returns a presigned URL and updates state", async () => {
    const events: any[] = [];
    core.addEventListener("s3-uploader:url-changed", (e: any) => events.push(["url", e.detail]));
    core.addEventListener("s3-uploader:uploading-changed", (e: any) => events.push(["uploading", e.detail]));

    const result = await core.requestUpload("file.txt", 1000, "text/plain");
    expect(result.url).toBe("https://example.com/upload/file.txt");
    expect(result.method).toBe("PUT");
    expect(core.uploading).toBe(true);
    expect(core.key).toBe("file.txt");
    expect(core.metadata).toEqual({ size: 1000, contentType: "text/plain" });
    // The PUT URL must NOT leak into public state. README documents `url` as
    // the post-completion GET URL; broadcasting the write-capable PUT URL
    // here would violate that contract and expose a credential-bearing
    // token to every binding/logger subscribed to `s3-uploader:url-changed`.
    expect(events.some(e => e[0] === "url")).toBe(false);
    expect(core.url).toBe("");
    expect(events.some(e => e[0] === "uploading" && e[1] === true)).toBe(true);
  });

  it("s3-uploader:url-changed only fires after complete (single PUT)", async () => {
    const urlEvents: any[] = [];
    core.addEventListener("s3-uploader:url-changed", (e: any) => urlEvents.push(e.detail));
    await core.requestUpload("file.txt", 100);
    expect(urlEvents).toEqual([]);
    expect(core.url).toBe("");
    const downloadUrl = await core.complete("file.txt", "abc");
    expect(urlEvents).toEqual([downloadUrl]);
    expect(core.url).toBe(downloadUrl);
    // The exposed URL is the GET URL, not the PUT URL captured during requestUpload.
    expect(downloadUrl).toBe("https://example.com/download/file.txt");
  });

  it("requestUpload throws when bucket is missing", async () => {
    const c = new S3Core(provider);
    await expect(c.requestUpload("k", 0)).rejects.toThrow(/bucket/);
  });

  it("requestUpload propagates provider errors and resets busy state", async () => {
    provider.presignError = new Error("boom");
    await expect(core.requestUpload("k", 1)).rejects.toThrow("boom");
    expect(core.uploading).toBe(false);
    expect(core.loading).toBe(false);
    expect(core.error).toEqual({ name: "Error", message: "boom" });
  });

  it("reportProgress coalesces via rAF and dispatches a snapshot", async () => {
    await core.requestUpload("k", 1000);
    const snapshots: any[] = [];
    core.addEventListener("s3-uploader:progress-changed", (e: any) => snapshots.push(e.detail));
    core.reportProgress(100, 1000);
    core.reportProgress(500, 1000);
    core.reportProgress(900, 1000);
    expect(snapshots).toHaveLength(0); // batched
    await flushRaf();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual({ loaded: 900, total: 1000, phase: "uploading" });
  });

  it("reportProgress is ignored when no upload is active", async () => {
    const snapshots: any[] = [];
    core.addEventListener("s3-uploader:progress-changed", (e: any) => snapshots.push(e.detail));
    core.reportProgress(100, 1000);
    await flushRaf();
    expect(snapshots).toHaveLength(0);
  });

  it("reportProgress clamps loaded > total so untrusted reports cannot push the bar past 100%", async () => {
    // Browser XHR guards this via `ev.lengthComputable`, but reports
    // arriving through the remote proxy (or any custom Shell transport)
    // are untrusted input — a buggy/hostile client that fires
    // {loaded: 1e12, total: 1} would otherwise flow straight through to
    // `progress` and drive the UI into a wildly inflated >100% state.
    // Silently clamp `loaded` down to `total` so the invariant every
    // consumer assumes (0 <= loaded <= total) holds.
    await core.requestUpload("k", 1000);
    const snapshots: any[] = [];
    core.addEventListener("s3-uploader:progress-changed", (e: any) => snapshots.push(e.detail));
    // Absurdly inflated loaded vs. a tiny total — classic hostile shape.
    core.reportProgress(1e12, 1);
    await flushRaf();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual({ loaded: 1, total: 1, phase: "uploading" });
    // And a plain "loaded slightly exceeds total" case also clamps.
    core.reportProgress(2000, 1000);
    await flushRaf();
    expect(snapshots.at(-1)).toEqual({ loaded: 1000, total: 1000, phase: "uploading" });
  });

  it("reportProgress(loaded, 0) does not trigger the clamp (total unknown is legal)", async () => {
    // The clamp guards on `total > 0` so a "total unknown" report (total=0
    // during signing or fallback paths) still passes through unchanged.
    // Otherwise we would coerce `loaded` to 0 on every such report and
    // hide legitimate progress.
    await core.requestUpload("k", 0);
    const snapshots: any[] = [];
    core.addEventListener("s3-uploader:progress-changed", (e: any) => snapshots.push(e.detail));
    core.reportProgress(500, 0);
    await flushRaf();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual({ loaded: 500, total: 0, phase: "uploading" });
  });

  it("complete runs post-process hooks in order then exposes a download URL", async () => {
    await core.requestUpload("file.bin", 10, "application/octet-stream");
    const seen: string[] = [];
    core.registerPostProcess(async (ctx) => { seen.push(`a:${ctx.key}:${ctx.etag}`); });
    core.registerPostProcess(async () => { seen.push("b"); });

    const url = await core.complete("file.bin", "abc123");
    expect(seen).toEqual(["a:file.bin:abc123", "b"]);
    expect(url).toBe("https://example.com/download/file.bin");
    expect(core.url).toBe(url);
    expect(core.completed).toBe(true);
    expect(core.uploading).toBe(false);
    expect(core.etag).toBe("abc123");
  });

  it("complete short-circuits if a hook throws", async () => {
    await core.requestUpload("k", 1);
    const seen: string[] = [];
    core.registerPostProcess(() => { throw new Error("hook fail"); });
    core.registerPostProcess(() => { seen.push("never"); });
    await expect(core.complete("k", "et")).rejects.toThrow("hook fail");
    expect(seen).toEqual([]);
    expect(core.error).toEqual({ name: "Error", message: "hook fail" });
    expect(core.uploading).toBe(false);
  });

  it("non-fatal hook failure does not abort the chain", async () => {
    await core.requestUpload("k", 1);
    const seen: string[] = [];
    const warnings: any[] = [];
    core.addEventListener("s3-uploader:postprocess-warning", (e) => {
      warnings.push((e as CustomEvent).detail);
    });
    core.registerPostProcess(() => { seen.push("a"); });
    core.registerPostProcess(() => { throw new Error("audit log down"); }, { fatal: false });
    core.registerPostProcess(() => { seen.push("c"); });
    const url = await core.complete("k", "et");
    expect(seen).toEqual(["a", "c"]);
    expect(url).toBe("https://example.com/download/k");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].error.message).toBe("audit log down");
    expect(warnings[0].ctx.key).toBe("k");
    expect(core.completed).toBe(true);
    expect(core.error).toBeNull();
  });

  it("fatal hook (default) still aborts even when a later hook is non-fatal", async () => {
    await core.requestUpload("k", 1);
    const seen: string[] = [];
    core.registerPostProcess(() => { throw new Error("gate fail"); }); // fatal default
    core.registerPostProcess(() => { seen.push("never"); }, { fatal: false });
    await expect(core.complete("k", "et")).rejects.toThrow("gate fail");
    expect(seen).toEqual([]);
  });

  it("complete refuses key mismatch", async () => {
    await core.requestUpload("a", 1);
    await expect(core.complete("b", "x")).rejects.toThrow(/key mismatch/);
  });

  it("complete refuses when no upload is active", async () => {
    await expect(core.complete("k", "x")).rejects.toThrow(/without an active upload/);
  });

  it("complete validates against the upload snapshot key, not the mutable _key slot", async () => {
    // Regression guard: previously, `complete()` checked `key !== this._key`.
    // `requestDownload(otherKey)` is a legal public command and calls
    // `_setKey(otherKey)` — so a download issued mid-upload would clobber
    // `this._key` and cause the subsequent (correct) `complete(uploadKey, ...)`
    // to fail with a spurious "key mismatch". The fix captures the key in
    // `_singleUpload` at requestUpload time and validates against that.
    await core.requestUpload("upload.bin", 1);
    // Simulate an unrelated download issued while the upload is in flight.
    // `presignDownload` setter inside `requestDownload` mutates `_key` to
    // "other.bin", which would have broken the old validator.
    await core.requestDownload("other.bin");
    // The mutable slot is now wrong, but completion with the original key
    // must still succeed because the snapshot remembers "upload.bin".
    const url = await core.complete("upload.bin", "etag-1");
    expect(url).toContain("upload.bin");
    expect(core.completed).toBe(true);
  });

  it("complete rejects the download's key after an interleaving requestDownload", async () => {
    // Mirror of the test above: passing the key that `requestDownload` left
    // in `this._key` must NOT accidentally be accepted. The snapshot is the
    // sole source of truth for "what upload is this completing".
    await core.requestUpload("upload.bin", 1);
    await core.requestDownload("other.bin");
    await expect(core.complete("other.bin", "etag")).rejects.toThrow(/key mismatch: expected upload.bin/);
  });

  it("registerPostProcess returns a disposer", async () => {
    await core.requestUpload("k", 1);
    const seen: string[] = [];
    const dispose = core.registerPostProcess(() => { seen.push("x"); });
    dispose();
    await core.complete("k", "e");
    expect(seen).toEqual([]);
  });

  it("abort drops in-flight uploads silently (stale generation)", async () => {
    await core.requestUpload("k1", 100);
    core.abort();
    expect(core.uploading).toBe(false);
    expect(core.progress.phase).toBe("idle");
    // Stale completion is dropped without throwing.
    // (We cannot call complete because uploading=false fails the precheck —
    // verify by starting a new upload and ensuring generation skip works.)
    await core.requestUpload("k2", 100);
    const slowHook = vi.fn(async () => {
      // Bump generation mid-hook.
      core.abort();
    });
    core.registerPostProcess(slowHook);
    const url = await core.complete("k2", "e");
    expect(slowHook).toHaveBeenCalled();
    expect(url).toBe(""); // stale generation -> empty
  });

  it("abort() after a successful upload clears completed=true", async () => {
    // Regression pin: abort() previously left `completed=true` standing from
    // the prior successful upload, which (a) misrepresented the element's
    // state after the abort call, and (b) would cause a fresh subsequent
    // upload's `_setCompleted(true)` to no-op (already true) and skip
    // firing `s3-uploader:completed-changed`.
    await core.requestUpload("k", 1);
    await core.complete("k", "etag");
    expect(core.completed).toBe(true);

    const events: boolean[] = [];
    core.addEventListener("s3-uploader:completed-changed", (e) => {
      events.push((e as CustomEvent).detail);
    });
    core.abort();
    expect(core.completed).toBe(false);
    expect(events).toEqual([false]);
  });

  it("abort() after a successful upload clears url/etag/metadata to match completed=false", async () => {
    // Regression pin: abort() must return the element to a fully-idle state.
    // Previously `completed` was flipped to false but `url`, `etag`, and
    // `metadata` were left holding the successful upload's values —
    // internally inconsistent (consumers see `completed=false` alongside a
    // populated `url`/`etag`) and a spec hazard for UI bindings that echo
    // the last-known GET URL into the DOM after an abort.
    await core.requestUpload("idle-after-abort", 42, "text/plain");
    await core.complete("idle-after-abort", "etag-kept");
    expect(core.url).not.toBe("");
    expect(core.etag).toBe("etag-kept");
    expect(core.metadata).not.toBeNull();

    const urlEvents: string[] = [];
    const etagEvents: string[] = [];
    const metadataEvents: Array<unknown> = [];
    core.addEventListener("s3-uploader:url-changed", (e) => urlEvents.push((e as CustomEvent).detail));
    core.addEventListener("s3-uploader:etag-changed", (e) => etagEvents.push((e as CustomEvent).detail));
    core.addEventListener("s3-uploader:metadata-changed", (e) => metadataEvents.push((e as CustomEvent).detail));

    core.abort();

    expect(core.url).toBe("");
    expect(core.etag).toBe("");
    expect(core.metadata).toBeNull();
    // Observers must see the false-transition events so mirrored state
    // (remote proxy, reactive framework bindings) stays in lockstep.
    expect(urlEvents).toEqual([""]);
    expect(etagEvents).toEqual([""]);
    expect(metadataEvents).toEqual([null]);
  });

  it("requestDownload returns a presigned GET URL", async () => {
    const r = await core.requestDownload("foo.txt");
    expect(r.url).toBe("https://example.com/download/foo.txt");
    expect(core.url).toBe(r.url);
    expect(core.key).toBe("foo.txt");
  });

  it("a failed requestDownload does not clobber a concurrent upload's error generation", async () => {
    // Regression guard: `requestDownload` is a legal command to run while an
    // upload is in flight. Its `presignDownload` failure path must be guarded
    // by the same generation check every other command uses — otherwise a
    // failed download presign calls `_setError` and fires `s3-uploader:error`
    // against the active upload's generation, even though the upload itself is
    // fine.
    let releaseDownload: () => void = () => {};
    const downloadGate = new Promise<void>(r => { releaseDownload = r; });
    provider.presignDownload = async () => {
      await downloadGate;
      throw new Error("download presign boom");
    };

    // Start a download against the (currently idle) core, then start a fresh
    // upload that bumps the generation while the download presign is stalled.
    const errorEvents: unknown[] = [];
    core.addEventListener("s3-uploader:error", (e) => {
      errorEvents.push((e as CustomEvent).detail);
    });
    const download = core.requestDownload("download.bin");
    await core.requestUpload("upload.bin", 10);
    // Now let the stalled download presign reject. It belongs to the prior
    // generation, so it must NOT touch `_error` or emit `s3-uploader:error`.
    releaseDownload();
    await expect(download).rejects.toThrow("download presign boom");

    expect(core.error).toBeNull();
    expect(errorEvents).toEqual([]);
  });

  it("a failed deleteObject does not clobber a concurrent upload's error generation", async () => {
    // Regression guard, symmetric with the requestDownload case above:
    // `deleteObject` is a legal command to run mid-upload (different key, or
    // same key after an explicit abort). Its `deleteObject` provider failure
    // must be generation-guarded — otherwise a failed delete's `_setError(e)`
    // overwrites the in-flight upload's `_error` and spuriously fires
    // `s3-uploader:error` against that upload's generation.
    let releaseDelete: () => void = () => {};
    const deleteGate = new Promise<void>(r => { releaseDelete = r; });
    provider.deleteObject = async () => {
      await deleteGate;
      throw new Error("delete boom");
    };

    const errorEvents: unknown[] = [];
    core.addEventListener("s3-uploader:error", (e) => {
      errorEvents.push((e as CustomEvent).detail);
    });
    // Start a delete against the (currently idle) core, then start a fresh
    // upload that bumps the generation while the delete is stalled.
    const del = core.deleteObject("stale.bin");
    await core.requestUpload("upload.bin", 10);
    // Let the stalled delete reject. It belongs to the prior generation, so
    // it must NOT touch `_error` or emit `s3-uploader:error`.
    releaseDelete();
    await expect(del).rejects.toThrow("delete boom");

    expect(core.error).toBeNull();
    expect(errorEvents).toEqual([]);
  });

  it("deleteObject clears state for the matching key", async () => {
    await core.requestUpload("k", 5);
    await core.complete("k", "e");
    expect(core.url).not.toBe("");
    await core.deleteObject("k");
    expect(provider.deleteCalls).toHaveLength(1);
    expect(core.url).toBe("");
    expect(core.etag).toBe("");
    expect(core.completed).toBe(false);
  });

  it("deleteObject surfaces provider errors", async () => {
    provider.deleteError = new Error("nope");
    await expect(core.deleteObject("k")).rejects.toThrow("nope");
    expect(core.error).toEqual({ name: "Error", message: "nope" });
    expect(core.loading).toBe(false);
  });

  it("mid-upload deleteObject(sameKey) targets the snapshot bucket/prefix, not mutated inputs", async () => {
    // Regression guard: `deleteObject(activeKey)` must route through the
    // upload's snapshotted options. If it reads `this.bucket`/`this.prefix`
    // at call time, a consumer that mutated those inputs between
    // `requestUpload` and the same-key `deleteObject` ends up with a
    // warning that says "same key" but a DELETE that silently targets a
    // completely different bucket/prefix. All sibling ops (complete,
    // completeMultipart, abort, abortMultipart, signMultipartPart) already
    // use the snapshot; this pins deleteObject to the same invariant.
    core.bucket = "bucket-A";
    core.prefix = "a/";
    await core.requestUpload("asset.bin", 100);
    // Mutate inputs after the upload started. A buggy same-key delete would
    // otherwise hit bucket-B/b/.
    core.bucket = "bucket-B";
    core.prefix = "b/";
    await core.deleteObject("asset.bin");
    expect(provider.deleteCalls).toHaveLength(1);
    expect(provider.deleteCalls[0].opts).toEqual(expect.objectContaining({
      bucket: "bucket-A", prefix: "a/",
    }));
  });

  it("mid-multipart deleteObject(sameKey) targets the multipart snapshot bucket/prefix", async () => {
    // Symmetric to the single-PUT case: the multipart snapshot is the
    // source of truth for where the bytes are landing, and the warning
    // promise of "same key" is only meaningful if the DELETE actually
    // targets the same object the upload is writing to.
    core.bucket = "bucket-A";
    core.prefix = "a/";
    await core.requestMultipartUpload("mp-asset", 20 * 1024 * 1024);
    core.bucket = "bucket-B";
    core.prefix = "b/";
    await core.deleteObject("mp-asset");
    expect(provider.deleteCalls).toHaveLength(1);
    expect(provider.deleteCalls[0].opts).toEqual(expect.objectContaining({
      bucket: "bucket-A", prefix: "a/",
    }));
  });

  it("deleteObject on a non-active key uses current inputs (no snapshot to consult)", async () => {
    // Defensive counter-case: when the deleted key is NOT the active
    // upload's key, there is no snapshot to borrow options from and the
    // behaviour must fall back to the live inputs. This pins the
    // branching so a future refactor does not accidentally route these
    // deletes to a stale snapshot left over from a prior upload.
    core.bucket = "bucket-A";
    core.prefix = "a/";
    await core.requestUpload("active-key", 1);
    core.bucket = "bucket-B";
    core.prefix = "b/";
    await core.deleteObject("unrelated-key");
    expect(provider.deleteCalls).toHaveLength(1);
    expect(provider.deleteCalls[0].opts).toEqual(expect.objectContaining({
      bucket: "bucket-B", prefix: "b/",
    }));
  });

  it("mid-upload deleteObject(sameKey) does NOT strip size/contentType from the post-process ctx", async () => {
    // Regression guard: `deleteObject` clears `this._metadata` when the
    // key matches. Before the fix, the single-PUT `complete()` built its
    // post-process ctx by reading `this._metadata?.size` etc. directly, so
    // a caller that raced a same-key `deleteObject` against their own
    // upload saw the hook receive `size: undefined`, `contentType:
    // undefined` — a silent integrity failure for any downstream code
    // (DB inserts, virus scans) that relies on those fields. The fix
    // snapshots size/contentType on `_singleUpload` at requestUpload time
    // so the ctx is derived from the upload's actual parameters.
    await core.requestUpload("asset.bin", 4096, "application/octet-stream");
    // Racy same-key delete (e.g. a UI button handler, a dedup pass, or a
    // stale cleanup task). Metadata is cleared by side-effect of this call.
    await core.deleteObject("asset.bin");
    expect(core.metadata).toBeNull(); // demonstrates the cleared side-channel
    const received: any[] = [];
    core.registerPostProcess(ctx => { received.push({ ...ctx }); });
    await core.complete("asset.bin", "etag-xyz");
    expect(received).toHaveLength(1);
    expect(received[0].size).toBe(4096);
    expect(received[0].contentType).toBe("application/octet-stream");
    expect(received[0].etag).toBe("etag-xyz");
    expect(received[0].key).toBe("asset.bin");
  });

  it("requestUpload validates size", async () => {
    await expect(core.requestUpload("k", -1)).rejects.toThrow(/size/);
  });

  it("passes prefix and contentType through to provider", async () => {
    core.prefix = "user/123";
    core.contentType = "image/png";
    await core.requestUpload("avatar.png", 10);
    const opts = provider.uploadCalls[0].opts;
    expect(opts.prefix).toBe("user/123");
    expect(opts.contentType).toBe("image/png");
  });

  describe("single-PUT option snapshot", () => {
    // Mirror of the multipart "option snapshot semantics" suite — covers the
    // single-PUT path. complete() must use the bucket/prefix that were active
    // at requestUpload time, not the current input values.
    it("complete uses snapshot bucket for the post-process hook ctx", async () => {
      core.bucket = "bucket-A";
      core.prefix = "a/";
      await core.requestUpload("k", 100, "text/plain");
      // Mutate inputs after requestUpload — the hook must still see bucket-A.
      core.bucket = "bucket-B";
      core.prefix = "b/";
      let seenBucket = "";
      core.registerPostProcess((ctx) => { seenBucket = ctx.bucket; });
      await core.complete("k", "etag");
      expect(seenBucket).toBe("bucket-A");
    });

    it("complete's presignDownload targets the snapshot bucket/prefix", async () => {
      core.bucket = "bucket-A";
      core.prefix = "a/";
      await core.requestUpload("k", 100);
      core.bucket = "bucket-B";
      core.prefix = "b/";
      await core.complete("k", "etag");
      expect(provider.downloadCalls).toHaveLength(1);
      expect(provider.downloadCalls[0].opts).toEqual(expect.objectContaining({
        bucket: "bucket-A", prefix: "a/",
      }));
    });

    it("a fresh requestUpload clears the prior single-upload snapshot", async () => {
      // After a successful complete the snapshot must already be cleared, so
      // a subsequent complete (without a fresh requestUpload) errors out
      // properly rather than silently consuming stale options.
      await core.requestUpload("k1", 1);
      await core.complete("k1", "e1");
      // No active upload now — the precheck should fire.
      await expect(core.complete("k1", "e2")).rejects.toThrow(/without an active upload/);
    });

    it("abort() clears the single-upload snapshot too", async () => {
      await core.requestUpload("k", 100);
      core.abort();
      // Cannot complete after abort — precheck should fail (uploading=false).
      await expect(core.complete("k", "x")).rejects.toThrow(/without an active upload/);
    });

    it("a failed presignUpload does NOT capture a snapshot", async () => {
      provider.presignError = new Error("nope");
      await expect(core.requestUpload("k", 1)).rejects.toThrow("nope");
      // _singleUpload should still be null; complete() can't be reached anyway
      // (uploading=false), but verify defensively by trying a fresh upload
      // path that succeeds — the failed presign must not have left side state.
      provider.presignError = null;
      core.bucket = "bucket-A";
      core.prefix = "a/";
      await core.requestUpload("k", 1);
      await core.complete("k", "e");
      // Download call uses the fresh-upload snapshot, not anything left over.
      expect(provider.downloadCalls.at(-1)?.opts).toEqual(expect.objectContaining({
        bucket: "bucket-A", prefix: "a/",
      }));
    });
  });

  describe("gen mismatch on complete keeps state consistent for the next upload", () => {
    // Regression guard: when a `complete()` call races a newer `requestUpload()`
    // (either because a slow hook overshot, or a concurrent consumer reset
    // the element), the stale finalizer returns "" but must NOT flip the
    // element's `completed` flag. Leaving `completed=true` from the stale
    // run would lie to any binding subscribed to `s3-uploader:completed-changed`
    // about the newer upload's state, and a subsequent `complete()` on the
    // new upload would have nothing obvious to "change" (its own
    // `_setCompleted(true)` is a no-op when the flag is already true).
    it("stale complete() leaves completed=false so the next upload can transition it cleanly", async () => {
      await core.requestUpload("stale", 10);
      // Bump the generation out from under the in-flight complete() — simulates
      // a newer `requestUpload` landing while our hook awaits. `abort()` is
      // the minimal way to increment `_generation` without starting a new run.
      const slowHook = vi.fn(async () => { core.abort(); });
      const dispose = core.registerPostProcess(slowHook);
      const staleUrl = await core.complete("stale", "etag-stale");
      expect(staleUrl).toBe("");
      // Critically: the stale finalizer must NOT have set completed=true.
      // The abort() inside the hook sets uploading/loading back to false and
      // we expect completed to remain false — so the next upload starts from
      // a clean slate.
      expect(core.completed).toBe(false);

      // Dispose of the generation-bumping hook so the fresh upload's
      // complete() is not also hijacked by it.
      dispose();

      // Now start a fresh upload and complete it. `completed` must transition
      // false → true, and fire the change event.
      const events: boolean[] = [];
      core.addEventListener("s3-uploader:completed-changed", (e) => {
        events.push((e as CustomEvent).detail);
      });
      await core.requestUpload("fresh", 10);
      const freshUrl = await core.complete("fresh", "etag-fresh");
      expect(freshUrl).not.toBe("");
      expect(core.completed).toBe(true);
      // At minimum we must have seen false→true once. (requestUpload itself
      // sets completed=false if it was previously true, so the sequence can
      // include both flips depending on how the previous state settled.)
      expect(events).toContain(true);
    });
  });

  describe("error serialisation", () => {
    // `error` is wire-visible twice: RemoteShellProxy forwards the
    // `s3-uploader:error` detail as the `update` and reads `core.error` for
    // `sync`. @wc-bindable/remote ≥ 0.10 drops any value that is not a strict
    // JsonValue — an Error instance is rejected by prototype whatever its
    // `toJSON` says, and so is an `undefined`-valued key. These tests
    // validate with the same `isJsonValue` predicate the transport uses,
    // not with `JSON.stringify` (which would accept both and prove nothing
    // about the wire). The end-to-end delivery is pinned in
    // s3ShellRemoteFailure.test.ts / s3RemoteJsonGate.test.ts.
    it("publishes a thrown Error as a plain JsonValue { name, message } (no stack)", async () => {
      const err = new Error("payload-check");
      provider.presignError = err;
      const details: unknown[] = [];
      core.addEventListener("s3-uploader:error", (e) => details.push((e as CustomEvent).detail));
      await expect(core.requestUpload("k", 1)).rejects.toBe(err);

      expect(core.error).toEqual({ name: "Error", message: "payload-check" });
      expect(isJsonValue(core.error)).toBe(true);
      // `stack` is not published to the (untrusted) browser — see
      // `toSerializedError`.
      expect(core.error).not.toHaveProperty("stack");
      expect(details).toEqual([{ name: "Error", message: "payload-check" }]);
      expect(isJsonValue(details[0])).toBe(true);
      // The original instance is still reachable in-process, through the
      // public (undeclared) `originalError`.
      expect(core.originalError).toBe(err);
    });

    it("the getter returns a copy, so a caller cannot mutate the published slot", async () => {
      provider.presignError = new Error("orig");
      await expect(core.requestUpload("k", 1)).rejects.toThrow("orig");
      const first = core.error as { message: string };
      first.message = "tampered";
      expect(core.error).toEqual({ name: "Error", message: "orig" });
    });

    it("rethrows a plain-object rejection as an Error that keeps name / message", async () => {
      // Some providers (AWS SDK variants, cross-realm throws, pre-serialised
      // errors) reject with plain objects. @wc-bindable/remote 0.10 would
      // canonicalise a raw non-Error throw to `NonErrorThrow` /
      // "[object Object]", so the Core rethrows a real Error built from the
      // normalised shape instead (`toError`).
      const plain = { name: "AccessDenied", message: "denied", stack: "at X" };
      provider.presignError = plain;
      const rejection = await core.requestUpload("k", 1).then(
        () => { throw new Error("expected a rejection"); },
        (e: unknown) => e,
      );
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).name).toBe("AccessDenied");
      expect((rejection as Error).message).toBe("denied");
      expect(core.error).toEqual({ name: "AccessDenied", message: "denied" });
      expect(isJsonValue(core.error)).toBe(true);
      // For a non-Error rejection, `originalError` is the Error the Core
      // rethrew in its place.
      expect(core.originalError).toBe(rejection);
    });

    it("rethrows a bare-string rejection as an Error with message === the string", async () => {
      provider.presignError = "boom";
      const rejection = await core.requestUpload("k", 1).then(
        () => { throw new Error("expected a rejection"); },
        (e: unknown) => e,
      );
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toBe("boom");
      expect(core.error).toEqual({ name: "Error", message: "boom" });
    });

    it("a nullish rejection still publishes an error instead of silently clearing it", async () => {
      provider.presignUpload = async () => { throw undefined; };
      await expect(core.requestUpload("k", 1)).rejects.toThrow("undefined");
      expect(core.error).toEqual({ name: "Error", message: "undefined" });
      expect(core.loading).toBe(false);
    });

    it("a plain-object rejection without `stack` gets no `stack: undefined` key anywhere", async () => {
      // The old normaliser produced `{ name, message, stack: undefined }`,
      // which is not a JsonValue — the dispatch was dropped on the wire.
      provider.presignError = { message: "no stack here" };
      const details: unknown[] = [];
      core.addEventListener("s3-uploader:error", (e) => details.push((e as CustomEvent).detail));
      await expect(core.requestUpload("k", 1)).rejects.toThrow("no stack here");
      expect(isJsonValue(details[0])).toBe(true);
      expect(isJsonValue(core.error)).toBe(true);
    });

    it("signMultipartPart / abortMultipart rethrow non-Error rejections as Errors too", async () => {
      await core.requestMultipartUpload("mp", 20 * 1024 * 1024);
      provider.presignPartError = { name: "SlowDown", message: "throttled" } as unknown as Error;
      await expect(core.signMultipartPart("mp", "upload-1", 2)).rejects.toMatchObject({
        name: "SlowDown", message: "throttled",
      });
      await expect(core.signMultipartPart("mp", "upload-1", 2)).rejects.toBeInstanceOf(Error);
      provider.abortMultipart = async () => { throw "abort refused"; };
      await expect(core.abortMultipart("mp", "upload-1")).rejects.toThrow("abort refused");
    });

    it("warning events keep an Error instance that JSON-stringifies to { name, message, stack? }", async () => {
      await core.requestUpload("k", 1);
      const warnings: Array<{ error: unknown }> = [];
      core.addEventListener("s3-uploader:postprocess-warning", (e) => {
        warnings.push((e as CustomEvent).detail);
      });
      const hookErr = new Error("audit down");
      core.registerPostProcess(() => { throw hookErr; }, { fatal: false });
      await core.complete("k", "et");
      expect(warnings[0].error).toBe(hookErr);
      expect(JSON.parse(JSON.stringify(warnings[0].error))).toMatchObject({
        name: "Error", message: "audit down",
      });
    });

    it("a frozen error on a warning channel falls back to a plain clone", async () => {
      await core.requestUpload("k", 1);
      const warnings: Array<{ error: unknown }> = [];
      core.addEventListener("s3-uploader:postprocess-warning", (e) => {
        warnings.push((e as CustomEvent).detail);
      });
      const frozen = Object.freeze(new Error("frozen"));
      core.registerPostProcess(() => { throw frozen; }, { fatal: false });
      await core.complete("k", "et");
      expect(warnings[0].error).not.toBe(frozen);
      expect(warnings[0].error).toMatchObject({ name: "Error", message: "frozen" });
    });
  });

  describe("originalError — the exception behind `error`, for server-side code", () => {
    // `error` is the plain `{ name, message }` the browser receives. Server
    // code that logs / monitors failures needs the exception itself, and in
    // a remote setup it never sees the command's rejection (RemoteShellProxy
    // catches it and answers the client), so the Core exposes it.
    function awsLikeError(): Error & { cause: unknown; $metadata: { httpStatusCode: number; requestId: string } } {
      const cause = new Error("socket hang up");
      return Object.assign(new Error("Access Denied"), {
        name: "AccessDenied",
        cause,
        $metadata: { httpStatusCode: 403, requestId: "REQ-1" },
      });
    }

    it("is the provider's own instance: name, message, stack, cause and extra fields intact", async () => {
      const err = awsLikeError();
      provider.presignError = err;
      await expect(core.requestUpload("k", 1)).rejects.toBe(err);

      const original = core.originalError as typeof err;
      expect(original).toBe(err);
      expect(original.name).toBe("AccessDenied");
      expect(original.message).toBe("Access Denied");
      expect(typeof original.stack).toBe("string");
      expect(original.stack).toBe(err.stack);
      expect(original.cause).toBe(err.cause);
      expect(original.$metadata).toEqual({ httpStatusCode: 403, requestId: "REQ-1" });
      // …while the published value stays the plain projection.
      expect(core.error).toEqual({ name: "AccessDenied", message: "Access Denied" });
    });

    it("is readable from the Core's own s3-uploader:error listener, and clears with `error`", async () => {
      const err = awsLikeError();
      provider.presignError = err;
      const seen: Array<{ detail: unknown; original: unknown }> = [];
      core.addEventListener("s3-uploader:error", (e) => {
        seen.push({ detail: (e as CustomEvent).detail, original: core.originalError });
      });

      await expect(core.requestUpload("k", 1)).rejects.toBe(err);
      provider.presignError = null;
      await core.requestUpload("k2", 1); // starts by clearing the slot

      expect(seen).toEqual([
        { detail: { name: "AccessDenied", message: "Access Denied" }, original: err },
        { detail: null, original: null },
      ]);
      expect(core.error).toBeNull();
      expect(core.originalError).toBeNull();
    });

    it("is the fatal registerPostProcess hook's own Error", async () => {
      const hookErr = Object.assign(new Error("virus found"), { cause: { engine: "clamav" } });
      core.registerPostProcess(() => { throw hookErr; });
      await core.requestUpload("k", 1);
      await expect(core.complete("k", "et")).rejects.toBe(hookErr);
      expect(core.originalError).toBe(hookErr);
      expect(core.error).toEqual({ name: "Error", message: "virus found" });
    });

    it("is not a declared wcBindable property, so RemoteShellProxy never reads or forwards it", () => {
      const declared = [
        ...S3Core.wcBindable.properties.map(p => p.name),
        ...(S3Core.wcBindable.inputs ?? []).map(i => i.name),
        ...(S3Core.wcBindable.commands ?? []).map(c => c.name),
      ];
      expect(declared).not.toContain("originalError");
      expect(core.originalError).toBeNull();
    });
  });

  describe("wire-safe property and return values (@wc-bindable/remote >= 0.10)", () => {
    it("metadata omits contentType instead of carrying undefined", async () => {
      // No contentType argument and no contentType input: the default for an
      // <s3-uploader> without a `content-type` attribute uploading a File
      // whose `type` is "". `{ contentType: undefined }` is not a JsonValue,
      // so the whole metadata update used to be dropped on the wire.
      const details: unknown[] = [];
      core.addEventListener("s3-uploader:metadata-changed", (e) => details.push((e as CustomEvent).detail));
      await core.requestUpload("k", 12);
      expect(core.metadata).toEqual({ size: 12 });
      expect(core.metadata).not.toHaveProperty("contentType");
      expect(isJsonValue(core.metadata)).toBe(true);
      expect(details).toEqual([{ size: 12 }]);
    });

    it("metadata omits size when requestUpload is called without one", async () => {
      await core.requestUpload("k", undefined, "text/plain");
      expect(core.metadata).toEqual({ contentType: "text/plain" });
      expect(isJsonValue(core.metadata)).toBe(true);
    });

    it("multipart metadata omits contentType instead of carrying undefined", async () => {
      await core.requestMultipartUpload("mp", 20 * 1024 * 1024);
      expect(core.metadata).toEqual({ size: 20 * 1024 * 1024 });
      expect(isJsonValue(core.metadata)).toBe(true);
    });

    it("drops undefined members from a custom provider's presign results", async () => {
      // A wrapper provider that leaves optional members unset. 0.7's
      // JSON.stringify dropped these keys; 0.10 rejects the whole return
      // value (`WC_BINDABLE_INVALID_RETURN_VALUE`) unless the Core does.
      provider.presignUpload = async (key: string) => ({
        url: `https://example.com/upload/${key}`,
        method: "PUT" as const,
        headers: undefined,
        expiresAt: Date.now() + 60_000,
      });
      const presigned = await core.requestUpload("k", 1);
      expect(presigned).not.toHaveProperty("headers");
      expect(isJsonValue(presigned)).toBe(true);

      provider.presignDownload = async (key: string) => ({
        url: `https://example.com/download/${key}`,
        method: "GET" as const,
        expiresAt: undefined as unknown as number,
      });
      const download = await core.requestDownload("k");
      expect(download).toEqual({ url: "https://example.com/download/k", method: "GET" });
      expect(isJsonValue(download)).toBe(true);
    });

    it("drops a missing part expiresAt and undefined header values from multipart results", async () => {
      provider.presignPart = async (_key: string, _uploadId: string, partNumber: number) => ({
        url: `https://example.com/part/${partNumber}`,
        method: "PUT" as const,
        headers: { "x-amz-meta-a": "1", "x-amz-meta-b": undefined as unknown as string },
        expiresAt: undefined as unknown as number,
      });
      const init = await core.requestMultipartUpload("mp", 20 * 1024 * 1024);
      expect(isJsonValue(init)).toBe(true);
      for (const part of init.parts) {
        expect(part).not.toHaveProperty("expiresAt");
        expect(part.headers).toEqual({ "x-amz-meta-a": "1" });
      }
      const refreshed = await core.signMultipartPart("mp", "upload-1", 1);
      expect(isJsonValue(refreshed)).toBe(true);
      expect(refreshed.headers).toEqual({ "x-amz-meta-a": "1" });
    });
  });

  describe("generation race protection", () => {
    it("requestUpload does not publish uploading=true on a superseded generation", async () => {
      // Stall presignUpload so the first requestUpload is still awaiting when
      // the second one fires; the second one bumps _generation, so the first
      // must detect the bump post-await and bail without setting
      // uploading=true or capturing a _singleUpload snapshot that would then
      // be consumed by a complete() for the newer session.
      let releaseFirst: () => void = () => {};
      const firstGate = new Promise<void>(r => { releaseFirst = r; });
      const orig = provider.presignUpload.bind(provider);
      let call = 0;
      provider.presignUpload = async (key: string, opts: S3RequestOptions) => {
        call++;
        if (call === 1) await firstGate;
        return orig(key, opts);
      };

      core.bucket = "b";
      const first = core.requestUpload("key-a", 10);
      // Give the first a microtask so it actually enters the await.
      await new Promise(r => setTimeout(r, 0));
      const second = await core.requestUpload("key-b", 20);
      expect(second.url).toContain("key-b");
      // Now release the stalled first call. It should resolve but not touch
      // uploading/singleUpload state — the second upload owns the slot.
      releaseFirst();
      await first;
      // Core is tracking the SECOND upload, not the first.
      expect(core.uploading).toBe(true);
      expect(core.key).toBe("key-b");
      // complete() must succeed on the second key.
      await core.complete("key-b", "etag-2");
      expect(core.completed).toBe(true);
    });

    it("deleteObject on an active upload key dispatches s3-uploader:delete-during-upload-warning", async () => {
      core.bucket = "b";
      await core.requestUpload("live-key", 5);
      expect(core.uploading).toBe(true);

      const warnings: CustomEvent[] = [];
      core.addEventListener("s3-uploader:delete-during-upload-warning", (e) => {
        warnings.push(e as CustomEvent);
      });

      await core.deleteObject("live-key");
      expect(warnings).toHaveLength(1);
      expect(warnings[0].detail).toMatchObject({
        key: "live-key",
        mode: "single",
      });
    });

    it("deleteObject on a different key does NOT dispatch the warning", async () => {
      core.bucket = "b";
      await core.requestUpload("live-key", 5);

      const warnings: CustomEvent[] = [];
      core.addEventListener("s3-uploader:delete-during-upload-warning", (e) => {
        warnings.push(e as CustomEvent);
      });

      await core.deleteObject("other-key");
      expect(warnings).toHaveLength(0);
    });

    it("abort() surfaces abortMultipart failures via s3-uploader:abort-cleanup-warning", async () => {
      // Start a multipart so abort() has cleanup to do. Then pin an error on
      // the provider's abortMultipart so abort() triggers the warning path.
      core.bucket = "b";
      await core.requestMultipartUpload("mp-key", 20 * 1024 * 1024);
      expect(core.uploading).toBe(true);

      const warnings: CustomEvent[] = [];
      core.addEventListener("s3-uploader:abort-cleanup-warning", (e) => {
        warnings.push(e as CustomEvent);
      });

      provider.abortMultipart = async () => {
        throw new Error("network down");
      };
      core.abort();
      // The warning is dispatched from the rejected promise's catch handler,
      // so wait a microtask for it to fire.
      await new Promise(r => setTimeout(r, 0));
      expect(warnings).toHaveLength(1);
      const detail = warnings[0].detail as { error: Error; ctx: { key: string; reason: string } };
      expect(detail.error.message).toBe("network down");
      expect(detail.ctx.key).toBe("mp-key");
      expect(detail.ctx.reason).toBe("abort");
    });
  });
});
