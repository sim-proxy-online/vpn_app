import path from "path";
import fs from "node:fs";
import { fileURLToPath } from "url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const androidAssets = path.resolve(__dirname, "android/app/src/main/assets");

// Plugin: after build, copy index.html directly into Android assets so
// the Gradle build always picks up the latest frontend without a manual copy.
function copyToAndroidAssets() {
  return {
    name: "copy-to-android-assets",
    closeBundle() {
      const src = path.resolve(__dirname, "dist/index.html");
      const dest = path.join(androidAssets, "index.html");
      if (fs.existsSync(src)) {
        fs.mkdirSync(androidAssets, { recursive: true });
        fs.copyFileSync(src, dest);
        console.log(`[copy-to-android-assets] ${dest}`);
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  base: "./",
  plugins: [react(), viteSingleFile(), copyToAndroidAssets()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
