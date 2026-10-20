// Descargas CSV de la consola: separador según el idioma y descarga con fetch (errores como mensaje, no JSON crudo).
import { fetchResponse, readBody } from "./api";

/** Zona horaria del navegador (IANA); null si no se puede saber. */
export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/**
 * Parámetros de formato del CSV: ";" en español y portugués (Excel en esos idiomas usa la coma como separador
 * decimal y con "," abría todo en una sola columna) y, si se pide, la zona horaria para las columnas *_local.
 */
export function csvFormatParams(locale: string, opts: { tz?: boolean } = {}): URLSearchParams {
  const q = new URLSearchParams();
  q.set("sep", /^(es|pt)/i.test(locale) ? ";" : ",");
  const tz = opts.tz ? browserTimeZone() : null;
  if (tz) q.set("tz", tz);
  return q;
}

/** Nombre del archivo del header Content-Disposition (o el de respaldo). */
function fileNameOf(res: Response, fallback: string): string {
  const cd = res.headers.get("content-disposition") ?? "";
  const m = /filename\*=UTF-8''([^;]+)/i.exec(cd) ?? /filename="?([^";]+)"?/i.exec(cd);
  if (!m) return fallback;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/**
 * Descarga un CSV de la API con fetch: un error (sin permiso, rango inválido, sesión vencida) lanza un HttpError que
 * la página muestra traducido. Con un <a href>, el navegador abría el JSON del error como si fuera el archivo.
 * Devuelve si la exportación se cortó (header X-Truncated).
 */
export async function downloadCsv(path: string, fallbackName: string): Promise<{ truncated: boolean }> {
  const res = await fetchResponse(path);
  const blob = await readBody(res.blob());
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileNameOf(res, fallbackName);
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { truncated: res.headers.get("x-truncated") === "true" };
}
