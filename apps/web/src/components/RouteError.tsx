// Pantalla de error del router (errorElement): sin esto, un error de render mostraba la pantalla por defecto de React
// Router con la traza. Neutra (sin marca ni contexto de sesión/idioma, que podrían ser lo que falló): sirve también en
// las páginas públicas de firma.
import { useEffect } from "react";
import { useRouteError } from "react-router-dom";

const TEXT = {
  es: { title: "Algo salió mal", body: "Ocurrió un error inesperado al mostrar esta página.", reload: "Recargar" },
  en: { title: "Something went wrong", body: "An unexpected error occurred while showing this page.", reload: "Reload" },
  "pt-BR": { title: "Algo deu errado", body: "Ocorreu um erro inesperado ao exibir esta página.", reload: "Recarregar" },
} as const;

// Mismo criterio que lib/i18n.tsx (idioma guardado, si no el del navegador), sin depender de ese módulo ni del contexto.
function safeLocale(): keyof typeof TEXT {
  let v: string | null = null;
  try {
    v = window.localStorage.getItem("calasign.locale");
  } catch {
    // Sin almacenamiento: se usa el idioma del navegador.
  }
  if (v === "es" || v === "en" || v === "pt-BR") return v;
  const nav = (typeof navigator !== "undefined" && navigator.language ? navigator.language : "es").toLowerCase();
  if (nav.startsWith("pt")) return "pt-BR";
  if (nav.startsWith("en")) return "en";
  return "es";
}

export function RouteError() {
  const error = useRouteError();
  useEffect(() => {
    // La traza va solo a la consola (para soporte), nunca a la pantalla.
    console.error(error);
  }, [error]);
  const t = TEXT[safeLocale()];
  return (
    <main role="alert" style={{ maxWidth: 480, margin: "15vh auto 0", padding: "0 16px", textAlign: "center", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: 8 }}>{t.title}</h1>
      <p style={{ color: "#475569", marginBottom: 20 }}>{t.body}</p>
      <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
        {t.reload}
      </button>
    </main>
  );
}
