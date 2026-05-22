<script setup lang="ts">
import { computed, ref } from "vue";
import { useWcBindable } from "@wc-bindable/vue";
import type { WcsS3, WcsS3Values } from "@csbc-dev/s3-uploader";

// Identical to what you'd write for a local element — useWcBindable does not
// care whether the Core behind <s3-uploader> is local or proxied over
// WebSocket. `binding.ref` is the template ref (used both as the element's
// `:ref` and as the imperative handle); `binding.values` is the live state.
const binding = useWcBindable<WcsS3, WcsS3Values>();
const values = binding.values;

const file = ref<File | null>(null);

const busy = computed(() => !!values.loading || !!values.uploading);
const percent = computed(() => {
  const p = values.progress;
  return p && p.total ? Math.round((p.loaded / p.total) * 100) : 0;
});
const status = computed(() => {
  if (values.error) return "Error";
  if (values.completed) return "Done";
  if (busy.value) return values.progress?.phase ?? "Working";
  return "Ready";
});
const badgeClass = computed(() => ["badge", values.error ? "error" : values.completed ? "done" : ""]);

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

function onPick(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0] ?? null;
  file.value = f;
  // Setting `file` is passive — it just stores the value for the next upload().
  const el = binding.ref.value;
  if (el) {
    el.file = f;
    // Reset Core state when a NEW file is picked. `completed` is a Core-mirrored
    // output: it stays true after a finished upload and is NOT cleared by
    // setting `file`. Without this, the Upload-disabled-when-`completed` guard
    // would stay stuck and block a second file for the rest of the page load.
    // `abort()` at idle is safe — it dispatches no error, just resets completed
    // / url / etag / metadata / progress to the clean state (verified in
    // S3Core.abort()), also clearing the stale result block for the new file.
    el.abort();
  }
}

function onUpload() {
  const el = binding.ref.value;
  // Block once `completed` too — re-pressing would PUT the same file to the
  // same key again.
  if (!el || !file.value || busy.value || values.completed) return;
  // upload() resolves with the download URL; failures surface through the bound
  // `values.error` (rendered below), so we swallow the rejection here.
  el.upload().catch(() => {});
}

function onAbort() {
  binding.ref.value?.abort();
}
</script>

<template>
  <div class="app">
    <div class="hero">
      <h1>Vue — @csbc-dev/s3-uploader</h1>
      <p>
        Remote mode. <code>S3Core</code> signs URLs on the server; the browser
        PUTs straight to S3. <code>useWcBindable</code> binds
        <code>&lt;s3-uploader&gt;</code>.
      </p>
    </div>

    <!-- Headless I/O node — proxies a server-side Core over WebSocket.
         No bucket / credentials: the server owns them.
         multipart-threshold="8388608" (8 MiB) is the package DEFAULT, set
         explicitly here only to mark where you'd tune the single-PUT vs.
         multipart cutover; lower it to force the multipart path for demos. -->
    <s3-uploader :ref="binding.ref" multipart-threshold="8388608" />

    <div class="card">
      <div class="card-head">
        <h2>Upload</h2>
        <span :class="badgeClass">{{ status }}</span>
      </div>

      <div class="body">
        <div class="drop">
          <input type="file" @change="onPick" aria-label="Choose a file to upload" />
          <div v-if="file" class="file-info">
            <strong>{{ file.name }}</strong> · {{ fmtBytes(file.size) }}
          </div>
        </div>

        <div class="controls">
          <button class="btn" :disabled="!file || busy || values.completed" @click="onUpload">Upload</button>
          <button v-if="busy" class="btn ghost" @click="onAbort">Abort</button>
        </div>

        <div v-if="busy" class="progress">
          <div class="bar"><div class="bar-fill" :style="{ width: percent + '%' }" /></div>
          <div class="progress-meta">
            <span>{{ values.progress?.phase }}</span>
            <span>{{ percent }}%</span>
          </div>
        </div>

        <div v-if="values.completed && values.url" class="result">
          <h3>Uploaded ✓</h3>
          <dl>
            <dt>key</dt>
            <dd>{{ values.key }}</dd>
            <dt>etag</dt>
            <dd>{{ values.etag }}</dd>
            <dt>size</dt>
            <dd>{{ values.metadata?.size != null ? fmtBytes(values.metadata.size) : "" }}</dd>
          </dl>
          <p style="margin: 10px 0 0">
            <a :href="values.url" target="_blank" rel="noopener">Open presigned download URL ↗</a>
          </p>
        </div>

        <p v-if="values.error" class="err">{{ errorText(values.error) }}</p>
      </div>
    </div>
  </div>
</template>

<style>
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; font: 14px/1.6 system-ui, "Segoe UI", sans-serif; color: #1a1a2e; background: #f4f5fa; }
.app { width: min(640px, calc(100vw - 32px)); margin: 0 auto; padding: 32px 0 64px; }
.hero h1 { margin: 0 0 4px; font-size: 1.6rem; letter-spacing: -0.02em; }
.hero p { margin: 0 0 20px; color: #5c5c7a; }
.card { background: #fff; border: 1px solid #e3e4ee; border-radius: 16px; box-shadow: 0 12px 36px rgba(26,26,46,.07); overflow: hidden; }
.card-head { display: flex; justify-content: space-between; align-items: center; padding: 14px 18px; border-bottom: 1px solid #eef0f6; }
.card-head h2 { margin: 0; font-size: .95rem; }
.badge { padding: 3px 10px; border-radius: 999px; background: #eef0ff; color: #4f46e5; font-size: .78rem; font-weight: 600; text-transform: capitalize; }
.badge.done { background: #ecfdf5; color: #059669; }
.badge.error { background: #fef2f2; color: #dc2626; }
.body { padding: 18px; display: flex; flex-direction: column; gap: 16px; }
.drop { border: 1.5px dashed #c7c9da; border-radius: 12px; padding: 22px; text-align: center; background: #fafbff; }
.drop input[type=file] { font: inherit; max-width: 100%; }
.file-info { margin-top: 10px; font-size: .85rem; color: #5c5c7a; }
.file-info strong { color: #1a1a2e; }
.controls { display: flex; gap: 8px; }
.btn { border: 0; background: #6366f1; color: #fff; border-radius: 10px; padding: 10px 18px; font: inherit; font-weight: 600; cursor: pointer; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn.ghost { background: #eef0f6; color: #1a1a2e; }
.progress { display: flex; flex-direction: column; gap: 6px; }
.bar { height: 10px; border-radius: 999px; background: #eef0f6; overflow: hidden; }
.bar-fill { height: 100%; width: 0; background: #6366f1; transition: width .15s ease; }
.progress-meta { display: flex; justify-content: space-between; font-size: .78rem; color: #5c5c7a; text-transform: capitalize; }
.result { border: 1px solid #d1fae5; background: #f0fdf9; border-radius: 12px; padding: 14px; font-size: .85rem; }
.result h3 { margin: 0 0 8px; font-size: .9rem; color: #059669; }
.result dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 0; }
.result dt { color: #5c5c7a; }
.result dd { margin: 0; word-break: break-all; }
.result a { color: #4f46e5; font-weight: 600; }
.err { margin: 0; padding: 10px 14px; border-radius: 12px; background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; font-size: .85rem; word-break: break-word; }
</style>
