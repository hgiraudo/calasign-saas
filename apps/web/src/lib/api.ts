// Cliente HTTP mínimo para la API v1 (mismo origen, cookie de sesión).
import type { ApiError } from "@calasign/shared";
import { currentLocale } from "./i18n";

export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const UNAUTHORIZED_EVENT = "calasign:unauthorized";

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** Error de red (no el TypeError del navegador, "Failed to fetch", en inglés en cualquier idioma); un aborto se propaga. */
function networkError(e: unknown): never {
  if ((e as Error).name === "AbortError") throw e;
  throw new HttpError(0, "network_error", "No se pudo conectar con el servidor.");
}

/**
 * Lee el cuerpo de una respuesta: un corte de la conexión a mitad de la descarga (p. ej. un PDF grande en el celular)
 * rechaza con el mismo TypeError del navegador que un fetch fallido, así que se traduce igual.
 */
export function readBody<T>(read: Promise<T>): Promise<T> {
  return read.catch(networkError);
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", ...(opts.headers ?? {}) };
  let body: BodyInit | undefined;
  if (opts.form) {
    body = opts.form;
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? (body ? "POST" : "GET"),
      headers,
      body,
      credentials: "include",
      signal: opts.signal,
    });
  } catch (e) {
    networkError(e);
  }
  if (res.status === 204) return undefined as T;
  const text = await readBody(res.text());
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }
  if (!res.ok) {
    const err = (data as ApiError | undefined)?.error;
    // Un 401 en medio de un flujo puede ser la sesión del remitente que venció o se cerró (p. ej. al activar SSO
    // obligatorio): AuthProvider revisa /v1/me y, si la sesión ya no existe, manda al login. Un 401 de firmante
    // (OTP) no cierra nada porque /v1/me sigue respondiendo.
    if (res.status === 401 && path !== "/v1/me" && typeof window !== "undefined") window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new HttpError(res.status, err?.code ?? `http_${res.status}`, err?.message || res.statusText, err?.details);
  }
  return data as T;
}

// Errores de archivo con código estable que la API describe en español: en pt-BR y en se muestran traducidos (en
// español queda el texto de la API, que puede traer detalle, p. ej. el máximo de páginas).
const CODE_TEXT: Record<string, { "pt-BR": string; en: string }> = {
  network_error: { "pt-BR": "Não foi possível conectar ao servidor.", en: "Couldn't connect to the server." },
  sso_session_2fa: {
    "pt-BR": "Com login único (SSO), o segundo fator é gerenciado pelo provedor de identidade: entre com sua senha para ativá-lo.",
    en: "With single sign-on (SSO), the second factor is managed by your identity provider: sign in with your password to enable it.",
  },
  invalid_code: { "pt-BR": "Código incorreto.", en: "Incorrect code." },
  challenge_expired: { "pt-BR": "O acesso expirou: digite sua senha novamente.", en: "The sign-in expired: enter your password again." },
  too_many_attempts: {
    "pt-BR": "Muitas tentativas. Tente de novo em alguns minutos ou redefina sua senha.",
    en: "Too many attempts. Try again in a few minutes or reset your password.",
  },
  invitation_used: { "pt-BR": "O convite não é mais válido.", en: "The invitation is no longer valid." },
  not_pdf: { "pt-BR": "O arquivo não é um PDF.", en: "The file isn't a PDF." },
  encrypted: { "pt-BR": "O PDF está protegido por senha.", en: "The PDF is password-protected." },
  empty: { "pt-BR": "O PDF não tem páginas.", en: "The PDF has no pages." },
  too_many_pages: { "pt-BR": "O PDF tem páginas demais.", en: "The PDF has too many pages." },
  unreadable: {
    "pt-BR": "Não foi possível ler o PDF: ele está danificado ou é pesado demais.",
    en: "The PDF couldn't be read: it's damaged or too heavy.",
  },
  pdf_too_heavy: { "pt-BR": "O PDF é pesado demais para ler o seu texto.", en: "The PDF is too heavy to read its text." },
  ambiguous_pdf: {
    "pt-BR": "O PDF tem conteúdo ambíguo (mostra coisas diferentes em cada leitor). Gere-o novamente a partir do original.",
    en: "The PDF has ambiguous content (it shows different things in different readers). Export it again from the original.",
  },
  download_failed: { "pt-BR": "Não foi possível baixar o documento.", en: "The document couldn't be downloaded." },
  file_too_large: { "pt-BR": "O arquivo excede o tamanho máximo.", en: "The file exceeds the maximum size." },
  invalid_attachment: {
    "pt-BR": "Só são aceitos PDF, JPG ou PNG que não estejam danificados nem protegidos.",
    en: "Only PDF, JPG or PNG files that aren't damaged or protected are accepted.",
  },
};

/**
 * Texto legible de un error. El mensaje de la API ya trae lo necesario (los errores de validación incluyen ruta y
 * motivo de cada problema); `details` son datos para el código que llama (cupo del plan, espera del OTP, faltantes…):
 * antes se agregaban como JSON crudo ("Esperá 30 s — {"resendInSeconds":30}") y la validación salía repetida.
 */
// Respuesta de error sin cuerpo JSON (p. ej. el 502 del proxy mientras la API se reinicia): con HTTP/2 statusText viene
// vacío, el mensaje quedaba "" y ErrorBox no mostraba nada (la página del firmante quedaba en el spinner para siempre).
const NO_MESSAGE: Record<"es" | "pt-BR" | "en", (status: number) => string> = {
  es: (n) => `El servidor no respondió como se esperaba (HTTP ${n}). Reintentá en unos segundos.`,
  "pt-BR": (n) => `O servidor não respondeu como esperado (HTTP ${n}). Tente novamente em alguns segundos.`,
  en: (n) => `The server didn't respond as expected (HTTP ${n}). Try again in a few seconds.`,
};

export function errorText(e: unknown): string {
  if (e instanceof HttpError) {
    const loc = currentLocale();
    const tr = loc !== "es" ? CODE_TEXT[e.code]?.[loc] : undefined;
    return tr ?? (e.message || (NO_MESSAGE[loc] ?? NO_MESSAGE.es)(e.status));
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

export function uuid(): string {
  const c: Crypto = globalThis.crypto;
  if (typeof c.randomUUID === "function") return c.randomUUID();
  // Fallback (contextos no seguros, p. ej. http://IP): UUID v4 con getRandomValues.
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * fetch para respuestas que no son JSON (PDF) con los mismos errores que api(): sin conexión, network_error (no el
 * TypeError del navegador, "Failed to fetch", en inglés en cualquier idioma); un 401 avisa la sesión vencida (lleva al
 * login en lugar de dejar la pantalla a medias) y un error HTTP es un HttpError con el código y mensaje de la API.
 */
export async function fetchResponse(path: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "include", ...init });
  } catch (e) {
    networkError(e);
  }
  if (!res.ok) {
    if (res.status === 401 && path !== "/v1/me" && typeof window !== "undefined") window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    const err = ((await res.json().catch(() => null)) as ApiError | null)?.error;
    throw new HttpError(res.status, err?.code ?? `http_${res.status}`, err?.message || res.statusText, err?.details);
  }
  return res;
}

export async function fetchArrayBuffer(path: string): Promise<ArrayBuffer> {
  const res = await fetchResponse(path).catch((e: unknown) => {
    // Código propio (no http_N): así se traduce para firmantes en pt-BR o en (antes el texto quedaba en español).
    if (e instanceof HttpError && e.status > 0) throw new HttpError(e.status, "download_failed", "No se pudo descargar el documento.");
    throw e;
  });
  return readBody(res.arrayBuffer());
}
