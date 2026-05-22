import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [
    vue({
      template: {
        // Treat <s3-uploader> / <s3-callback> as native custom elements so Vue
        // does not try to resolve them as Vue components.
        compilerOptions: {
          isCustomElement: (tag) => tag === "s3-uploader" || tag === "s3-callback",
        },
      },
    }),
  ],
  server: { port: 5175 },
});
