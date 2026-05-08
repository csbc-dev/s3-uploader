# CLAUDE.md

This repository (`@csbc-dev/s3-uploader`) is a re-packaged member of the `csbc-dev/arch` architecture family, originating from [`@wc-bindable/s3`](https://github.com/wc-bindable-protocol/wc-bindable-protocol/tree/main/packages/s3). The two background documents below are required reading for the design intent; a third section covers what is specific to **this** package.

---

## 1. Overview of wc-bindable-protocol

A framework-agnostic, minimal protocol that lets any class extending `EventTarget` declare its reactive properties. Reactivity systems in React / Vue / Svelte / Angular / Solid can then bind to arbitrary components without framework-specific glue code.

### Core idea

- The component author declares **what** is bindable.
- The framework consumer decides **how** to bind it.
- Neither side needs to know about the other.

### How to declare

Just write a schema in the `static wcBindable` field.

```javascript
class MyFetchCore extends EventTarget {
  static wcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "value",   event: "my-fetch:value-changed" },
      { name: "loading", event: "my-fetch:loading-changed" },
    ],
    inputs:   [{ name: "url" }, { name: "method" }],   // optional
    commands: [{ name: "fetch", async: true }, { name: "abort" }],  // optional
  };
}
```

| Field | Required | Role |
|---|---|---|
| `properties` | ✅ | Properties that announce state changes via `CustomEvent` (output) |
| `inputs` | — | Configurable properties (input; declarative only — no auto-sync) |
| `commands` | — | Invokable methods (for remote proxies and tooling) |

### How binding works

An adapter only needs to:

1. Read `target.constructor.wcBindable`.
2. Verify `protocol === "wc-bindable" && version === 1`.
3. For each `property`, read `target[name]` immediately to deliver the initial value, then subscribe to `event`.

`bind()` is at most ~20 lines. Framework adapters fit in a few dozen lines.

### Out of scope (deliberately)

- Automatic two-way sync (reflecting input is the caller's responsibility).
- Form integration.
- SSR / hydration.
- Runtime type or schema validation.

### Why `EventTarget`?

Requiring `EventTarget` rather than `HTMLElement` lets the same protocol run in non-browser runtimes such as Node.js / Deno / Cloudflare Workers. `HTMLElement` is a subclass of `EventTarget`, so Web Components are automatically compatible.

Reference: [wc-bindable-protocol/SPEC.md](https://github.com/wc-bindable-protocol/wc-bindable-protocol/blob/main/SPEC.md)

---

## 2. Overview of the Core/Shell Bindable Component (CSBC) architecture

Built on top of wc-bindable-protocol, CSBC structurally eliminates framework lock-in by **moving business logic — particularly async work — out of the framework layer and into the Web Component side**.

### The problem it solves

The real cost of a framework migration is not UI compatibility but the **async logic that is tightly coupled to framework-specific lifecycle APIs (`useEffect` / `onMounted` / `onMount` / …)**. Templates can be rewritten mechanically, but async code requires semantic understanding, so porting it explodes the migration cost.

### Three-layer structure

1. **Headless Web Component layer** — encapsulates async work (fetch / WebSocket / timers / …) and state (`value`, `loading`, `error`, …) inside the component. It has no UI and behaves as a pure service layer.
2. **Protocol layer (wc-bindable-protocol)** — exposes that state to the outside via `static wcBindable` + `CustomEvent`.
3. **Framework layer** — connects to the protocol through a thin adapter and renders the received state. **No async code is written here.**

### Core / Shell separation

The headless layer is further split in two. **The invariant is not "the Shell is always thin" — it is where decisions live**:

- **Core (`EventTarget`) — owns decisions.**
  Business logic, policy, state transitions, authorization-related behavior, event emission. If kept DOM-independent, it is portable to Node.js / Deno / Workers.
- **Shell (`HTMLElement`) — owns only the execution that cannot be delegated.**
  Framework wiring, DOM lifecycle, anything that has to run in the browser.

The design key is the **target injection** pattern: the Core's constructor accepts an arbitrary `EventTarget` and dispatches every event to it. When the Shell passes `this`, the Core's events fire directly from the DOM element and re-dispatch is unnecessary.

### Four canonical cases

| Case | Where the Core lives | What the Shell does | Example |
|---|---|---|---|
| A | Browser | Thin wrapper around a browser-bound Core | `auth0-gate` (local) |
| B1 | Server | Thin Shell that brokers commands as a proxy | `ai-agent` (remote) |
| B2 | Server | Observation-only Shell that subscribes to a remote session | `feature-flags` |
| C | Server | Shell that runs a browser-only data plane | **`s3-uploader`**, `passkey-auth`, `stripe-checkout` |

Case C is **not** a deviation from CSBC principles — it is a **first-class case**. It arises whenever there is a data plane that can only run in the browser (direct upload, WebRTC, WebUSB, the `File System Access API`, anything dependent on a user gesture, Stripe Elements to keep PCI scope off the server, …). A "fat" Shell is fine **as long as decisions still live in the Core**.

> Invariant:
> **The Core owns every decision. The Shell only does what cannot be delegated.**

### Three boundaries it crosses

| Boundary | Crosser | Mechanism |
|---|---|---|
| Runtime boundary | Core (`EventTarget`) | DOM-independent. Runs on Node / Deno / Workers. |
| Framework boundary | Shell (`HTMLElement`) | Attribute mapping + `ref` binding. |
| Network boundary | `@wc-bindable/remote` | Proxy `EventTarget` + JSON wire protocol. |

`@wc-bindable/remote` is a pair of `RemoteShellProxy` (server side) and `RemoteCoreProxy` (client side). It pushes the Core fully onto the server while keeping the client-side `bind()` unchanged. WebSocket is the default transport; anything that satisfies the minimal `ClientTransport` / `ServerTransport` interfaces (MessagePort / BroadcastChannel / WebTransport / …) can be swapped in.

### Where this package sits

`@csbc-dev/s3-uploader` is a **Case C** package. Every decision about an upload — minting presigned URLs, holding AWS credentials, SigV4 signing, the multipart control plane (Initiate / Complete / Abort), running `registerPostProcess` hooks — is owned by `S3Core` (the Core, an `EventTarget`) on the server. `<s3-uploader>` (the Shell, an `HTMLElement`) handles only the browser-anchored data plane: file picking, direct PUT to S3 (single or per-part), progress reporting, and abort handling.

> **Bytes never traverse the WebSocket.** What flows through the channel is signing requests, progress events (rAF-coalesced), and completion notifications; the file body goes straight from the browser to S3. As a result, server cost does **not** scale with upload size — it scales as `O(connections × signing_rate)`.

Because the Core is remote, AWS credentials are never exposed to the browser, and decisions like prefix-based tenant isolation, content-type allowlists, or post-process hook work (DB writes, virus scanning, …) are all settled server-side. The package does not depend on the AWS SDK; SigV4 is implemented with the Web Crypto API. The only runtime dependencies are `@wc-bindable/core` and `@wc-bindable/remote`.

Reference: [csbc-dev/arch (formerly hawc)](https://github.com/csbc-dev/arch/blob/main/README.md)

---

## 3. This package — layout, entry points, conventions

This section is specific to `@csbc-dev/s3-uploader`. For end-user usage, security responsibilities, the component API surface, framework-integration recipes, multipart sizing, retry policy, error taxonomy, etc., the canonical reference is [README.md](README.md). The points below are what an agent working **inside** this repo should know in addition.

### Package metadata

- Package name: `@csbc-dev/s3-uploader` (see [package.json](package.json)).
- Distribution: ESM only (`"type": "module"`).
- Runtime dependencies: `@wc-bindable/core`, `@wc-bindable/remote`. **No AWS SDK** — SigV4 is hand-rolled on Web Crypto.
- Dev dependencies of note: `typescript`, `vitest`, `@playwright/test`, `happy-dom`, `ws`.

### Source layout

```
src/
├── index.ts                   ← browser barrel (default export)
├── server.ts                  ← Node-safe barrel (no HTMLElement-backed code)
├── bootstrapS3.ts             ← one-shot setup that registers <s3-uploader> / <s3-callback>
├── config.ts                  ← config store read at element-connect time
├── registerComponents.ts      ← customElements.define wiring
├── processEnv.ts              ← reads globalThis.S3_REMOTE_CORE_URL / process.env.S3_REMOTE_CORE_URL
├── retry.ts                   ← retryWithBackoff, PutHttpError, MissingEtagError, defaultPutRetryPolicy
├── normaliseError.ts          ← shapes thrown values into Error instances on the wire
├── raiseError.ts              ← consistent error-dispatch helper for the Shell
├── types.ts                   ← IS3Provider, PresignedUpload, S3RequestOptions, WcsS3Values, ...
├── core/
│   └── S3Core.ts              ← Core (EventTarget). Owns credentials, signing, post-process hooks
├── components/
│   ├── S3.ts                  ← <s3-uploader> Shell (HTMLElement)
│   ├── S3Callback.ts          ← <s3-callback> Shell — Blob-imports inline <script type="module">
│   ├── remoteConnection.ts    ← WebSocket adapter for RemoteCoreProxy on the browser side
│   └── xhrUploader.ts         ← XHR-based PUT with progress events and per-PUT retry
├── providers/
│   └── AwsS3Provider.ts       ← default IS3Provider; reads AWS_* env vars
├── signing/
│   └── sigv4.ts               ← presignS3Url, SkewError, all SigV4 primitives via Web Crypto
└── auto/
    ├── auto.{js,d.ts,min.js}        ← side-effect entry: bootstrapS3() with defaults
    └── remoteEnv.{js,d.ts,min.js}   ← side-effect entry: enables remote mode and reads URL from env
```

### Public entry points

| subpath | environment | exports |
|---|---|---|
| `@csbc-dev/s3-uploader` | browser | `bootstrapS3`, `WcsS3`, `WcsS3Callback`, `S3Core`, `AwsS3Provider`, retry helpers, types |
| `@csbc-dev/s3-uploader/server` | Node | `S3Core`, `AwsS3Provider`, `presignS3Url`, retry helpers, types — **no `HTMLElement`-based code** |
| `@csbc-dev/s3-uploader/auto` | browser (side-effect) | calls `bootstrapS3()` so `<s3-uploader>` and `<s3-callback>` register on import |
| `@csbc-dev/s3-uploader/auto/remoteEnv` | browser (side-effect) | calls `bootstrapS3({ remote: { enableRemote: true, remoteSettingType: "env" } })` and reads the WS URL from `globalThis.S3_REMOTE_CORE_URL` / `process.env.S3_REMOTE_CORE_URL` |

The default barrel is **browser-targeted on purpose**. Importing it from Node fails at module evaluation (`HTMLElement is not defined`); any code that runs outside a browser must use `/server`.

When adding new server-safe helpers, mirror the export in both [src/index.ts](src/index.ts) and [src/server.ts](src/server.ts). When adding browser-only helpers, **only** export them from [src/index.ts](src/index.ts).

### Build & scripts

| script | what it does |
|---|---|
| `npm run build` | `tsc` → emits to `dist/` (referenced by `main` / `types` / `exports`) |
| `npm run dev` | `tsc --watch` |
| `npm test` | `vitest run __tests__` (unit / DOM tests via happy-dom) |
| `npm run test:watch` | `vitest __tests__` |
| `npm run test:integration` | builds, sets up `scripts/setup-integration-packages.mjs`, then runs Playwright |
| `prepack` | runs `npm run build` automatically on publish |

### Test layout

- `__tests__/` — Vitest unit and DOM tests. Default environment is happy-dom; this is where Core logic, signing, retry policy, and Shell behavior in a fake DOM live.
- `tests/` — Playwright integration suite invoked by `test:integration`. Requires the build output and the integration-packages setup script.

When fixing a bug, prefer adding a regression test to `__tests__/` first; reach for Playwright only when the failure is genuinely browser-shaped (real XHR progress events, real network, real CORS).

### Conventions specific to this package

- **Class name vs. tag name.** The default tag is `<s3-uploader>` but the exported class is `WcsS3` (with `WcsS3Callback` for `<s3-callback>`). The `Wcs` prefix is the package-wide class namespace shared across `@wc-bindable/*`. When grepping, use the tag name in templates and the class name in JS/TS.
- **Event-name suffix.** Every observable property dispatches `s3-uploader:<name>-changed` — including booleans like `completed-changed`. The one exception is `error`, which dispatches as `s3-uploader:error` (no suffix) because it is a signal, not a state transition. Renaming this convention requires every binder in the ecosystem to carry a per-property exception table — do not "improve" it locally.
- **Errors split into two layers.** Package-owned errors (`PutHttpError`, `MissingEtagError`) are exported as classes and unioned under the closed `S3OwnedError` type — adding a new member is a breaking change you can catch at compile time. Upstream errors (`AccessDenied`, transport, CORS, …) are passed through unwrapped as plain `Error` instances. Do not wrap upstream errors in new package classes.
- **No AWS SDK.** Anything that needs SigV4 goes through [src/signing/sigv4.ts](src/signing/sigv4.ts) on Web Crypto. Adding `aws-sdk` / `@aws-sdk/*` is a non-goal; keep the runtime dependency surface at `@wc-bindable/core` + `@wc-bindable/remote`.
- **Provider wrapping over forking.** Pre-presign rejection (size cap, content-type allowlist, key-shape checks, per-tenant scoping) is done by wrapping `IS3Provider` and throwing from `presignUpload` / `initiateMultipart`, not by patching `AwsS3Provider`. See the recipe in [README.md](README.md#extension-points).
- **Configure once, before connect.** `bootstrapS3()` / `setConfig()` is intended to run once before any element is connected to the document. Re-configuring after connect leaves already-connected elements on their cached settings while new ones see the new settings — undefined behavior.
- **`ws.on("close", () => core.abort())` is load-bearing.** Without it, an interrupted multipart leaves orphan parts in S3 because the client cannot reach `abortMultipart` through a dead control channel. Any new server-example or doc snippet that omits it is wrong.
