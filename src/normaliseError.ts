import type { SerializedError, WcsS3AnyError } from "./types.js";

/**
 * Normalise any thrown value to the `WcsS3AnyError` union kept in the error
 * slots (`S3Core._errorSource`, `S3._errorState`).
 * Single choke-point shared by the Core (`S3Core._setError`) and the Shell
 * (`S3._setErrorState`) so remote and local consumers see identical
 * structure for any rejection — whether the provider threw an `Error`
 * instance, a bare string, a pre-serialised plain object from another realm,
 * or an AWS-SDK-shaped payload.
 *
 * The returned value always satisfies `WcsS3AnyError`:
 *   - `null` / `undefined` collapses to `null`
 *   - a real `Error` instance is returned as-is
 *   - a plain object with a `message` field is coerced to the
 *     `SerializedError` shape (name/message defaulted so downstream consumers
 *     never see a required field missing; `stack` carried only when it is a
 *     string — never as an `undefined`-valued key, which
 *     `@wc-bindable/remote` ≥ 0.10 rejects as a non-JsonValue)
 *   - everything else (numbers, booleans, symbols, arrays, plain objects
 *     without a message) is wrapped as `new Error(String(err))`
 */
export function normaliseError(err: unknown): WcsS3AnyError {
  if (err == null) return null;
  if (err instanceof Error) return err;
  if (typeof err === "object" && err !== null && "message" in (err as Record<string, unknown>)) {
    // Plain-object shapes (pre-serialised error from another realm, AWS-SDK
    // shaped payloads, etc.). Coerce to the SerializedError shape rather than
    // trusting the arbitrary input — callers see a stable interface
    // regardless of how the provider phrased the rejection.
    const e = err as Record<string, unknown>;
    return {
      name: typeof e.name === "string" ? e.name : "Error",
      message: String(e.message ?? ""),
      ...(typeof e.stack === "string" ? { stack: e.stack } : {}),
    };
  }
  return new Error(String(err));
}

/**
 * Turn any rejection value into a real `Error` the Core can rethrow.
 *
 * `@wc-bindable/remote` ≥ 0.10 canonicalises a non-`Error` throw into an
 * `Error` named `NonErrorThrow` whose message is the value's default string
 * coercion — so a provider that rejects with `{ name: "AccessDenied",
 * message: "denied" }` would reach the browser as `"[object Object]"`. (0.7
 * forwarded the plain object and the consumer rebuilt an Error from its
 * `name` / `message`.) Routing every rethrow through here keeps `name` and
 * `message` intact on both the local and the remote path. A real `Error` is
 * returned as the same instance — upstream errors stay unwrapped, per the
 * package's two-layer error contract. `stack` / extra fields of a plain
 * object are deliberately not copied, and the raw value is not attached as
 * `cause`: the thrown Error is what `RemoteShellProxy` serialises onto the
 * wire, and the same security note that governs `stack` (below) says
 * producers SHOULD NOT pass an unsanitised `cause` to an untrusted client.
 */
export function toError(err: unknown): Error {
  const normalised = normaliseError(err);
  if (normalised instanceof Error) return normalised;
  // `null` here means the provider rejected with null / undefined — still a
  // failure, so give it the same `String(value)` message upstream's
  // `NonErrorThrow` mapping would.
  const plain = toSerializedError(normalised);
  const error = new Error(plain === null ? String(err) : plain.message);
  if (plain !== null) error.name = plain.name;
  return error;
}

/**
 * Project a normalised error onto the plain `{ name, message }` object the
 * Core publishes as its `error` property (getter and `s3-uploader:error`
 * detail alike).
 *
 * That value crosses the WebSocket, and `@wc-bindable/remote` ≥ 0.10
 * validates it as a strict JsonValue: an `Error` (or any class instance) is
 * rejected by prototype even with a `toJSON`, and so is an
 * `undefined`-valued key — the `update` is dropped and the `sync` lists the
 * property under `getterFailures`. Hence a fresh plain object with exactly
 * two string members.
 *
 * `stack` is intentionally omitted. The browser is an untrusted boundary,
 * and SPEC-extensions.md § Error envelope ("Security note on `stack` and
 * `cause`") says producers SHOULD omit `stack` there by default — a
 * server-side trace exposes internal paths and dependency layout to every
 * bound client. The original value (with `stack`, class and extra fields)
 * stays in-process, readable by the local Shell (`S3Core._localError`).
 */
export function toSerializedError(err: WcsS3AnyError): SerializedError | null {
  if (err == null) return null;
  const e = err as { name?: unknown; message?: unknown };
  return {
    name: typeof e.name === "string" && e.name ? e.name : "Error",
    message: typeof e.message === "string" ? e.message : String(e.message ?? ""),
  };
}
