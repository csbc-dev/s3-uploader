---
name: release
description: Release procedure for the @csbc-dev/s3-uploader npm package. Use this skill when the user asks to release, publish, ship, cut a version, bump the version, or prepare a release. The actual `npm publish` step is performed manually by the user — Claude must not run it.
---

# Release procedure for `@csbc-dev/s3-uploader`

This skill walks the assistant through the steps required to prepare a release of the `@csbc-dev/s3-uploader` package. The assistant prepares everything up to (but **not** including) the publish step. **`npm publish` is run manually by the user.**

---

## Important constraints

- **Never run `npm publish`.** The user performs publishing manually outside Claude. If the user asks Claude to publish, refuse and remind them this is a manual step.
- **Never run `npm version <bump>` without explicit user approval** — it creates a commit and a git tag and is hard to reverse cleanly.
- **Never push tags or commits to origin** without explicit user approval.
- **Do not skip git hooks** (no `--no-verify`, `--no-gpg-sign`, etc.) unless the user explicitly asks for it.
- All preparation must happen on a clean working tree. If the tree is dirty, ask the user how to proceed before continuing.

---

## Preflight checks

Before touching anything, run these in parallel and report the results to the user:

1. `git status` — confirm the working tree is clean and the branch is `main` (or the release branch the user names)
2. `git log --oneline -10` — show what is going into the release
3. Read [package.json](package.json) — note the current `version`
4. `npm test` — Vitest unit suite under `__tests__/` must pass
5. `npm run build` — `tsc` must succeed and produce `dist/`
6. **Verify no `file:` / `link:` / relative-path dependencies in `package.json` `dependencies`** — see "Local-path dependency check" below.

If the change touches the browser data plane (XHR upload, multipart orchestration, CORS), or the `IS3Provider` contract, also propose `npm run test:integration` (Playwright). It builds the package and runs against a real browser — slower and heavier, but the only thing that catches real-XHR-progress and real-CORS regressions. Run it on user approval, not automatically.

If any check fails, stop and report. Do not attempt fixes unless the user asks.

---

## Local-path dependency check (MANDATORY before publish)

`package.json` `dependencies` currently pins both `@wc-bindable/core` and `@wc-bindable/remote` to semver ranges (`^0.4.0`). It is common during development to temporarily swap one of these for a sibling-monorepo `file:` reference (e.g. `file:../../wc-bindable-protocol/wc-bindable-protocol/packages/core`). **`npm publish` will refuse to publish a package whose `dependencies` contain a `file:` URI** — and even if a registry accepted it, downstream `npm install @csbc-dev/s3-uploader` on any machine without that exact directory layout would fail.

Before running any publish-prep step, confirm with the user:

1. The matching versions of `@wc-bindable/core` and `@wc-bindable/remote` are published on npm and are the versions `@csbc-dev/s3-uploader` is built and tested against, AND
2. `package.json` `dependencies["@wc-bindable/core"]` and `dependencies["@wc-bindable/remote"]` are both semver ranges (`^X.Y.Z`) pointing at those published versions — not `file:` / `link:` / `portal:` / a relative path.

Procedure:

- Use Read on [package.json](package.json) and grep its `dependencies` block for any value starting with `file:` / `link:` / `portal:` / a relative path (`./` / `../`). If you find one, STOP and surface it as a blocker — do NOT continue with version bump, build verification, or commit.
- After the user updates the dep to a registry-resolvable range, re-run `npm install` and `npm test` so `package-lock.json` and the test suite pick up the published artifact instead of the sibling-monorepo build.
- Restore the `file:` reference in a follow-up commit AFTER the publish, if the user wants the dev-convenience pointer back. The release commit itself must ship a published-artifact-resolvable manifest.

If the user asks "why can't we just publish anyway", remind them that `npm publish` runs its own `_resolveLink`-style check and rejects `file:` deps with `EUNSUPPORTEDPROTOCOL` / "Cannot publish a package with a file: dependency".

---

## Version bump

Confirm the next version with the user before bumping. Follow semver:

- **patch** — bug fixes only, no API changes
- **minor** — backwards-compatible feature additions
- **major** — breaking changes

For this package, the following count as **breaking**:
- Any change to the `wcBindable.properties` / `inputs` / `commands` surface on `S3Core` (event names, property names, command names).
- Any change to exported types in [src/types.ts](src/types.ts) (`IS3Provider`, `PresignedUpload`, `S3RequestOptions`, `WcsS3Values`, …).
- Any change to the `<s3-uploader>` / `<s3-callback>` attribute or property contract.
- Any change to the `S3OwnedError` discriminated union (`PutHttpError`, `MissingEtagError`) — adding a member is breaking by design.
- Any change to the WebSocket wire protocol used between `RemoteShellProxy` and `RemoteCoreProxy`.

Once the user approves the bump level, update `version` in [package.json](package.json). Prefer editing the field directly rather than running `npm version`, so the user keeps control over commit/tag creation.

---

## Build verification

After the version bump:

1. `npm run build` — fresh `tsc` build from a clean state.
2. Sanity-check `dist/` contains the expected entry points (the `prepack` script runs `npm run build` automatically at publish time, but verify here):
   - `dist/index.js` + `dist/index.d.ts` — matches `package.json` `main` / `types` and the `.` export (browser barrel).
   - `dist/server.js` + `dist/server.d.ts` — matches the `./server` export (Node-safe barrel). **Note:** this is a flat file, not `dist/server/index.js`.
3. Verify the **two** auto bundles under [src/auto/](src/auto/) are up to date if any source they depend on has changed. The auto bundles are shipped from `src/auto/` (per `package.json` `files`), **not** generated by `tsc` — flag this to the user if either bundle may be stale:
   - [src/auto/auto.min.js](src/auto/auto.min.js) — default `bootstrapS3()` side-effect entry.
   - [src/auto/remoteEnv.min.js](src/auto/remoteEnv.min.js) — remote-mode side-effect entry that reads `S3_REMOTE_CORE_URL` from the env.
4. `npm pack --dry-run` — confirm the tarball contents match `package.json` `files` (`dist`, `src/auto`, `LICENSE`, `README.md`). Watch for accidentally-included files (e.g. `__tests__/`, `tests/`, `playwright.config.ts`, `test-results/`, `node_modules/`, the `packages/` working dir, etc.).

---

## Documentation

- Update any version reference in [README.md](README.md) or [CLAUDE.md](CLAUDE.md) if either cites a specific version.
- If the repository has a changelog, add an entry. If it does not, ask the user whether to start one — do not create `CHANGELOG.md` unsolicited.
- If the change affects the public API surface (component attributes, exported types, error contract), make sure the relevant section of [README.md](README.md) is in sync **before** the version bump.

---

## Commit and tag (with user approval)

When the user approves the prepared changes, propose a single commit:

```
chore(release): v<new-version>
```

Then propose creating an annotated tag `v<new-version>`. Run `git commit` and `git tag` only after the user approves. Do **not** push.

---

## Hand-off for manual publish

After the commit and tag are created locally, hand off to the user with a checklist they will run manually:

```
# user runs these manually — Claude does not execute them
git push origin main
git push origin v<new-version>
npm publish --access public
```

(Use `--access public` because `@csbc-dev/s3-uploader` is a scoped package; the user can omit this if their npm config already defaults to public for the scope.)

The `prepack` script will run `npm run build` again automatically as part of `npm publish` — that is intentional and not a duplicate step the user needs to skip.

Remind the user to verify the published version on the npm registry after publishing, and to spot-check that `npm install @csbc-dev/s3-uploader` from a scratch directory pulls down the published `@wc-bindable/core` and `@wc-bindable/remote` (i.e. the local-path-dependency check actually held).

---

## If something goes wrong after publish

If the user reports a problem after running `npm publish`:

- **Never** suggest `npm unpublish` of a stable version — npm restricts unpublish for packages that have been live more than 72 hours, and even within the window it can break downstream installs.
- Recommend `npm deprecate @csbc-dev/s3-uploader@<bad-version> "<message>"` and then preparing a new patch release through this same skill.
- If the bad version was tagged `latest`, `npm dist-tag` can re-point `latest` at the previous good version — but again, this is run manually by the user.
