import { createApp } from "vue";
import { bootstrapS3 } from "@csbc-dev/s3-uploader";
import App from "./App.vue";

const remoteUrl = import.meta.env.VITE_S3_REMOTE_URL || "ws://localhost:8080/s3-uploader";

// Enable remote mode before the custom elements are registered. bootstrapS3()
// applies the config and *then* runs customElements.define, so every
// <s3-uploader> upgrades straight into remote mode (opens a WebSocket to the
// server-side Core instead of needing local AWS credentials).
bootstrapS3({
  remote: {
    enableRemote: true,
    remoteSettingType: "config",
    remoteCoreUrl: remoteUrl,
  },
});

createApp(App).mount("#app");
