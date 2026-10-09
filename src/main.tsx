import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { ThemeProvider } from "./ThemeContext";
import { I18nProvider } from "./i18n";
import { ErrorBoundary } from "./components/ErrorBoundary";

// Ошибки вне React (таймеры, промисы без catch, нативные колбэки) раньше пропадали
// бесследно. Складываем их в небольшой кольцевой буфер window.__simErrors — его можно
// посмотреть из консоли/отладки — и пишем в console.error. Поведение страницы не меняем.
const MAX_ERRORS = 50;
function recordError(kind: string, err: unknown) {
  const msg = err instanceof Error ? (err.stack || err.message) : String(err);
  console.error(`[${kind}]`, err);
  const w = window as any;
  const list: Array<{ t: number; kind: string; msg: string }> = (w.__simErrors ||= []);
  list.push({ t: Date.now(), kind, msg: msg.slice(0, 2000) });
  if (list.length > MAX_ERRORS) list.shift();
}
window.addEventListener("error", (e) => recordError("window.onerror", e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => recordError("unhandledrejection", e.reason));

// Внешняя граница: без неё ошибка в провайдерах темы/языка или в самом App
// (границы внутри App защищают только отдельные экраны) давала белый экран.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <I18nProvider>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </I18nProvider>
    </ErrorBoundary>
  </StrictMode>
);
