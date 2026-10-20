import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@fontsource/dancing-script/400.css";
import "./styles.css";
import "./styles-productivity.css";
import "./styles-experience.css";
import { registerServiceWorker } from "./lib/pwa";
// Marca blanca: lee el tema que el servidor inyectó en index.html y lo aplica antes del primer render.
import "./lib/white-label";
import "./styles-scale.css";
import "./styles-identity.css";
import "./styles-evidence.css";
import "./styles-billing.css";
import "./styles-ai.css";
import "./styles-agreements.css";
import "./styles-data.css";
import "./styles-certsign.css";
import { App } from "./App";
import { I18nProvider } from "./lib/i18n";
import { AuthProvider } from "./lib/auth";

registerServiceWorker();

// Una pestaña abierta antes de un deploy pide un trozo de la app (lazy) que ya no existe: sin esto quedaba en blanco.
// Se recarga una sola vez por minuto (si el error persiste no entra en un bucle).
let reloading = false;
window.addEventListener("vite:preloadError", (ev) => {
  // Varias dependencias pueden fallar a la vez: una sola recarga (y sin mostrar el error mientras tanto).
  if (reloading) {
    ev.preventDefault();
    return;
  }
  try {
    const last = Number(window.sessionStorage.getItem("cs-reload-after-deploy") ?? 0);
    if (Date.now() - last < 60_000) return;
    window.sessionStorage.setItem("cs-reload-after-deploy", String(Date.now()));
  } catch {
    // Sin almacenamiento (p. ej. iframe con datos bloqueados) no hay cómo evitar un bucle: no se recarga.
    return;
  }
  reloading = true;
  ev.preventDefault();
  window.location.reload();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <I18nProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </I18nProvider>
    </BrowserRouter>
  </StrictMode>,
);
