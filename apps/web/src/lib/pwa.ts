// PWA: registro del service worker y botón "Instalar app".
import { useEffect, useState } from "react";

/** Registra /sw.js solo en producción y fuera de iframes (la firma embebida no instala nada en el sitio del integrador). */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  if (window.self !== window.top) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
  });
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** Devuelve una función para instalar la app cuando el navegador lo permite (si no, null). */
export function useInstallPrompt(): (() => Promise<void>) | null {
  const [evt, setEvt] = useState<BeforeInstallPromptEvent | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      e.preventDefault();
      setEvt(e as BeforeInstallPromptEvent);
    };
    const installed = () => setEvt(null);
    window.addEventListener("beforeinstallprompt", on);
    window.addEventListener("appinstalled", installed);
    return () => {
      window.removeEventListener("beforeinstallprompt", on);
      window.removeEventListener("appinstalled", installed);
    };
  }, []);
  if (!evt) return null;
  return async () => {
    await evt.prompt();
    await evt.userChoice.catch(() => undefined);
    setEvt(null);
  };
}
