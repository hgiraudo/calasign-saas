import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@fontsource/dancing-script/400.css";
import "./styles.css";
import "./styles-productivity.css";
import "./styles-experience.css";
import { registerServiceWorker } from "./lib/pwa";
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
