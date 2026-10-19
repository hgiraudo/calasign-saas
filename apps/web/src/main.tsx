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
