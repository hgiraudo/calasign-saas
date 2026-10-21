import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
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
import { I18nProvider, UnsavedChangesGuard } from "./lib/i18n";
import { AuthProvider } from "./lib/auth";
import { RouteError } from "./components/RouteError";
import { reloadAfterDeploy } from "./lib/deploy-reload";

registerServiceWorker();

// Una pestaña abierta antes de un deploy pide un trozo de la app (lazy) que ya no existe: sin esto quedaba en blanco.
// Se recarga una sola vez por minuto (lib/deploy-reload; si el error persiste se muestra RouteError).
window.addEventListener("vite:preloadError", (ev) => {
  // Varias dependencias pueden fallar a la vez: una sola recarga (y sin mostrar el error mientras tanto).
  if (reloadAfterDeploy()) ev.preventDefault();
});

// Router "de datos" (createBrowserRouter) en lugar de BrowserRouter: es el único que permite bloquear la navegación
// (useBlocker), así el botón Atrás y las navegaciones por código también avisan de cambios sin guardar. Todas las
// rutas siguen declaradas con <Routes> dentro de App (una sola ruta comodín acá).
const router = createBrowserRouter([
  {
    path: "*",
    element: (
      <I18nProvider>
        <AuthProvider>
          <UnsavedChangesGuard />
          <App />
        </AuthProvider>
      </I18nProvider>
    ),
    // Un error de render en cualquier página: pantalla neutra con "Recargar" en lugar de la traza del router.
    errorElement: <RouteError />,
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
