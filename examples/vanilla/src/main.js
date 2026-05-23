// Vanilla example — remote mode.
//
// bootstrapS3() applies the remote config and *then* registers the custom
// elements, so the <s3-uploader> in index.html upgrades straight into remote
// mode — it opens a WebSocket to the server-side Core instead of needing a
// local one (which would mean AWS credentials in the browser). bind() then
// subscribes to the proxied element exactly as it would to a local one.
import { bootstrapS3 } from "@csbc-dev/s3-uploader";
import { bind } from "@wc-bindable/core";

const env = import.meta.env;
const remoteUrl = env.VITE_S3_REMOTE_URL || "ws://localhost:8080/s3-uploader";

bootstrapS3({
  remote: {
    enableRemote: true,
    remoteSettingType: "config",
    remoteCoreUrl: remoteUrl,
  },
});

// --- helpers ---------------------------------------------------------------

function pct(p) {
  return p && p.total ? Math.round((p.loaded / p.total) * 100) : 0;
}

function fmtBytes(n) {
  if (n == null || Number.isNaN(n)) return "";
  if (n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// `error` is `WcsS3AnyError` = S3Error | Error | SerializedError | null. Every
// non-null shape carries a `message`; fall back to String() otherwise.
// Kept logically identical across all four clients (vanilla/react/vue/wcstack).
function errorText(err) {
  if (!err) return "";
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    const m = err.message;
    if (m) return String(m);
  }
  return String(err);
}

// --- elements --------------------------------------------------------------

const s3 = document.getElementById("s3");
const picker = document.getElementById("picker");
const uploadBtn = document.getElementById("upload");
const abortBtn = document.getElementById("abort");
const fileInfo = document.getElementById("fileInfo");
const statusEl = document.getElementById("status");
const progressEl = document.getElementById("progress");
const barFill = document.getElementById("barFill");
const phaseEl = document.getElementById("phase");
const pctEl = document.getElementById("pct");
const resultEl = document.getElementById("result");
const rKey = document.getElementById("rKey");
const rEtag = document.getElementById("rEtag");
const rSize = document.getElementById("rSize");
const rUrl = document.getElementById("rUrl");
const errorEl = document.getElementById("error");

// Mirror of <s3-uploader>'s reactive state, kept in sync by bind(). In remote
// mode these values are synced from the server-side Core over WebSocket — the
// binding code is identical to what it would be for a local element.
const state = {
  progress: { loaded: 0, total: 0, phase: "idle" },
  loading: false,
  uploading: false,
  completed: false,
  url: "",
  key: "",
  etag: "",
  metadata: null,
  error: null,
};

bind(s3, (name, value) => {
  if (name in state) state[name] = value;
  render();
});

// --- the two imperative gestures ------------------------------------------

picker.addEventListener("change", () => {
  const f = picker.files && picker.files[0];
  // Setting `file` is passive — it just stores the value for the next upload().
  s3.file = f || null;
  // Reset Core state when a NEW file is picked. `completed` is a Core-mirrored
  // output: it stays true after a finished upload and is NOT cleared by setting
  // `file`. Without this reset, the Upload-disabled-when-`completed` guard would
  // stay stuck and block uploading a second file for the rest of the page load.
  // `abort()` at idle is safe — it dispatches no error, just resets completed /
  // url / etag / metadata / progress back to the clean state (verified in
  // S3Core.abort()). It also clears the stale result block for the new file.
  s3.abort();
  fileInfo.hidden = !f;
  if (f) {
    // Build with the DOM API (not innerHTML) so a crafted file name cannot
    // inject markup. Keeps this client's escaping identical to the react / vue /
    // wcstack clients, which all render the name as text.
    fileInfo.textContent = "";
    const strong = document.createElement("strong");
    strong.textContent = f.name;
    fileInfo.append(strong, ` · ${fmtBytes(f.size)}`);
  }
  render();
});

uploadBtn.addEventListener("click", () => {
  // Guard at the handler too (not just the disabled button) so this matches
  // the busy check the react / vue / wcstack clients all do. Also block once
  // `completed` — re-pressing would PUT the same file to the same key again.
  const busy = state.loading || state.uploading;
  if (!s3.file || busy || state.completed) return;
  // upload() is the recommended imperative entry. It resolves with the final
  // download URL; failures surface through `s3-uploader:error` (observed via
  // bind), so we swallow the rejection here.
  s3.upload().catch(() => {});
});

abortBtn.addEventListener("click", () => s3.abort());

// --- render ----------------------------------------------------------------

function render() {
  const busy = state.loading || state.uploading;
  const p = state.progress || { loaded: 0, total: 0, phase: "idle" };

  statusEl.classList.remove("done", "error");
  if (state.error) {
    statusEl.textContent = "Error";
    statusEl.classList.add("error");
  } else if (state.completed) {
    statusEl.textContent = "Done";
    statusEl.classList.add("done");
  } else if (busy) {
    statusEl.textContent = p.phase || "Working";
  } else {
    statusEl.textContent = "Ready";
  }

  // Disable once `completed` so the same file is not re-PUT to the same key.
  uploadBtn.disabled = !s3.file || busy || state.completed;
  abortBtn.hidden = !busy;

  progressEl.hidden = !busy;
  const percent = pct(p);
  barFill.style.width = `${percent}%`;
  phaseEl.textContent = p.phase || "";
  pctEl.textContent = `${percent}%`;

  const showResult = state.completed && !!state.url;
  resultEl.hidden = !showResult;
  if (showResult) {
    rKey.textContent = state.key || "";
    rEtag.textContent = state.etag || "";
    rSize.textContent =
      state.metadata && state.metadata.size != null ? fmtBytes(state.metadata.size) : "";
    rUrl.href = state.url;
  }

  errorEl.hidden = !state.error;
  errorEl.textContent = errorText(state.error);
}
