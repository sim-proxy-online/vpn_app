import path from "path";
import fs from "node:fs";
import { fileURLToPath } from "url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const androidAssets = path.resolve(__dirname, "android/app/src/main/assets");

// Единый источник версии — package.json (его же читает android/app/build.gradle).
// Раньше версия была вручную продублирована в UpdateChecker.ts и build.gradle.
const appVersion: string = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "package.json"), "utf8"),
).version;

// Plugin: после сборки копирует ВЕСЬ dist (index.html, flags/, fonts/, иконку, manifest.json,
// sw.js) в Android assets, чтобы Gradle всегда брал свежий фронтенд без ручного `cap copy`.
// Раньше копировался только index.html: флаги серверов и шрифты пропадали из приложения.
// Файлы, которых нет в dist (geoip.dat, geosite.dat), не трогаем.
function copyToAndroidAssets() {
  return {
    name: "copy-to-android-assets",
    closeBundle() {
      const distDir = path.resolve(__dirname, "dist");
      if (!fs.existsSync(path.join(distDir, "index.html"))) return;
      fs.mkdirSync(androidAssets, { recursive: true });
      fs.cpSync(distDir, androidAssets, { recursive: true, force: true });
      console.log(`[copy-to-android-assets] dist -> ${androidAssets}`);
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  base: "./",
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  plugins: [react(), viteSingleFile(), copyToAndroidAssets()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
