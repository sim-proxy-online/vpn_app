// Подставляется Vite/Vitest (опция define) из package.json — см. vite.config.ts.
declare const __APP_VERSION__: string;

// Картинки из src/assets подключаются через Vite (vite-plugin-singlefile вшивает их в index.html).
declare module '*.png' {
  const src: string;
  export default src;
}
