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

/**
 * Un parámetro de la URL de la página (id, token) que trae "../" (React Router decodifica %2F) haría que el pedido
 * vaya a otra ruta de la API con la sesión de quien abrió el link: se corta acá, para todas las llamadas.
 */
function assertSafePath(path: string) {
  const p = path.split(/[?#]/)[0];
  // El parser de URL también trata %2e como punto en estos segmentos.
  if (p.split("/").some((raw) => { const seg = raw.replace(/%2e/gi, "."); return seg === ".." || seg === "." || seg.includes("\\") || /%5c/i.test(seg); })) {
    throw new HttpError(400, "invalid_path", "Enlace inválido");
  }
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  assertSafePath(path);
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
  use_portal: { "pt-BR": "As assinaturas do Stripe são canceladas pelo portal de faturamento.", en: "Stripe subscriptions are canceled from the billing portal." },
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
  // Firmante (OTP, firma, descarga)
  otp_cooldown: { "pt-BR": "Aguarde alguns segundos para pedir outro código.", en: "Wait a few seconds before requesting another code." },
  otp_too_many: { "pt-BR": "Foram pedidos códigos demais. Tente mais tarde.", en: "Too many codes requested. Try again later." },
  otp_daily_limit: {
    "pt-BR": "Foram pedidos códigos demais hoje. Tente amanhã ou peça um link novo ao remetente.",
    en: "Too many codes were requested today. Try tomorrow or ask the sender for a new link.",
  },
  otp_expired: { "pt-BR": "O código expirou ou já foi usado. Peça um novo.", en: "The code expired or was already used. Request a new one." },
  otp_locked: { "pt-BR": "Tentativas demais. Peça um código novo.", en: "Too many attempts. Request a new code." },
  otp_delivery_failed: { "pt-BR": "Não foi possível enviar o código. Tente de novo em alguns segundos.", en: "The code couldn't be sent. Try again in a few seconds." },
  otp_required: { "pt-BR": "É preciso validar o código de verificação.", en: "You need to enter the verification code." },
  envelope_closed: { "pt-BR": "O envelope não está mais disponível.", en: "The envelope is no longer available." },
  already_signed: { "pt-BR": "Você já assinou este envelope.", en: "You already signed this envelope." },
  not_signable: { "pt-BR": "Você não pode assinar este envelope.", en: "You can't sign this envelope." },
  not_your_turn: { "pt-BR": "Ainda não é a sua vez de assinar.", en: "It's not your turn to sign yet." },
  consent_required: { "pt-BR": "Primeiro é preciso aceitar o uso de meios eletrônicos.", en: "You first need to accept the use of electronic means." },
  identity_required: { "pt-BR": "É preciso verificar sua identidade para continuar.", en: "You need to verify your identity to continue." },
  fields_invalid: { "pt-BR": "Há campos com valores inválidos.", en: "Some fields have invalid values." },
  invalid_image: { "pt-BR": "A imagem da assinatura não é válida.", en: "The signature image isn't valid." },
  busy: { "pt-BR": "Estamos preparando outras cópias: tente de novo em alguns segundos.", en: "We're preparing other copies: try again in a few seconds." },
  tsa_unavailable: {
    "pt-BR": "A autoridade de carimbo do tempo não respondeu como esperado: tente novamente em alguns minutos.",
    en: "The timestamping authority didn't respond as expected: try again in a few minutes.",
  },
  ai_signer_limit: { "pt-BR": "Você atingiu o máximo de consultas à IA para este documento.", en: "You've reached the maximum number of AI questions for this document." },
  workflow_rate_limited: { "pt-BR": "Muitas execuções deste fluxo: tente mais tarde.", en: "Too many runs of this workflow: try again later." },
  reminded_recently: {
    "pt-BR": "Um lembrete foi enviado há poucos minutos: aguarde um pouco antes de enviar outro.",
    en: "A reminder was sent a few minutes ago: wait a bit before sending another one.",
  },
  version_changed: { "pt-BR": "Há uma versão nova: revise-a e tente de novo.", en: "There's a new version: review it and try again." },
  idempotency_mismatch: {
    "pt-BR": "Os dados mudaram desde a tentativa anterior: recarregue a página e tente de novo.",
    en: "The data changed since the previous attempt: reload the page and try again.",
  },
  idempotency_in_progress: { "pt-BR": "O pedido anterior ainda está em andamento: aguarde alguns segundos.", en: "The previous request is still in progress: wait a few seconds." },
  invalid_path: { "pt-BR": "Link inválido.", en: "Invalid link." },
  invalid_date: { "pt-BR": "Data inválida ou fora do intervalo.", en: "Invalid or out-of-range date." },
  invalid_attachment: {
    "pt-BR": "Só são aceitos PDF, JPG ou PNG que não estejam danificados nem protegidos.",
    en: "Only PDF, JPG or PNG files that aren't damaged or protected are accepted.",
  },
  // Consola de administración (equipo, integraciones, SSO, facturación)
  role_in_use: {
    "pt-BR": "O perfil está atribuído: altere antes esses membros, API keys ou convites.",
    en: "The role is assigned: change those members, API keys or invitations first.",
  },
  last_owner: { "pt-BR": "A organização precisa ter pelo menos um proprietário.", en: "The organization must have at least one owner." },
  member_changed: {
    "pt-BR": "O perfil do membro mudou nesse meio-tempo: recarregue e tente de novo.",
    en: "The member's role changed in the meantime: reload and try again.",
  },
  enable_2fa_first: {
    "pt-BR": "Ative a sua verificação em duas etapas antes de exigi-la da organização.",
    en: "Enable your own two-step verification before requiring it for the organization.",
  },
  too_many_webhooks: { "pt-BR": "Máximo de 20 webhooks por organização.", en: "Maximum of 20 webhooks per organization." },
  role_exists: { "pt-BR": "Já existe um perfil com esse nome.", en: "A role with that name already exists." },
  group_exists: { "pt-BR": "Já existe um grupo com esse nome.", en: "A group with that name already exists." },
  already_member: { "pt-BR": "Essa pessoa já é membro da organização.", en: "That person is already a member of the organization." },
  invalid_member: { "pt-BR": "Algum usuário não é membro da organização.", en: "Some user isn't a member of the organization." },
  byok_key_test_failed: { "pt-BR": "A chave não passou no teste.", en: "The key didn't pass the test." },
  client_secret_required: { "pt-BR": "Falta o client secret do OIDC.", en: "The OIDC client secret is missing." },
  certificate_required: { "pt-BR": "Falta o certificado de assinatura do IdP.", en: "The IdP signing certificate is missing." },
  oidc_discovery_failed: {
    "pt-BR": "Não foi possível ler a configuração do provedor de identidade: verifique o issuer.",
    en: "Couldn't read the identity provider's configuration: check the issuer.",
  },
  already_subscribed: { "pt-BR": "A organização já tem esse plano.", en: "The organization already has that plan." },
  delivery_pending: {
    "pt-BR": "A entrega já está sendo reenviada.",
    en: "The delivery is already being retried.",
  },
  purged: {
    "pt-BR": "Os originais deste envelope foram excluídos pela política de retenção.",
    en: "This envelope's originals were deleted by the retention policy.",
  },
  otp_not_embeddable: {
    "pt-BR": "Um signatário com código OTP não pode ser exibido dentro de um iframe: remova o OTP ou abra o link em uma aba.",
    en: "A signer with an OTP code can't be shown inside an iframe: remove the OTP or open the link in a tab.",
  },
  template_has_forms: {
    "pt-BR": "O modelo tem formulários web ativos: quem os criou ou um administrador precisa desativá-los ou excluí-los antes.",
    en: "The template has active web forms: whoever created them or an admin must deactivate or delete them first.",
  },
  validation_error: { "pt-BR": "Há dados inválidos no pedido.", en: "The request has invalid data." },
  // Editor de sobres y plantillas (envelope_incomplete y logic_order con details.problems se arman en errorText).
  envelope_incomplete: { "pt-BR": "O envelope ainda não pode ser enviado: falta completar dados.", en: "The envelope can't be sent yet: some data is missing." },
  logic_order: {
    "pt-BR": "Um campo depende de outro de quem assina depois ou ao mesmo tempo: mude a ordem ou a lógica.",
    en: "A field depends on a field of someone who signs later or at the same time: change the order or the logic.",
  },
  invalid_field: { "pt-BR": "Há um campo inválido.", en: "A field is invalid." },
  invalid_formula: { "pt-BR": "Há uma fórmula inválida.", en: "A formula is invalid." },
  invalid_condition: { "pt-BR": "Há uma condição inválida.", en: "A condition is invalid." },
  not_draft: { "pt-BR": "O envelope não é mais um rascunho (já foi enviado).", en: "The envelope is no longer a draft (it was already sent)." },
  recipient_is_payer: {
    "pt-BR": "Esse destinatário é responsável pela cobrança: remova ou altere a cobrança antes.",
    en: "That recipient is responsible for the payment: remove or change the payment first.",
  },
  duplicate_roles: { "pt-BR": "Há dois papéis com o mesmo nome.", en: "Two roles have the same name." },
  identity_provider_unavailable: {
    "pt-BR": "O provedor de verificação de identidade não está configurado ou disponível.",
    en: "The identity verification provider isn't configured or available.",
  },
  host_required: { "pt-BR": "A assinatura presencial precisa de um anfitrião.", en: "In-person signing needs a host." },
};

// Encabezado traducido de los errores que traen la lista de problemas (en el texto de la API, en español).
const PROBLEMS_HEADER: Record<string, Record<"es" | "pt-BR" | "en", string>> = {
  envelope_incomplete: { es: "Antes de enviar falta resolver:", "pt-BR": "Antes de enviar, falta resolver:", en: "Before sending, fix the following:" },
  logic_order: {
    es: "La lógica de los campos no respeta el orden de firma:",
    "pt-BR": "A lógica dos campos não respeita a ordem de assinatura:",
    en: "The field logic doesn't follow the signing order:",
  },
};

// Nombres de las funciones de plan (plan_limit) para pt-BR y en.
const FEATURE_TEXT: Record<string, { "pt-BR": string; en: string }> = {
  api: { "pt-BR": "O acesso por API", en: "API access" },
  webhooks: { "pt-BR": "Os webhooks", en: "Webhooks" },
  branding: { "pt-BR": "A marca própria", en: "Custom branding" },
  white_label: { "pt-BR": "A marca branca", en: "White label" },
  payments: { "pt-BR": "A cobrança ao assinar", en: "Payments at signing" },
  bulk_send: { "pt-BR": "O envio em massa", en: "Bulk send" },
  web_forms: { "pt-BR": "Os formulários web", en: "Web forms" },
  kyc: { "pt-BR": "A verificação de identidade", en: "Identity verification" },
  sso: { "pt-BR": "O login único (SSO)", en: "Single sign-on (SSO)" },
  scim: { "pt-BR": "O provisionamento SCIM", en: "SCIM provisioning" },
  custom_domain: { "pt-BR": "O domínio próprio", en: "Custom domain" },
};

/**
 * forbidden y plan_limit traen el porqué en `details` (permiso faltante, permisos de más, función o cupo del plan):
 * en pt-BR y en el texto se arma con eso; sin details, un texto genérico.
 */
function detailText(code: string, details: unknown, loc: "pt-BR" | "en"): string | undefined {
  const d = (details && typeof details === "object" && !Array.isArray(details) ? details : {}) as Record<string, unknown>;
  const en = loc === "en";
  if (code === "forbidden") {
    if (typeof d.permission === "string") return en ? `You don't have the permission ${d.permission}.` : `Você não tem a permissão ${d.permission}.`;
    if (Array.isArray(d.missing) && d.missing.length) {
      const list = d.missing.map(String).join(", ");
      return en ? `It involves permissions you don't have: ${list}.` : `Envolve permissões que você não tem: ${list}.`;
    }
    return en ? "You don't have permission to do this." : "Você não tem permissão para fazer isso.";
  }
  if (code === "plan_limit") {
    const feature = typeof d.feature === "string" ? FEATURE_TEXT[d.feature]?.[loc] ?? d.feature : null;
    if (feature) return en ? `${feature} is not included in your plan. Upgrade it in Billing.` : `${feature}: não incluído no seu plano. Altere-o em Faturamento.`;
    if (d.limit === "envelopes_per_month")
      return en ? "You've reached your plan's monthly envelope limit. Upgrade it in Billing." : "Você atingiu o limite mensal de envelopes do seu plano. Altere-o em Faturamento.";
    if (d.limit === "users") return en ? "You've reached your plan's user limit. Upgrade it in Billing." : "Você atingiu o limite de usuários do seu plano. Altere-o em Faturamento.";
    return en ? "Your plan doesn't include this. Upgrade it in Billing." : "O seu plano não inclui isso. Altere-o em Faturamento.";
  }
  if (code === "validation_error" && Array.isArray(details)) {
    // Los motivos vienen en español; los campos sí sirven en cualquier idioma.
    const paths = [...new Set(details.map((x) => (x && typeof x === "object" ? (x as { path?: unknown }).path : null)).filter((x): x is string => typeof x === "string" && x !== ""))];
    if (paths.length) return (en ? "The request has invalid data: " : "Há dados inválidos no pedido: ") + paths.join(", ");
  }
  return undefined;
}

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
    const missing = (e.details as { missing?: unknown } | undefined)?.missing;
    if (loc !== "es" && e.code === "fields_incomplete") {
      const list = Array.isArray(missing) ? [...new Set(missing.map(String))].join(", ") : "";
      return (loc === "en" ? "Still to complete: " : "Ainda falta preencher: ") + list;
    }
    const problems = (e.details as { problems?: unknown } | undefined)?.problems;
    if (PROBLEMS_HEADER[e.code] && Array.isArray(problems) && problems.length) {
      return `${PROBLEMS_HEADER[e.code][loc] ?? PROBLEMS_HEADER[e.code].es} ${problems.map(String).join(". ")}`;
    }
    const tr = loc !== "es" ? detailText(e.code, e.details, loc) ?? CODE_TEXT[e.code]?.[loc] : undefined;
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
  assertSafePath(path);
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

/**
 * Índice (base 0) del campo al que se refiere un error de la API al guardar los campos: el texto "Campo N" (base 1,
 * invalid_field / invalid_formula / invalid_condition) o la ruta de validación "fields.N" (base 0). null si no cita uno.
 */
export function fieldErrorIndex(e: unknown): number | null {
  if (!(e instanceof HttpError)) return null;
  if (Array.isArray(e.details)) {
    for (const d of e.details) {
      const m = /^fields\.(\d+)(\.|$)/.exec(String((d as { path?: unknown } | null)?.path ?? ""));
      if (m) return Number(m[1]);
    }
  }
  const m = /\bCampo (\d+)\b/.exec(e.message) ?? /\bfields\.(\d+)\b/.exec(e.message);
  if (!m) return null;
  return m[0].startsWith("Campo") ? Number(m[1]) - 1 : Number(m[1]);
}
