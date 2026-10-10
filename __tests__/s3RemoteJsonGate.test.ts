import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { S3 } from "../src/components/S3";
import { S3Core } from "../src/core/S3Core";
import {
  RemoteShellProxy,
  isJsonValue,
  type ClientMessage,
  type ClientTransport,
  type Logger,
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
 * End-to-end regressions for the @wc-bindable/remote 0.10 JsonValue gate,
 * driven through the REAL `RemoteCoreProxy` (inside the Shell) and
 * `RemoteShellProxy` (wrapping a real `S3Core`). Every frame is
 * JSON-stringified / parsed like a WebSocket text frame.
 *
 * Before the fixes these all failed silently: the consumer refused to send
 * an `undefined` argument, the producer dropped `error` / `metadata` updates
 * that were not strict JsonValues, and the Shell — which leaves Core-side
 * failures to the `bind()` mirror — dispatched nothing, so `el.error` stayed
 * null and no `s3-uploader:error` fired.
 */

interface Wire {
  client: ClientTransport;
  server: ServerTransport;
  /** Every client → server message, as it crossed the wire. */
  sent: ClientMessage[];
  /** Simulate the client side of the connection closing. */
  closeClient: () => void;
}

function pairedTransports(): Wire {
  let clientHandler: ((m: ServerMessage) => void) | null = null;
  let serverHandler: ((m: ClientMessage) => void) | null = null;
  let clientClose: (() => void) | null = null;
  const sent: ClientMessage[] = [];
  const client: ClientTransport = {
    send: (m) => {
      const frame = JSON.stringify(m);
      sent.push(JSON.parse(frame) as ClientMessage);
      queueMicrotask(() => serverHandler?.(JSON.parse(frame) as ClientMessage));
    },
    onMessage: (h) => { clientHandler = h; },
    onClose: (h) => { clientClose = h; },
  };
  const server: ServerTransport = {
    send: (m) => {
      const frame = JSON.stringify(m);
      queueMicrotask(() => clientHandler?.(JSON.parse(frame) as ServerMessage));
    },
    onMessage: (h) => { serverHandler = h; },
  };
  return { client, server, sent, closeClient: () => clientClose?.() };
}

/** Provider whose every method can be overridden per test. */
class TestProvider implements IS3Provider {
  presignUploadCalls = 0;
  async presignUpload(key: string, _o: S3RequestOptions): Promise<PresignedUpload> {
    this.presignUploadCalls++;
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

/** XHR stub: every PUT succeeds with an ETag; records what was opened. */
const xhrLog: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
class FakeXHR {
  upload = { addEventListener: (_n: string, _fn: (e: ProgressEvent) => void) => {} };
  private _listeners: Record<string, Array<(e: Event) => void>> = {};
  private _entry = { method: "", url: "", headers: {} as Record<string, string> };
  open(method: string, url: string): void {
    this._entry = { method, url, headers: {} };
    xhrLog.push(this._entry);
  }
  setRequestHeader(name: string, value: string): void { this._entry.headers[name] = value; }
  addEventListener(name: string, fn: (e: Event) => void): void {
    (this._listeners[name] ??= []).push(fn);
  }
  send(_body: unknown): void {
    queueMicrotask(() => {
      for (const fn of this._listeners["load"] ?? []) fn(new Event("load"));
    });
  }
  abort(): void {}
  getResponseHeader(name: string): string | null {
    return name.toLowerCase() === "etag" ? '"deadbeef"' : null;
  }
  get status(): number { return 200; }
  get responseText(): string { return ""; }
  get statusText(): string { return "OK"; }
}

const flushMany = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
};

beforeAll(() => {
  if (!customElements.get("s3-uploader")) customElements.define("s3-uploader", S3);
});

interface Harness {
  el: S3;
  core: S3Core;
  wire: Wire;
  /** Non-null `s3-uploader:error` details dispatched on the element. */
  errors: unknown[];
  /** Warnings the producer logged (dropped updates, getterFailures, …). */
  shellLogger: Logger & { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
}

describe("S3 Shell over @wc-bindable/remote 0.10 — JsonValue gate regressions", () => {
  const RealXHR = globalThis.XMLHttpRequest;
  let consoleWarn: ReturnType<typeof vi.spyOn>;
  const mounted: S3[] = [];

  beforeEach(() => {
    xhrLog.length = 0;
    (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXHR;
    // The consumer-side proxy logs through console (e.g. the warning a
    // `sync` with `getterFailures` triggers); none is expected anywhere.
    consoleWarn = vi.spyOn(console, "warn");
  });

  afterEach(() => {
    (globalThis as unknown as { XMLHttpRequest: typeof XMLHttpRequest }).XMLHttpRequest = RealXHR;
    consoleWarn.mockRestore();
    for (const el of mounted.splice(0)) el.remove();
  });

  async function connect(provider: IS3Provider, setup?: (core: S3Core) => void | Promise<void>): Promise<Harness> {
    const wire = pairedTransports();
    const core = new S3Core(provider);
    core.bucket = "b";
    await setup?.(core);
    const shellLogger = { warn: vi.fn(), error: vi.fn() };
    new RemoteShellProxy(core, wire.server, { logger: shellLogger });

    const el = document.createElement("s3-uploader") as S3;
    const errors: unknown[] = [];
    el.addEventListener("s3-uploader:error", (ev: Event) => {
      const detail = (ev as CustomEvent).detail;
      if (detail != null) errors.push(detail);
    });
    document.body.appendChild(el);
    mounted.push(el);
    (el as any)._connectRemote(wire.client);
    await flushMany();
    return { el, core, wire, errors, shellLogger };
  }

  function cmdArgs(wire: Wire, name: string): unknown[][] {
    return wire.sent
      .filter((m): m is Extract<ClientMessage, { type: "cmd" }> => m.type === "cmd" && m.name === name)
      .map(m => m.args);
  }

  describe("B1/B3 — a File without a type and no content-type attribute", () => {
    it("single PUT: uploads, omits the undefined contentType argument, and delivers metadata", async () => {
      const { el, wire, errors, shellLogger } = await connect(new TestProvider());
      el.key = "k";
      el.file = new Blob(["payload"]); // type === ""

      await expect(el.upload()).resolves.toBe("https://example/download/k");
      await flushMany();

      // The trailing optional argument is omitted, not sent as undefined
      // (which the 0.10 consumer refuses to send at all).
      expect(cmdArgs(wire, "requestUpload")).toEqual([["k", 7]]);
      expect(el.metadata).toEqual({ size: 7 });
      expect(el.completed).toBe(true);
      expect(el.url).toBe("https://example/download/k");
      expect(errors).toEqual([]);
      expect(el.error).toBeNull();
      expect(shellLogger.warn).not.toHaveBeenCalled();
      expect(consoleWarn).not.toHaveBeenCalled();
    });

    it("multipart: uploads and delivers metadata without contentType", async () => {
      const { el, wire, errors, shellLogger } = await connect(new TestProvider());
      el.setAttribute("multipart-threshold", "4");
      el.key = "big";
      el.file = new Blob(["0123456789"]); // > threshold, type === ""

      await expect(el.upload()).resolves.toBe("https://example/download/big");
      await flushMany();

      expect(cmdArgs(wire, "requestMultipartUpload")).toEqual([["big", 10]]);
      expect(el.metadata).toEqual({ size: 10 });
      expect(el.completed).toBe(true);
      expect(errors).toEqual([]);
      expect(shellLogger.warn).not.toHaveBeenCalled();
      expect(consoleWarn).not.toHaveBeenCalled();
    });
  });

  describe("B2 — Core-side failures reach the browser exactly once", () => {
    function failingPresign(): TestProvider {
      const p = new TestProvider();
      p.presignUpload = async () => { throw new Error("[upload] content-type not allowed: <none>"); };
      return p;
    }

    it("a provider presign rejection (the README allowlist recipe) dispatches one s3-uploader:error", async () => {
      const { el, errors, shellLogger } = await connect(failingPresign());
      el.file = new Blob(["x"]);
      await expect(el.upload()).rejects.toThrow("content-type not allowed");
      await flushMany();

      expect(errors).toEqual([{ name: "Error", message: "[upload] content-type not allowed: <none>" }]);
      expect(isJsonValue(errors[0])).toBe(true);
      expect(el.error).toEqual({ name: "Error", message: "[upload] content-type not allowed: <none>" });
      expect(shellLogger.warn).not.toHaveBeenCalled();
    });

    it("trigger = true (which swallows the upload() rejection) still surfaces the failure", async () => {
      const { el, errors } = await connect(failingPresign());
      el.file = new Blob(["x"]);
      el.trigger = true;
      await flushMany();

      expect(errors).toHaveLength(1);
      expect(el.error).toEqual({ name: "Error", message: "[upload] content-type not allowed: <none>" });
      expect(el.trigger).toBe(false);
    });

    it("a fatal post-process hook failure dispatches one s3-uploader:error", async () => {
      const { el, errors, shellLogger } = await connect(new TestProvider(), (core) => {
        core.registerPostProcess(() => { throw new Error("virus scan rejected"); });
      });
      el.file = new Blob(["x"]);
      await expect(el.upload()).rejects.toThrow("virus scan rejected");
      await flushMany();

      expect(errors).toEqual([{ name: "Error", message: "virus scan rejected" }]);
      expect(el.completed).toBe(false);
      expect(shellLogger.warn).not.toHaveBeenCalled();
    });

    it("a completeMultipart failure dispatches one s3-uploader:error", async () => {
      const provider = new TestProvider();
      provider.completeMultipart = async () => { throw new Error("InvalidPart"); };
      const { el, errors, shellLogger } = await connect(provider);
      el.setAttribute("multipart-threshold", "4");
      el.file = new Blob(["0123456789"]);
      await expect(el.upload()).rejects.toThrow("InvalidPart");
      await flushMany();

      expect(errors).toEqual([{ name: "Error", message: "InvalidPart" }]);
      expect(shellLogger.warn).not.toHaveBeenCalled();
    });

    it.each([
      ["an application code", "AccessDenied"],
      ["a reserved-namespace code (rewritten to WC_BINDABLE_REMOTE_THROW)", "WC_BINDABLE_DISPOSED"],
    ])("a Core failure carrying %s is left to the mirror (no second local dispatch)", async (_label, code) => {
      const provider = new TestProvider();
      provider.presignUpload = async () => { throw Object.assign(new Error("denied"), { code }); };
      const { el, errors } = await connect(provider);
      el.file = new Blob(["x"]);
      await expect(el.upload()).rejects.toThrow("denied");
      await flushMany();

      expect(errors).toEqual([{ name: "Error", message: "denied" }]);
    });

    it("a Core that already failed is delivered through sync (the getter is a JsonValue too)", async () => {
      const provider = new TestProvider();
      provider.presignUpload = async () => { throw new Error("earlier failure"); };
      const { el, shellLogger } = await connect(provider, async (core) => {
        await core.requestUpload("k", 1).catch(() => {});
      });

      expect(el.error).toEqual({ name: "Error", message: "earlier failure" });
      expect(shellLogger.warn).not.toHaveBeenCalled();
      expect(shellLogger.error).not.toHaveBeenCalled();
      expect(consoleWarn).not.toHaveBeenCalled();
    });
  });

  describe("B1 — failures that never reach the Core's error slot are dispatched locally, once", () => {
    it("consumer-side JsonValue rejection (WC_BINDABLE_INVALID_JSON_VALUE) never reaches the Core", async () => {
      class NaNSizeBlob extends Blob {
        get size(): number { return Number.NaN; }
      }
      const provider = new TestProvider();
      const { el, core, errors } = await connect(provider);
      el.file = new NaNSizeBlob(["x"]);

      await expect(el.upload()).rejects.toMatchObject({ code: "WC_BINDABLE_INVALID_JSON_VALUE" });
      await flushMany();

      expect(errors).toHaveLength(1);
      expect((errors[0] as { code?: string }).code).toBe("WC_BINDABLE_INVALID_JSON_VALUE");
      expect(el.error).toBe(errors[0]);
      // Rejected before sending: the Core and the provider never ran.
      expect(provider.presignUploadCalls).toBe(0);
      expect(core.loading).toBe(false);
    });

    it("transport closed mid-RPC (WC_BINDABLE_TERMINAL_FAILURE)", async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>(r => { release = r; });
      const provider = new TestProvider();
      provider.presignUpload = async (key: string) => {
        await gate;
        return { url: `https://example/upload/${key}`, method: "PUT", expiresAt: Date.now() + 60_000 };
      };
      const { el, wire, errors } = await connect(provider);
      el.file = new Blob(["x"]);
      const pending = el.upload();
      await flushMany();

      wire.closeClient();
      await expect(pending).rejects.toMatchObject({ code: "WC_BINDABLE_TERMINAL_FAILURE" });
      release();
      await flushMany();

      expect(errors).toHaveLength(1);
      expect((errors[0] as { code?: string }).code).toBe("WC_BINDABLE_TERMINAL_FAILURE");
    });

    it("producer-side return-value rejection (WC_BINDABLE_INVALID_RETURN_VALUE)", async () => {
      // A provider violating the IS3Provider contract with a non-JSON member
      // the Core does not paper over (only `undefined` keys are dropped).
      const provider = new TestProvider();
      provider.presignUpload = async (key: string) => ({
        url: `https://example/upload/${key}`,
        method: "PUT",
        expiresAt: new Date() as unknown as number,
      });
      const { el, errors } = await connect(provider);
      el.file = new Blob(["x"]);

      await expect(el.upload()).rejects.toMatchObject({ code: "WC_BINDABLE_INVALID_RETURN_VALUE" });
      await flushMany();

      expect(errors).toHaveLength(1);
      expect((errors[0] as { code?: string }).code).toBe("WC_BINDABLE_INVALID_RETURN_VALUE");
    });
  });

  describe("B4 — non-Error provider rejections keep name / message across the wire", () => {
    it("a plain-object rejection arrives as AccessDenied, not NonErrorThrow / [object Object]", async () => {
      const provider = new TestProvider();
      provider.presignUpload = async () => {
        throw { name: "AccessDenied", message: "denied by policy" };
      };
      const { el, errors } = await connect(provider);
      el.file = new Blob(["x"]);

      const rejection = await el.upload().then(
        () => { throw new Error("expected a rejection"); },
        (e: unknown) => e as Error,
      );
      await flushMany();

      expect(rejection.name).toBe("AccessDenied");
      expect(rejection.message).toBe("denied by policy");
      expect(errors).toEqual([{ name: "AccessDenied", message: "denied by policy" }]);
    });

    it("a bare-string rejection keeps its text as the message", async () => {
      const provider = new TestProvider();
      provider.presignUpload = async () => { throw "throttled"; };
      const { el, errors } = await connect(provider);
      el.file = new Blob(["x"]);

      await expect(el.upload()).rejects.toMatchObject({ name: "Error", message: "throttled" });
      await flushMany();
      expect(errors).toEqual([{ name: "Error", message: "throttled" }]);
    });
  });

  describe("in-process Shell (attachLocalCore) keeps exposing the original instance", () => {
    it("el.error is the provider's Error, while core.error is the plain projection", async () => {
      const providerError = new Error("local denial");
      const provider = new TestProvider();
      provider.presignUpload = async () => { throw providerError; };
      const core = new S3Core(provider);
      core.bucket = "b";
      const el = document.createElement("s3-uploader") as S3;
      const errors: unknown[] = [];
      el.addEventListener("s3-uploader:error", (ev: Event) => errors.push((ev as CustomEvent).detail));
      el.attachLocalCore(core);
      document.body.appendChild(el);
      mounted.push(el);
      el.file = new Blob(["x"]);

      await expect(el.upload()).rejects.toBe(providerError);
      expect(el.error).toBe(providerError);
      expect(errors).toEqual([providerError]);
      expect(core.error).toEqual({ name: "Error", message: "local denial" });
    });
  });

  describe("B6 — custom-provider results with unset optional members", () => {
    it("presignUpload returning headers: undefined still uploads", async () => {
      const provider = new TestProvider();
      provider.presignUpload = async (key: string) => ({
        url: `https://example/upload/${key}`,
        method: "PUT",
        headers: undefined,
        expiresAt: Date.now() + 60_000,
      });
      const { el, errors } = await connect(provider);
      el.key = "k";
      el.file = new Blob(["x"], { type: "text/plain" });

      await expect(el.upload()).resolves.toBe("https://example/download/k");
      expect(errors).toEqual([]);
    });

    it("presignPart without expiresAt and with an undefined header value still uploads", async () => {
      const provider = new TestProvider();
      provider.presignPart = async (_k: string, _u: string, partNumber: number) => ({
        url: `https://example/part/${partNumber}`,
        method: "PUT",
        headers: { "x-amz-meta-a": "1", "x-amz-meta-b": undefined as unknown as string },
        expiresAt: undefined as unknown as number,
      });
      const { el, wire, errors } = await connect(provider);
      el.setAttribute("multipart-threshold", "4");
      el.key = "big";
      el.file = new Blob(["0123456789"]);

      await expect(el.upload()).resolves.toBe("https://example/download/big");
      expect(errors).toEqual([]);
      // No expiry known → the Shell re-signs before the PUT, as it did when
      // 0.7's JSON encoding dropped the undefined key.
      expect(cmdArgs(wire, "signMultipartPart")).toEqual([["big", "mp-1", 1]]);
      const partPut = xhrLog.find(x => x.url.startsWith("https://example/part/"));
      expect(partPut?.headers).toEqual({ "x-amz-meta-a": "1" });
    });
  });
});
