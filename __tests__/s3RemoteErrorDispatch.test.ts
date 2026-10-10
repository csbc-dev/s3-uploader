import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { S3 } from "../src/components/S3";
import { S3Core } from "../src/core/S3Core";
import { setConfig } from "../src/config";
import {
  RemoteShellProxy,
  isJsonValue,
  type ClientMessage,
  type ClientTransport,
  type ServerMessage,
  type ServerTransport,
} from "@wc-bindable/remote";
import type {
  IS3Provider,
  MultipartPart,
  PresignedDownload,
  PresignedUpload,
  S3RequestOptions,
} from "../src/types";

/**
 * One failure, one `s3-uploader:error` — for the failures a remote Shell used
 * to report zero or two times. Driven through the REAL `RemoteCoreProxy`
 * (inside the Shell) and `RemoteShellProxy` (wrapping a real `S3Core`), every
 * frame JSON-stringified like a WebSocket text frame (harness taken from
 * s3RemoteJsonGate.test.ts).
 *
 *   - A Core command that rejects WITHOUT publishing its `error` property —
 *     argument / state validation (`raiseError`: no bucket, key mismatch, no
 *     active upload) — used to be left to the `bind()` mirror, which never
 *     delivered anything: no event, `el.error` null, and with `trigger = true`
 *     (which swallows the rejection) no trace at all.
 *   - A WebSocket that drops while an RPC / PUT / `setWithAck` is in flight
 *     used to report the drop (`onFail`) AND the in-flight operation's
 *     consequential `WC_BINDABLE_DISPOSED` / "upload aborted." rejection.
 */

function pairedTransports(): { client: ClientTransport; server: ServerTransport } {
  let clientHandler: ((m: ServerMessage) => void) | null = null;
  let serverHandler: ((m: ClientMessage) => void) | null = null;
  const client: ClientTransport = {
    send: (m) => {
      const frame = JSON.stringify(m);
      queueMicrotask(() => serverHandler?.(JSON.parse(frame) as ClientMessage));
    },
    onMessage: (h) => { clientHandler = h; },
  };
  const server: ServerTransport = {
    send: (m) => {
      const frame = JSON.stringify(m);
      queueMicrotask(() => clientHandler?.(JSON.parse(frame) as ServerMessage));
    },
    onMessage: (h) => { serverHandler = h; },
  };
  return { client, server };
}

/** Provider whose every method can be overridden per test. */
class TestProvider implements IS3Provider {
  async presignUpload(key: string, _o: S3RequestOptions): Promise<PresignedUpload> {
    return { url: `https://example/upload/${key}`, method: "PUT", expiresAt: Date.now() + 60_000 };
  }
  async presignDownload(key: string, _o: S3RequestOptions): Promise<PresignedDownload> {
    return { url: `https://example/download/${key}`, method: "GET", expiresAt: Date.now() + 60_000 };
  }
  async deleteObject(_k: string, _o: S3RequestOptions): Promise<void> {}
  async initiateMultipart(_k: string, _o: S3RequestOptions): Promise<{ uploadId: string }> {
    return { uploadId: "mp-1" };
  }
  async presignPart(_k: string, _u: string, partNumber: number, _o: S3RequestOptions): Promise<PresignedUpload> {
    return { url: `https://example/part/${partNumber}`, method: "PUT", expiresAt: Date.now() + 60_000 };
  }
  async completeMultipart(_k: string, _u: string, _p: MultipartPart[], _o: S3RequestOptions): Promise<{ etag: string }> {
    return { etag: "merged" };
  }
  async abortMultipart(_k: string, _u: string, _o: S3RequestOptions): Promise<void> {}
}

/**
 * How the fake S3 answers a PUT. `null` leaves the request pending until it
 * is aborted (the Shell's `_cancelXhrs`), like a real XHR on a slow link.
 */
type PutOutcome = { status: number; etag?: string };
let putPlan: (url: string) => PutOutcome | Promise<PutOutcome> | null;
const defaultPutPlan = (): PutOutcome => ({ status: 200, etag: '"deadbeef"' });

class FakeXHR {
  upload = { addEventListener: (_n: string, _fn: (e: ProgressEvent) => void) => {} };
  status = 0;
  private _listeners: Record<string, Array<(e: Event) => void>> = {};
  private _url = "";
  private _etag: string | null = null;
  private _settled = false;
  open(_method: string, url: string): void { this._url = url; }
  setRequestHeader(_name: string, _value: string): void {}
  addEventListener(name: string, fn: (e: Event) => void): void {
    (this._listeners[name] ??= []).push(fn);
  }
  send(_body: unknown): void {
    const outcome = putPlan(this._url);
    if (outcome === null) return;
    void Promise.resolve(outcome).then((o) => {
      if (this._settled) return;
      this._settled = true;
      this.status = o.status;
      this._etag = o.etag ?? null;
      this._fire("load");
    });
  }
  abort(): void {
    if (this._settled) return;
    this._settled = true;
    this._fire("abort");
  }
  getResponseHeader(name: string): string | null {
    return name.toLowerCase() === "etag" ? this._etag : null;
  }
  get responseText(): string { return ""; }
  get statusText(): string { return ""; }
  private _fire(name: string): void {
    for (const fn of this._listeners[name] ?? []) fn(new Event(name));
  }
}

const flushMany = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
};

/** A promise the test settles by hand — used to hold a server call open. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

/** What `upload()` rejected with (fails the test if it resolved). */
async function rejectionOf(p: Promise<unknown>): Promise<Error & { code?: string }> {
  return p.then(
    () => { throw new Error("expected upload() to reject"); },
    (e: unknown) => e as Error & { code?: string },
  );
}

beforeAll(() => {
  if (!customElements.get("s3-uploader")) customElements.define("s3-uploader", S3);
});

const RealXHR = globalThis.XMLHttpRequest;
const mounted: S3[] = [];

beforeEach(() => {
  putPlan = defaultPutPlan;
  (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXHR;
});

afterEach(() => {
  (globalThis as unknown as { XMLHttpRequest: typeof XMLHttpRequest }).XMLHttpRequest = RealXHR;
  for (const el of mounted.splice(0)) el.remove();
});

/** Non-null `s3-uploader:error` details, in dispatch order. */
function recordErrors(el: S3): unknown[] {
  const errors: unknown[] = [];
  el.addEventListener("s3-uploader:error", (ev: Event) => {
    const detail = (ev as CustomEvent).detail;
    if (detail != null) errors.push(detail);
  });
  return errors;
}

describe("remote Shell — Core rejections that publish no `error` are dispatched once", () => {
  async function connect(
    provider: IS3Provider,
    setup?: (core: S3Core) => void | Promise<void>,
  ): Promise<{ el: S3; core: S3Core; errors: unknown[] }> {
    const { client, server } = pairedTransports();
    const core = new S3Core(provider);
    core.bucket = "b";
    await setup?.(core);
    new RemoteShellProxy(core, server);
    const el = document.createElement("s3-uploader") as S3;
    const errors = recordErrors(el);
    document.body.appendChild(el);
    mounted.push(el);
    (el as any)._connectRemote(client);
    await flushMany();
    return { el, core, errors };
  }

  it("requestUpload with no bucket configured", async () => {
    const { el, core, errors } = await connect(new TestProvider(), (c) => { c.bucket = ""; });
    el.file = new Blob(["x"]);

    const rejection = await rejectionOf(el.upload());
    await flushMany();

    expect(rejection.message).toMatch(/bucket is required/);
    expect(errors).toHaveLength(1);
    // Dispatched by the Shell (the Core published nothing): the detail is the
    // very rejection `upload()` returned, like a remote-layer failure.
    expect(errors[0]).toBe(rejection);
    expect(el.error).toBe(rejection);
    expect(core.error).toBeNull();
  });

  it("requestMultipartUpload with no bucket configured", async () => {
    const { el, errors } = await connect(new TestProvider(), (c) => { c.bucket = ""; });
    el.setAttribute("multipart-threshold", "4");
    el.file = new Blob(["0123456789"]);

    const rejection = await rejectionOf(el.upload());
    await flushMany();

    expect(rejection.message).toMatch(/bucket is required/);
    expect(errors).toEqual([rejection]);
    expect(el.error).toBe(rejection);
  });

  it("trigger = true (which swallows the rejection) still surfaces the validation failure", async () => {
    const { el, errors } = await connect(new TestProvider(), (c) => { c.bucket = ""; });
    el.file = new Blob(["x"]);

    el.trigger = true;
    await flushMany();

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toMatch(/bucket is required/);
    expect(el.error).toBe(errors[0]);
    expect(el.trigger).toBe(false);
  });

  it("complete() key mismatch after the server-side Core was re-targeted mid-PUT", async () => {
    const { el, core, errors } = await connect(new TestProvider());
    const put = deferred<PutOutcome>();
    putPlan = () => put.promise;
    el.key = "k";
    el.file = new Blob(["x"]);

    const pending = el.upload();
    await flushMany();
    // Server-side code starts a different upload on the same Core while the
    // browser is still PUTting: the Shell's `complete("k")` no longer matches.
    await core.requestUpload("other", 1);
    put.resolve({ status: 200, etag: '"e"' });

    const rejection = await rejectionOf(pending);
    await flushMany();

    expect(rejection.message).toMatch(/complete\(\) key mismatch: expected other, got k/);
    expect(errors).toEqual([rejection]);
    expect(el.error).toBe(rejection);
    expect(core.error).toBeNull();
  });

  it("completeMultipart() after the server-side Core aborted the multipart mid-parts", async () => {
    const { el, core, errors } = await connect(new TestProvider());
    const part = deferred<PutOutcome>();
    putPlan = (url) => (url.startsWith("https://example/part/") ? part.promise : defaultPutPlan());
    el.setAttribute("multipart-threshold", "4");
    el.file = new Blob(["0123456789"]);

    const pending = el.upload();
    await flushMany();
    core.abort();
    part.resolve({ status: 200, etag: '"p1"' });

    const rejection = await rejectionOf(pending);
    await flushMany();

    expect(rejection.message).toMatch(/completeMultipart\(\) called without an active multipart upload/);
    expect(errors).toEqual([rejection]);
  });

  it("a stale Core error from an earlier run does not hide a later validation failure", async () => {
    let failPresign = true;
    const provider = new TestProvider();
    const realPresign = provider.presignUpload.bind(provider);
    provider.presignUpload = async (key, o) => {
      if (failPresign) throw new Error("denied by policy");
      return realPresign(key, o);
    };
    const { el, core, errors } = await connect(provider);
    el.file = new Blob(["x"]);

    // Run 1: a Core-published failure, delivered by the mirror.
    await expect(el.upload()).rejects.toThrow("denied by policy");
    await flushMany();
    expect(errors).toEqual([{ name: "Error", message: "denied by policy" }]);

    // Run 2: the Core still holds run 1's error, but this run fails in
    // validation and publishes nothing — it must still be reported.
    failPresign = false;
    core.bucket = "";
    const rejection = await rejectionOf(el.upload());
    await flushMany();

    expect(errors).toHaveLength(2);
    expect(errors[1]).toBe(rejection);
    expect(el.error).toBe(rejection);
  });
});

describe("remote Shell — Core-published failures are still the mirror's single event", () => {
  async function connect(provider: IS3Provider): Promise<{ el: S3; core: S3Core; errors: unknown[] }> {
    const { client, server } = pairedTransports();
    const core = new S3Core(provider);
    core.bucket = "b";
    new RemoteShellProxy(core, server);
    const el = document.createElement("s3-uploader") as S3;
    const errors = recordErrors(el);
    document.body.appendChild(el);
    mounted.push(el);
    (el as any)._connectRemote(client);
    await flushMany();
    return { el, core, errors };
  }

  it.each([
    ["presignUpload", false],
    ["initiateMultipart", true],
  ] as const)("a %s rejection: one plain { name, message } event from the mirror", async (method, multipart) => {
    const provider = new TestProvider();
    (provider as any)[method] = async () => { throw new Error(`${method} denied`); };
    const { el, errors } = await connect(provider);
    if (multipart) el.setAttribute("multipart-threshold", "4");
    el.file = new Blob(["0123456789"]);

    await expect(el.upload()).rejects.toThrow(`${method} denied`);
    await flushMany();

    // A plain object, not the rebuilt `Error` the RPC rejected with: it came
    // through `bind()`, and the Shell added nothing on top.
    expect(errors).toEqual([{ name: "Error", message: `${method} denied` }]);
    expect(errors[0]).not.toBeInstanceOf(Error);
    expect(isJsonValue(errors[0])).toBe(true);
  });

  it("with trigger = true", async () => {
    const provider = new TestProvider();
    provider.presignUpload = async () => { throw new Error("denied"); };
    const { el, errors } = await connect(provider);
    el.file = new Blob(["x"]);

    el.trigger = true;
    await flushMany();

    expect(errors).toEqual([{ name: "Error", message: "denied" }]);
  });

  it("a Core-published failure after a local one becomes el.error (the latest failure wins)", async () => {
    const provider = new TestProvider();
    provider.presignUpload = async () => { throw new Error("denied"); };
    const { el, core, errors } = await connect(provider);
    core.bucket = "";
    el.file = new Blob(["x"]);

    // Run 1: validation failure, dispatched by the Shell.
    await expect(el.upload()).rejects.toThrow(/bucket is required/);
    core.bucket = "b";

    // Run 2: the Core publishes.
    await expect(el.upload()).rejects.toThrow("denied");
    await flushMany();

    expect(errors).toHaveLength(2);
    expect(errors[1]).toEqual({ name: "Error", message: "denied" });
    expect(el.error).toEqual({ name: "Error", message: "denied" });
  });
});

describe("remote Shell — only an `error` update applied after the connection's initial sync is a Core publish", () => {
  // `_remoteErrorSeq` decides step 3 of `_setRpcErrorState` ("the Core
  // already published this failure"). The `sync` snapshot — and any
  // `update` that reaches the client before it — is Core state from before
  // the producer processed anything this connection sent: the producer
  // answers `sync` first, in order. An RPC the Shell sends before the
  // snapshot arrives (the input `setWithAck`s of `_connectRemote`, an
  // `upload()` started right after connecting — the proxy's default
  // `preSyncBehavior: "eager"`) used to see a stale error in the snapshot as
  // "the Core published", and a rejection the Core never published went
  // unreported. Same rule as the Stripe Shell (`_observeSyncFrames`).

  const STALE = { name: "Error", message: "earlier failure" };

  /** A provider whose presign can be switched to fail. */
  class SwitchableProvider extends TestProvider {
    presignFailure: Error | null = null;
    override async presignUpload(key: string, o: S3RequestOptions): Promise<PresignedUpload> {
      if (this.presignFailure) throw this.presignFailure;
      return super.presignUpload(key, o);
    }
  }

  /**
   * A Core that refuses some `bucket` values — the kind of input validation
   * an app adds by subclassing. The setter throws before any state change,
   * so the Core publishes nothing for it.
   */
  class BucketAllowlistCore extends S3Core {
    override get bucket(): string { return super.bucket; }
    override set bucket(value: string) {
      if (value !== "b") throw new Error(`bucket "${value}" is not allowed`);
      super.bucket = value;
    }
  }

  /** Leave `core.error` set, as an earlier failed upload on the server would. */
  async function primeStaleCoreError(core: S3Core, provider: SwitchableProvider): Promise<void> {
    provider.presignFailure = new Error(STALE.message);
    await core.requestUpload("stale", 1).catch(() => {});
    provider.presignFailure = null;
    expect(core.error).toEqual(STALE);
  }

  /**
   * `pairedTransports` plus a log of the client's sends and receipts, so a
   * test can show its RPC really went out before the `sync` response came
   * back. `beforeSync` is pushed by the producer ahead of its `sync` answer.
   */
  function trackedTransports(beforeSync?: ServerMessage): {
    client: ClientTransport; server: ServerTransport; order: string[];
  } {
    const pair = pairedTransports();
    const order: string[] = [];
    const client: ClientTransport = {
      send: (m) => {
        if (m.type !== "sync") order.push(`send:${m.type}:${(m as { name?: string }).name}`);
        pair.client.send(m);
      },
      onMessage: (h) => pair.client.onMessage((m) => {
        order.push(m.type === "update" ? `recv:update:${m.name}` : `recv:${m.type}`);
        h(m);
      }),
    };
    let injected = false;
    const server: ServerTransport = {
      send: (m) => {
        if (beforeSync && m.type === "sync" && !injected) {
          injected = true;
          pair.server.send(beforeSync);
        }
        pair.server.send(m);
      },
      onMessage: (h) => pair.server.onMessage(h),
    };
    return { client, server, order };
  }

  function mountElement(attrs: Record<string, string> = {}): { el: S3; errors: unknown[] } {
    const el = document.createElement("s3-uploader") as S3;
    for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
    const errors = recordErrors(el);
    document.body.appendChild(el);
    mounted.push(el);
    return { el, errors };
  }

  function sentBeforeSync(order: string[], send: string): void {
    expect(order).toContain(send);
    expect(order.indexOf(send)).toBeLessThan(order.indexOf("recv:sync"));
  }

  it("a setWithAck sent before sync that the Core's input validation rejects is dispatched once", async () => {
    const provider = new SwitchableProvider();
    const core = new BucketAllowlistCore(provider);
    core.bucket = "b";
    await primeStaleCoreError(core, provider);
    const { client, server, order } = trackedTransports();
    new RemoteShellProxy(core, server);
    const { el, errors } = mountElement({ bucket: "other-tenant" });

    (el as any)._connectRemote(client);
    await flushMany();

    sentBeforeSync(order, "send:set:bucket");
    expect(order).toContain("recv:throw");
    // The snapshot's stale error is mirrored (it is the Core's state), and the
    // rejection the Core never published is reported once on top of it.
    expect(errors).toHaveLength(2);
    expect(errors[0]).toEqual(STALE);
    expect(errors[1]).toBeInstanceOf(Error);
    expect((errors[1] as Error).message).toBe('bucket "other-tenant" is not allowed');
    expect(el.error).toBe(errors[1]);
    expect(core.bucket).toBe("b");
    expect(core.error).toEqual(STALE);
  });

  it.each([
    ["before", true],
    ["after", false],
  ] as const)("an upload() sent %s the sync that fails Core validation is dispatched once", async (_when, preSync) => {
    const provider = new SwitchableProvider();
    const core = new S3Core(provider);
    core.bucket = "b";
    await primeStaleCoreError(core, provider);
    core.bucket = ""; // requestUpload now fails validation, publishing nothing
    const { client, server, order } = trackedTransports();
    new RemoteShellProxy(core, server);
    const { el, errors } = mountElement();
    el.file = new Blob(["x"]);

    (el as any)._connectRemote(client);
    if (!preSync) await flushMany();
    const rejection = await rejectionOf(el.upload());
    await flushMany();

    if (preSync) sentBeforeSync(order, "send:cmd:requestUpload");
    expect(rejection.message).toMatch(/bucket is required/);
    expect(errors).toEqual([STALE, rejection]);
    expect(errors[1]).toBe(rejection);
    expect(el.error).toBe(rejection);
    expect(core.error).toEqual(STALE);
  });

  it("an update the producer pushes before its sync answer does not count either", async () => {
    const provider = new SwitchableProvider();
    const core = new S3Core(provider);
    core.bucket = "b";
    await primeStaleCoreError(core, provider);
    core.bucket = "";
    const early = { name: "Error", message: "published before sync" };
    const { client, server, order } = trackedTransports({ type: "update", name: "error", value: early });
    new RemoteShellProxy(core, server);
    const { el, errors } = mountElement();
    el.file = new Blob(["x"]);

    (el as any)._connectRemote(client);
    const rejection = await rejectionOf(el.upload());
    await flushMany();

    sentBeforeSync(order, "send:cmd:requestUpload");
    expect(order.indexOf("recv:update:error")).toBeLessThan(order.indexOf("recv:sync"));
    expect(errors).toEqual([early, STALE, rejection]);
    expect(el.error).toBe(rejection);
  });

  it("a Core-published failure of a pre-sync upload is still the mirror's single event", async () => {
    const provider = new SwitchableProvider();
    const core = new S3Core(provider);
    core.bucket = "b";
    await primeStaleCoreError(core, provider);
    provider.presignFailure = new Error("denied now");
    const { client, server, order } = trackedTransports();
    new RemoteShellProxy(core, server);
    const { el, errors } = mountElement();
    el.file = new Blob(["x"]);

    (el as any)._connectRemote(client);
    const rejection = await rejectionOf(el.upload());
    await flushMany();

    sentBeforeSync(order, "send:cmd:requestUpload");
    expect(rejection.message).toBe("denied now");
    // The snapshot, then the Core's own publish — and nothing from the Shell.
    expect(errors).toEqual([STALE, { name: "Error", message: "denied now" }]);
    expect(errors[1]).not.toBeInstanceOf(Error);
    expect(el.error).toEqual({ name: "Error", message: "denied now" });
  });

  it("a Core-published failure of a pre-sync setWithAck is still the mirror's single event", async () => {
    // A subclass whose setter publishes before throwing (the Core's own
    // `_setError` path): the publish arrives after the snapshot, so it counts.
    class PublishingCore extends S3Core {
      override get bucket(): string { return super.bucket; }
      override set bucket(value: string) {
        if (value !== "b") {
          const err = new Error(`bucket "${value}" is not allowed`);
          (this as unknown as { _setError(e: unknown): void })._setError(err);
          throw err;
        }
        super.bucket = value;
      }
    }
    const provider = new SwitchableProvider();
    const core = new PublishingCore(provider);
    core.bucket = "b";
    await primeStaleCoreError(core, provider);
    const { client, server, order } = trackedTransports();
    new RemoteShellProxy(core, server);
    const { el, errors } = mountElement({ bucket: "other-tenant" });

    (el as any)._connectRemote(client);
    await flushMany();

    sentBeforeSync(order, "send:set:bucket");
    expect(errors).toEqual([STALE, { name: "Error", message: 'bucket "other-tenant" is not allowed' }]);
    expect(el.error).toEqual({ name: "Error", message: 'bucket "other-tenant" is not allowed' });
  });

  it("every connection starts unsynced: a reconnect's initial sync is not counted either", async () => {
    // Connection 1, fully synced, then torn down by a DOM disconnect.
    const first = pairedTransports();
    new RemoteShellProxy(new S3Core(new TestProvider()), first.server);
    const { el, errors } = mountElement();
    (el as any)._connectRemote(first.client);
    await flushMany();
    el.remove();
    document.body.appendChild(el);

    // Connection 2: a Core holding a stale error; an upload sent before its
    // sync fails validation.
    const provider = new SwitchableProvider();
    const core = new S3Core(provider);
    core.bucket = "b";
    await primeStaleCoreError(core, provider);
    core.bucket = "";
    const { client, server, order } = trackedTransports();
    new RemoteShellProxy(core, server);
    errors.length = 0;
    el.file = new Blob(["x"]);

    (el as any)._connectRemote(client);
    const rejection = await rejectionOf(el.upload());
    await flushMany();

    sentBeforeSync(order, "send:cmd:requestUpload");
    expect(errors).toEqual([STALE, rejection]);
    expect(el.error).toBe(rejection);
  });

  it("the sync-observing transport wrapper still forwards onClose and dispose", async () => {
    const pair = pairedTransports();
    let closeHandler: (() => void) | null = null;
    let disposed = 0;
    const client: ClientTransport = {
      send: (m) => pair.client.send(m),
      onMessage: (h) => pair.client.onMessage(h),
      onClose: (h) => { closeHandler = h; },
      dispose: () => { disposed++; },
    };
    new RemoteShellProxy(new S3Core(new TestProvider()), pair.server);
    const { el } = mountElement();

    (el as any)._connectRemote(client);
    await flushMany();
    expect(typeof closeHandler).toBe("function");

    el.remove(); // disconnectedCallback → _disposeRemote → proxy.dispose()
    expect(disposed).toBe(1);
  });
});

describe("Shell — one event per failed multipart run (no sticky suppression)", () => {
  it("remote: a second failed multipart run reports its own failure", async () => {
    const { client, server } = pairedTransports();
    const core = new S3Core(new TestProvider());
    core.bucket = "b";
    new RemoteShellProxy(core, server);
    const el = document.createElement("s3-uploader") as S3;
    const errors = recordErrors(el);
    document.body.appendChild(el);
    mounted.push(el);
    (el as any)._connectRemote(client);
    await flushMany();
    putPlan = () => ({ status: 400 });
    el.setAttribute("multipart-threshold", "4");
    el.file = new Blob(["0123456789"]);

    const first = await rejectionOf(el.upload());
    await flushMany();
    const second = await rejectionOf(el.upload());
    await flushMany();

    expect(errors).toEqual([first, second]);
    expect(el.error).toBe(second);
  });

  it("in-process Core: a second failed multipart run reports its own failure", async () => {
    const core = new S3Core(new TestProvider());
    core.bucket = "b";
    const el = document.createElement("s3-uploader") as S3;
    const errors = recordErrors(el);
    el.attachLocalCore(core);
    document.body.appendChild(el);
    mounted.push(el);
    putPlan = () => ({ status: 400 });
    el.setAttribute("multipart-threshold", "4");
    el.file = new Blob(["0123456789"]);

    const first = await rejectionOf(el.upload());
    const second = await rejectionOf(el.upload());

    expect(errors).toEqual([first, second]);
    expect(el.error).toBe(second);
  });
});

/**
 * WebSocket stand-in bridged to a server-side `RemoteShellProxy`, so the
 * Shell's real `_initRemote` path (its `onFail` handler +
 * `WebSocketClientTransport`) runs end to end. Listener dispatch follows the
 * DOM rule that a listener removed earlier in the same dispatch does not run.
 */
const sockets: BridgedWebSocket[] = [];

class BridgedWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = BridgedWebSocket.CONNECTING;
  private _listeners = new Map<string, Array<{ fn: (ev: unknown) => void; once: boolean }>>();
  private _serverHandler: ((m: ClientMessage) => void) | null = null;

  constructor(readonly url: string) {
    sockets.push(this);
  }

  /** The server end of this socket, for a `RemoteShellProxy`. */
  readonly server: ServerTransport = {
    send: (m) => {
      const frame = JSON.stringify(m);
      queueMicrotask(() => {
        if (this.readyState === BridgedWebSocket.OPEN) this._fire("message", { type: "message", data: frame });
      });
    },
    onMessage: (h) => { this._serverHandler = h; },
  };

  addEventListener(type: string, fn: (ev: unknown) => void, opts?: boolean | AddEventListenerOptions): void {
    const list = this._listeners.get(type) ?? [];
    if (list.some(l => l.fn === fn)) return;
    list.push({ fn, once: typeof opts === "object" && !!opts.once });
    this._listeners.set(type, list);
  }
  removeEventListener(type: string, fn: (ev: unknown) => void): void {
    const list = this._listeners.get(type);
    if (list) this._listeners.set(type, list.filter(l => l.fn !== fn));
  }
  send(data: string): void {
    if (this.readyState !== BridgedWebSocket.OPEN) throw new Error("InvalidStateError: socket is not open");
    queueMicrotask(() => this._serverHandler?.(JSON.parse(data) as ClientMessage));
  }
  close(): void { this.readyState = BridgedWebSocket.CLOSED; }

  open(): void {
    this.readyState = BridgedWebSocket.OPEN;
    this._fire("open", { type: "open" });
  }
  /** The connection drops after it was established. */
  drop(): void {
    this.readyState = BridgedWebSocket.CLOSED;
    this._fire("close", { type: "close" });
  }
  /** The connection never comes up (`error` then `close`, as browsers do). */
  fail(): void {
    this._fire("error", { type: "error" });
    this.readyState = BridgedWebSocket.CLOSED;
    this._fire("close", { type: "close" });
  }

  private _fire(type: string, ev: unknown): void {
    for (const entry of [...(this._listeners.get(type) ?? [])]) {
      if (!this._listeners.get(type)?.includes(entry)) continue;
      if (entry.once) this.removeEventListener(type, entry.fn);
      entry.fn(ev);
    }
  }
}

describe("remote Shell — a dropped WebSocket is reported once", () => {
  let origWs: typeof WebSocket;

  beforeEach(() => {
    origWs = globalThis.WebSocket;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = BridgedWebSocket;
    sockets.length = 0;
    setConfig({
      remote: { enableRemote: true, remoteSettingType: "config", remoteCoreUrl: "ws://test.invalid/s3" },
    });
  });

  afterEach(() => {
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = origWs;
    setConfig({ remote: { enableRemote: false, remoteSettingType: "config", remoteCoreUrl: "" } });
  });

  /** Mount an element in remote mode; its socket is still CONNECTING. */
  function mount(provider: IS3Provider, attrs: Record<string, string> = {}): {
    el: S3; core: S3Core; ws: BridgedWebSocket; errors: unknown[];
  } {
    const el = document.createElement("s3-uploader") as S3;
    for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
    const errors = recordErrors(el);
    document.body.appendChild(el);
    mounted.push(el);
    expect(sockets).toHaveLength(1);
    const ws = sockets[0];
    const core = new S3Core(provider);
    core.bucket = "b";
    new RemoteShellProxy(core, ws.server);
    return { el, core, ws, errors };
  }

  function expectConnectionError(errors: unknown[], el: S3, kind: "lost" | "failed"): void {
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe(`[@csbc-dev/s3-uploader] WebSocket connection ${kind}: ws://test.invalid/s3`);
    expect(el.error).toBe(errors[0]);
  }

  it("while an RPC is in flight (requestUpload awaiting the presign)", async () => {
    const presign = deferred();
    const provider = new TestProvider();
    provider.presignUpload = async (key: string) => {
      await presign.promise;
      return { url: `https://example/upload/${key}`, method: "PUT", expiresAt: Date.now() + 60_000 };
    };
    const { el, ws, errors } = mount(provider);
    ws.open();
    await flushMany();
    el.file = new Blob(["x"]);

    const pending = el.upload();
    await flushMany();
    ws.drop();
    const rejection = await rejectionOf(pending);
    presign.resolve();
    await flushMany();

    // `upload()` still rejects with the remote layer's code …
    expect(rejection.code).toBe("WC_BINDABLE_DISPOSED");
    // … but the only event is the drop itself, which names the cause.
    expectConnectionError(errors, el, "lost");
  });

  it("while an RPC is in flight, with trigger = true", async () => {
    const presign = deferred();
    const provider = new TestProvider();
    provider.presignUpload = async (key: string) => {
      await presign.promise;
      return { url: `https://example/upload/${key}`, method: "PUT", expiresAt: Date.now() + 60_000 };
    };
    const { el, ws, errors } = mount(provider);
    ws.open();
    await flushMany();
    el.file = new Blob(["x"]);

    el.trigger = true;
    await flushMany();
    ws.drop();
    presign.resolve();
    await flushMany();

    expectConnectionError(errors, el, "lost");
    expect(el.trigger).toBe(false);
  });

  it("while completeMultipart is in flight", async () => {
    const merge = deferred();
    const provider = new TestProvider();
    provider.completeMultipart = async () => {
      await merge.promise;
      return { etag: "merged" };
    };
    const { el, ws, errors } = mount(provider);
    ws.open();
    await flushMany();
    el.setAttribute("multipart-threshold", "4");
    el.file = new Blob(["0123456789"]);

    const pending = el.upload();
    await flushMany();
    ws.drop();
    const rejection = await rejectionOf(pending);
    merge.resolve();
    await flushMany();

    expect(rejection.code).toBe("WC_BINDABLE_DISPOSED");
    expectConnectionError(errors, el, "lost");
  });

  it("while the single PUT is in flight", async () => {
    putPlan = () => null; // hangs until the Shell cancels it
    const { el, ws, errors } = mount(new TestProvider(), { "put-retries": "0" });
    ws.open();
    await flushMany();
    el.file = new Blob(["x"]);

    const pending = el.upload();
    await flushMany();
    ws.drop();
    const rejection = await rejectionOf(pending);
    await flushMany();

    expect(rejection.message).toMatch(/upload aborted/);
    expectConnectionError(errors, el, "lost");
  });

  it("while multipart part PUTs are in flight", async () => {
    putPlan = () => null;
    const { el, ws, errors } = mount(new TestProvider(), { "put-retries": "0", "multipart-threshold": "4" });
    ws.open();
    await flushMany();
    el.file = new Blob(["0123456789"]);

    const pending = el.upload();
    await flushMany();
    ws.drop();
    await rejectionOf(pending);
    await flushMany();

    expectConnectionError(errors, el, "lost");
  });

  it("while input setWithAck calls are pending (the socket never opens)", async () => {
    const { el, ws, errors } = mount(new TestProvider(), { bucket: "b2", prefix: "p/", "content-type": "text/plain" });

    ws.fail();
    await flushMany();

    expectConnectionError(errors, el, "failed");
  });

  it("an attribute change racing the drop", async () => {
    const { el, ws, errors } = mount(new TestProvider());
    ws.open();
    await flushMany();

    el.setAttribute("bucket", "b2"); // setWithAck sent, ack not yet back
    ws.drop();
    await flushMany();

    expectConnectionError(errors, el, "lost");
  });

  it("a later upload() on the torn-down element is a separate failure with its own event", async () => {
    const { el, ws, errors } = mount(new TestProvider());
    ws.open();
    await flushMany();
    ws.drop();
    el.file = new Blob(["x"]);

    const rejection = await rejectionOf(el.upload());

    expect(rejection.message).toMatch(/no core attached/);
    expect(errors).toHaveLength(2);
    expect(errors[1]).toBe(rejection);
  });
});
