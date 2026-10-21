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
/**
 * Un 403 forbidden de la consola: los permisos de la sesión pueden haber cambiado (otro administrador le cambió el rol
 * o recortó los permisos del rol). AccessProvider vuelve a pedir /v1/me/access para que la consola deje de ofrecer lo
 * que ya no puede hacer.
 */
export const FORBIDDEN_EVENT = "calasign:forbidden";

function signalAuthErrors(res: Response, path: string, code: string | undefined) {
  if (typeof window === "undefined") return;
  if (res.status === 401 && path !== "/v1/me") window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  if (res.status === 403 && code === "forbidden" && !path.startsWith("/v1/me/access")) window.dispatchEvent(new Event(FORBIDDEN_EVENT));
}

/** El recurso cambió desde que se cargó (otra pestaña u otra persona): 409 version_changed de X-Expected-Updated-At. */
export function isVersionChanged(e: unknown): boolean {
  return e instanceof HttpError && e.code === "version_changed";
}

/**
 * Guardado de un panel que también cambia el updatedAt del sobre o la plantilla abiertos en un editor (sello, asistencia
 * de IA, visibilidad): el editor le pasa su X-Expected-Updated-At, queda ocupado hasta que termina y adopta el updatedAt
 * que devuelve la API (si otro lo cambió antes, la API responde 409 version_changed y el editor lo avisa). Antes se
 * volvía a leer el sobre sin esperar: se adoptaba la versión de otro sin sus datos y un guardado inmediato daba 409.
 */
export type VersionedSave = <T>(
  save: (headers: Record<string, string> | undefined) => Promise<T>,
  updatedAtOf: (r: T) => string | null | undefined,
) => Promise<T>;

/** Corre `save` con el control de versión del editor si lo hay (fuera de un editor, sin encabezado). */
export function runVersioned<T>(versioned: VersionedSave | undefined, save: (headers: Record<string, string> | undefined) => Promise<T>, updatedAtOf: (r: T) => string | null | undefined): Promise<T> {
  return versioned ? versioned(save, updatedAtOf) : save(undefined);
}

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
    signalAuthErrors(res, path, err?.code);
    throw new HttpError(res.status, err?.code ?? `http_${res.status}`, err?.message || res.statusText, err?.details);
  }
  return data as T;
}

// Errores de archivo con código estable que la API describe en español: en pt-BR y en se muestran traducidos (en
// español queda el texto de la API, que puede traer detalle, p. ej. el máximo de páginas).
const CODE_TEXT: Record<string, { "pt-BR": string; en: string }> = {
  network_error: { "pt-BR": "Não foi possível conectar ao servidor.", en: "Couldn't connect to the server." },
  provider_test_limit: {
    "pt-BR": "Muitos testes de conectores de assinatura na última hora: tente mais tarde.",
    en: "Too many signature connector tests in the last hour: try again later.",
  },
  provider_test_in_progress: {
    "pt-BR": "Já há um teste de conector em andamento na sua organização: aguarde até que termine.",
    en: "A connector test is already running in your organization: wait for it to finish.",
  },
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
  pdf_restricted: {
    "pt-BR": "O PDF tem restrições de uso (permissões): exporte-o novamente ou imprima-o como PDF e envie de novo.",
    en: "The PDF has usage restrictions (permissions): export it again or print it to PDF and upload it again.",
  },
  pdf_hidden_layers: {
    "pt-BR": "O PDF tem camadas ocultas (conteúdo opcional desativado): exporte-o novamente sem camadas ou imprima-o como PDF e envie de novo.",
    en: "The PDF has hidden layers (optional content turned off): export it again without layers or print it to PDF and upload it again.",
  },
  pdf_form_unsupported: {
    "pt-BR": "O PDF tem um formulário cujos campos não podem ser fixados como aparecem: imprima-o como PDF e envie de novo.",
    en: "The PDF has a form whose fields can't be fixed as they appear: print it to PDF and upload it again.",
  },
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
  otp_destination_limit: { "pt-BR": "Foram enviados códigos demais para este destino. Tente mais tarde.", en: "Too many codes were sent to this destination. Try again later." },
  otp_destination_suppressed: {
    "pt-BR": "Não podemos enviar e-mails para esse endereço: ele marcou como indesejado um e-mail desta organização. Peça ao remetente que o habilite de novo ou que mude o contato.",
    en: "We can't send emails to that address: it marked an email from this organization as spam. Ask the sender to re-enable it or change the contact.",
  },
  otp_tenant_limit: { "pt-BR": "Foram enviados códigos demais por esta organização. Tente mais tarde.", en: "Too many codes were sent by this organization. Try again later." },
  unverified_recipient: {
    "pt-BR": "Esse destinatário se registrou em um formulário web sem validar o e-mail: não recebe cópias (pode baixá-la pelo link dele).",
    en: "That recipient signed up through a web form without verifying their email: copies aren't sent to them (they can download it from their link).",
  },
  nothing_to_retry: {
    "pt-BR": "Não há linhas para tentar novamente (as que têm erros nos dados são corrigidas em um envio novo).",
    en: "There are no rows to retry (rows with data errors must be fixed in a new send).",
  },
  not_retryable: { "pt-BR": "O envio em massa foi cancelado.", en: "The bulk send was canceled." },
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
  ai_notice_required: {
    "pt-BR": "A organização precisa aceitar o aviso de tratamento de dados vigente da IA (Configurações → Inteligência artificial).",
    en: "The organization must accept the current AI data processing notice (Settings → Artificial intelligence).",
  },
  ai_unavailable: { "pt-BR": "A IA não está disponível no momento.", en: "AI isn't available right now." },
  ai_timeout: { "pt-BR": "O provedor de IA não respondeu a tempo: tente mais tarde.", en: "The AI provider didn't respond in time: try again later." },
  ai_budget_exceeded: { "pt-BR": "O orçamento mensal de IA da organização acabou.", en: "The organization's monthly AI budget has been used up." },
  workflow_rate_limited: { "pt-BR": "Muitas execuções deste fluxo: tente mais tarde.", en: "Too many runs of this workflow: try again later." },
  reminded_recently: {
    "pt-BR": "Um lembrete foi enviado há poucos minutos: aguarde um pouco antes de enviar outro.",
    en: "A reminder was sent a few minutes ago: wait a bit before sending another one.",
  },
  version_changed: { "pt-BR": "Há uma versão nova: revise-a e tente de novo.", en: "There's a new version: review it and try again." },
  // Negociaciones, workflows y formularios públicos (en español se muestra el texto de la API).
  closed: { "pt-BR": "A negociação já está encerrada.", en: "The negotiation is already closed." },
  too_many_comments: { "pt-BR": "Foi atingido o limite de comentários desta negociação.", en: "The comment limit for this negotiation has been reached." },
  too_many_proposals: { "pt-BR": "Você tem propostas demais sem decisão: aguarde até que sejam revisadas.", en: "You have too many undecided proposals: wait until they're reviewed." },
  pdf_source: { "pt-BR": "Um PDF enviado não é editado: nele só é possível comentar.", en: "An uploaded PDF can't be edited: it can only be commented on." },
  no_change: { "pt-BR": "O valor proposto é igual ao atual.", en: "The proposed value is the same as the current one." },
  template_syntax: { "pt-BR": "O texto tem um erro de sintaxe nas marcações {{ }}.", en: "The text has a syntax error in its {{ }} tags." },
  not_waiting: { "pt-BR": "Isto já não está aguardando uma resposta: já foi concluído.", en: "This is no longer waiting for a response: it was already completed." },
  workflow_inactive: { "pt-BR": "Este formulário não está mais disponível.", en: "This form is no longer available." },
  form_inactive: { "pt-BR": "Este formulário não está mais disponível.", en: "This form is no longer available." },
  form_expired: { "pt-BR": "Este formulário não está mais disponível.", en: "This form is no longer available." },
  form_exhausted: { "pt-BR": "Este formulário não está mais disponível.", en: "This form is no longer available." },
  form_unavailable: { "pt-BR": "Este formulário não está mais disponível.", en: "This form is no longer available." },
  form_misconfigured: { "pt-BR": "Este formulário não está disponível.", en: "This form is not available." },
  form_rate_limited: { "pt-BR": "Envios demais deste formulário: tente mais tarde.", en: "Too many submissions for this form: try again later." },
  form_recent_submission: {
    "pt-BR": "Já recebemos um envio igual há poucos minutos: verifique a aba onde você preencheu o formulário ou tente mais tarde.",
    en: "We already received an identical submission a few minutes ago: check the tab where you filled in the form or try again later.",
  },
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
  clause_in_use: {
    "pt-BR": "A cláusula é usada em modelos de documentos ou em outras cláusulas: remova essas citações antes de excluí-la.",
    en: "The clause is used in document templates or other clauses: remove those references before deleting it.",
  },
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
  sso_required: {
    "pt-BR": "Sua organização exige entrar com login único (SSO).",
    en: "Your organization requires signing in with single sign-on (SSO).",
  },
  sso_reauth_required: {
    "pt-BR": "Esta sessão de login único é de outra organização: entre novamente.",
    en: "This single sign-on session belongs to another organization: sign in again.",
  },
  email_taken: { "pt-BR": "Já existe uma conta com esse e-mail.", en: "An account with that email already exists." },
  account_required: { "pt-BR": "Para aceitar, entre com sua conta.", en: "To accept, sign in with your account." },
  two_factor_setup_required: {
    "pt-BR": "Sua organização exige a verificação em duas etapas: ative-a em Configurações → Segurança.",
    en: "Your organization requires two-step verification: turn it on in Settings → Security.",
  },
  invalid_scope: { "pt-BR": "O aplicativo pediu permissões inválidas.", en: "The app requested invalid permissions." },
  invalid_redirect_uri: { "pt-BR": "O endereço de retorno do aplicativo não é permitido.", en: "The app's redirect address isn't allowed." },
  invalid_client: { "pt-BR": "O aplicativo não existe ou foi revogado.", en: "The app doesn't exist or was revoked." },
  delivery_pending: {
    "pt-BR": "A entrega já está sendo reenviada.",
    en: "The delivery is already being retried.",
  },
  endpoint_inactive: {
    "pt-BR": "O webhook está desativado: reative-o para reenviar a entrega.",
    en: "The webhook is disabled: turn it back on to retry the delivery.",
  },
  purged: {
    "pt-BR": "Os originais deste envelope foram excluídos pela política de retenção.",
    en: "This envelope's originals were deleted by the retention policy.",
  },
  not_embedded: {
    "pt-BR": "O destinatário não é incorporado e não tem outra autenticação: crie-o com embedded: true ou exija um código (OTP).",
    en: "The recipient isn't embedded and has no other authentication: create it with embedded: true or require a code (OTP).",
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
  // Editor de sobres y plantillas (envelope_incomplete y logic_order con details.issues se arman en errorText).
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
  provider_unavailable: {
    "pt-BR": "O meio de cobrança não está disponível no momento: tente novamente em alguns minutos.",
    en: "The payment provider isn't available right now: try again in a few minutes.",
  },
  provider_misconfigured: {
    "pt-BR": "O Mercado Pago não está bem configurado na plataforma (o país da conta não é reconhecido): escolha outro meio de pagamento ou fale com o suporte.",
    en: "Mercado Pago isn't set up correctly on the platform (the account's country isn't recognized): choose another payment method or contact support.",
  },
  identity_provider_unavailable: {
    "pt-BR": "O provedor de verificação de identidade não está configurado ou disponível.",
    en: "The identity verification provider isn't configured or available.",
  },
  host_required: { "pt-BR": "A assinatura presencial precisa de um anfitrião.", en: "In-person signing needs a host." },
  // Flujos del remitente (sobres, plantillas, envío masivo, CRM y conectores).
  not_found: { "pt-BR": "Não encontrado: pode ter sido excluído ou você não tem acesso.", en: "Not found: it may have been deleted or you don't have access." },
  not_voidable: { "pt-BR": "Só é possível anular um envelope enviado e em andamento.", en: "Only a sent, in-progress envelope can be voided." },
  not_in_progress: { "pt-BR": "O envelope não está em andamento.", en: "The envelope isn't in progress." },
  template_empty: { "pt-BR": "O modelo não tem documentos.", en: "The template has no documents." },
  reminder_daily_limit: {
    "pt-BR": "Já foram enviados todos os lembretes permitidos nas últimas 24 horas: tente amanhã.",
    en: "All the reminders allowed in the last 24 hours were already sent: try tomorrow.",
  },
  finalize_in_progress: { "pt-BR": "A finalização já está em andamento.", en: "Finalization is already in progress." },
  duplicate_recipient: { "pt-BR": "Um destinatário aparece mais de uma vez.", en: "A recipient appears more than once." },
  too_many_fields: { "pt-BR": "O envelope tem campos demais.", en: "The envelope has too many fields." },
  too_many_documents: { "pt-BR": "Há documentos demais.", en: "Too many documents." },
  weak_password: { "pt-BR": "A senha precisa ter pelo menos 10 caracteres.", en: "The password must be at least 10 characters long." },
  invalid_csv: { "pt-BR": "O CSV tem erros: revise as colunas e o formato.", en: "The CSV has errors: check the columns and the format." },
  duplicate_ids: { "pt-BR": "Há IDs de destinatários repetidos.", en: "Some recipient IDs are repeated." },
  id_in_use: { "pt-BR": "O ID do destinatário já está em uso.", en: "The recipient ID is already in use." },
  crm_account_unknown: {
    "pt-BR": "A conexão do CRM não tem a conta salva: teste-a ou conecte-a de novo.",
    en: "The CRM connection doesn't have its account saved: test it or connect it again.",
  },
  company_mismatch: {
    "pt-BR": "O mapeamento é de outra conta do CRM, não daquela de onde se envia.",
    en: "The mapping belongs to another CRM account, not the one you're sending from.",
  },
  crm_trigger_loop: {
    "pt-BR": "A propriedade que dispara o envio não pode ser a mesma em que se escreve o status.",
    en: "The property that triggers sending can't be the same one the status is written to.",
  },
  connector_connection_inactive: { "pt-BR": "A conexão está desativada.", en: "The connection is deactivated." },
  connector_flow_inactive: { "pt-BR": "O fluxo está desativado.", en: "The flow is deactivated." },
  connector_template_required: { "pt-BR": "O fluxo não tem modelo (foi excluído?).", en: "The flow has no template (was it deleted?)." },
  connector_reauth_required: { "pt-BR": "A conexão perdeu o acesso: conecte-a de novo.", en: "The connection lost access: connect it again." },
  connector_record_not_found: { "pt-BR": "O registro não existe no sistema de origem.", en: "The record doesn't exist in the source system." },
  connector_invalid: { "pt-BR": "O sistema de origem rejeitou o pedido.", en: "The source system rejected the request." },
  connector_invalid_record: { "pt-BR": "O registro tem dados que não servem para o envelope.", en: "The record has data that can't be used for the envelope." },
  connector_invalid_document: { "pt-BR": "O documento do sistema de origem não é um PDF válido.", en: "The source system's document isn't a valid PDF." },
  connector_provider_error: { "pt-BR": "O sistema de origem respondeu com um erro: tente mais tarde.", en: "The source system returned an error: try again later." },
  connector_test_failed: { "pt-BR": "Não foi possível conectar: revise as credenciais.", en: "Couldn't connect: check the credentials." },
  connector_credentials: { "pt-BR": "As credenciais estão incompletas ou são inválidas.", en: "The credentials are incomplete or invalid." },
  connector_object_type: { "pt-BR": "Esse tipo de registro não é suportado por este conector.", en: "That record type isn't supported by this connector." },
  connector_document_source: {
    "pt-BR": "O documento de origem só existe em workflows do Ironclad e contratos do Juro.",
    en: "The source document only exists for Ironclad workflows and Juro contracts.",
  },
  connector_status_unsupported: { "pt-BR": "Este conector não permite escrever o status em um campo.", en: "This connector can't write the status to a field." },
  connector_link_missing: { "pt-BR": "O vínculo com o registro de origem não existe mais.", en: "The link to the source record no longer exists." },
  connector_flow_missing: { "pt-BR": "O fluxo não existe mais.", en: "The flow no longer exists." },
  connector_flow_owner_gone: { "pt-BR": "Quem criou o fluxo não tem mais acesso: crie o fluxo de novo.", en: "The flow's creator no longer has access: create the flow again." },
};

/** file_too_large por la suma de los documentos (details.limit "total"), no por un archivo. */
const FILE_TOO_LARGE_TOTAL: Record<"es" | "pt-BR" | "en", string> = {
  es: "Los documentos del sobre superan el tamaño total permitido.",
  "pt-BR": "Os documentos do envelope excedem o tamanho total permitido.",
  en: "The envelope's documents exceed the total size allowed.",
};

/**
 * Cada problema de envelope_incomplete / logic_order (details.issues: {code, params, message}; details.problems es solo el texto). Los textos llevan
 * {param}; un código desconocido usa el `message` de la API (en español).
 */
const PROBLEM_TEXT: Record<string, Record<"es" | "pt-BR" | "en", string>> = {
  no_documents: { es: "Agregá al menos un documento", "pt-BR": "Adicione pelo menos um documento", en: "Add at least one document" },
  no_signers: { es: "Agregá al menos un firmante", "pt-BR": "Adicione pelo menos um signatário", en: "Add at least one signer" },
  no_active_signer: {
    es: "Tiene que quedar al menos un firmante o aprobador",
    "pt-BR": "Precisa restar pelo menos um signatário ou aprovador",
    en: "At least one signer or approver must remain",
  },
  signer_without_signature: { es: "{name} no tiene ningún campo de firma", "pt-BR": "{name} não tem nenhum campo de assinatura", en: "{name} has no signature field" },
  expiry_past: { es: "La fecha de vencimiento ya pasó", "pt-BR": "A data de vencimento já passou", en: "The expiration date has already passed" },
  too_many_attachment_fields: {
    es: "Máximo {max} campos de adjunto por sobre",
    "pt-BR": "Máximo de {max} campos de anexo por envelope",
    en: "At most {max} attachment fields per envelope",
  },
  too_many_recipients: { es: "El sobre admite hasta {max} destinatarios", "pt-BR": "O envelope admite até {max} destinatários", en: "The envelope allows up to {max} recipients" },
  too_many_fields: { es: "El sobre admite hasta {max} campos", "pt-BR": "O envelope admite até {max} campos", en: "The envelope allows up to {max} fields" },
  formula_missing_ref: {
    es: 'La fórmula de "{field}" cita {refs}, que ya no está en el sobre',
    "pt-BR": 'A fórmula de "{field}" cita {refs}, que não está mais no envelope',
    en: 'The formula of "{field}" refers to {refs}, which is no longer in the envelope',
  },
  missing_id_document: {
    es: "{name}: para exigir que el certificado corresponda a su documento hay que cargar el número de documento",
    "pt-BR": "{name}: para exigir que o certificado corresponda ao documento é preciso informar o número do documento",
    en: "{name}: to require the certificate to match their ID document, enter the document number",
  },
  payer_not_signer: {
    es: "Quien paga el cobro tiene que ser un firmante",
    "pt-BR": "Quem paga a cobrança precisa ser um signatário",
    en: "Whoever pays must be a signer",
  },
  logic_order: {
    es: 'El campo "{field}" de {recipient} depende de un campo de {source}, que firma después o al mismo tiempo',
    "pt-BR": 'O campo "{field}" de {recipient} depende de um campo de {source}, que assina depois ou ao mesmo tempo',
    en: 'The field "{field}" of {recipient} depends on a field of {source}, who signs later or at the same time',
  },
  logic_order_formula: {
    es: 'El campo "{field}" de {recipient} depende de un campo de {source} (a través de la fórmula de "{formula}"), que firma después o al mismo tiempo',
    "pt-BR": 'O campo "{field}" de {recipient} depende de um campo de {source} (pela fórmula de "{formula}"), que assina depois ou ao mesmo tempo',
    en: 'The field "{field}" of {recipient} depends on a field of {source} (through the formula of "{formula}"), who signs later or at the same time',
  },
};

/** Texto de un ítem de details.issues (o de details.problems, solo texto, en APIs viejas) en el idioma de la app. */
export function problemText(p: unknown, loc: "es" | "pt-BR" | "en"): string {
  if (!p || typeof p !== "object") return String(p);
  const { code, params, message } = p as { code?: unknown; params?: unknown; message?: unknown };
  const tpl = typeof code === "string" ? PROBLEM_TEXT[code]?.[loc] : undefined;
  if (!tpl) return typeof message === "string" ? message : String(code ?? "");
  const vars = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
  // Falta un parámetro que la plantilla necesita (p. ej. el campo no tiene nombre y la API omite params.field): el
  // texto de la API está mejor que una plantilla con "{field}" literal.
  const missing = [...tpl.matchAll(/\{(\w+)\}/g)].some(([, k]) => vars[k] == null);
  if (missing && typeof message === "string" && message) return message;
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] == null ? m : String(vars[k])));
}

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
    if (d.limit === "ai_tokens_per_month")
      return d.max === 0
        ? en
          ? "AI isn't included in your plan. Upgrade it in Billing."
          : "A IA não está incluída no seu plano. Altere-o em Faturamento."
        : en
          ? `The AI budget can't exceed your plan's limit (${Number(d.max).toLocaleString("en")} tokens per month). Upgrade it in Billing.`
          : `O orçamento de IA não pode superar o limite do seu plano (${Number(d.max).toLocaleString("pt-BR")} tokens por mês). Altere-o em Faturamento.`;
    if (d.limit === "users") return en ? "You've reached your plan's user limit. Upgrade it in Billing." : "Você atingiu o limite de usuários do seu plano. Altere-o em Faturamento.";
    return en ? "Your plan doesn't include this. Upgrade it in Billing." : "O seu plano não inclui isso. Altere-o em Faturamento.";
  }
  // Firma con certificado que exige corresponder al documento, sin documento cargado (details.recipient: el nombre).
  if (code === "missing_id_document") {
    const who = typeof d.recipient === "string" && d.recipient ? `${d.recipient}: ` : "";
    return en
      ? `${who}to require the certificate to match their ID document, enter the document number.`
      : `${who}para exigir que o certificado corresponda ao documento, informe o número do documento.`;
  }
  // El tope depende del camino (sobre o plantilla, alta en un paso): viene en details.max.
  if (code === "too_many_documents" && typeof d.max === "number")
    return en ? `Too many documents (at most ${d.max.toLocaleString("en")}).` : `Há documentos demais (máximo ${d.max.toLocaleString("pt-BR")}).`;
  // Editar roles o campos de una plantilla rompería formularios web activos (details.forms); sin forms, es el borrado
  // de la plantilla (texto de CODE_TEXT).
  if (code === "template_has_forms" && Array.isArray(d.forms) && d.forms.length) {
    const list = d.forms.map((f) => `"${String((f as { name?: unknown } | null)?.name ?? "")}"`).join(", ");
    const one = d.forms.length === 1;
    return en
      ? `This change would break the web form${one ? "" : "s"} ${list}: deactivate or adjust ${one ? "it" : "them"} first.`
      : `A alteração deixaria sem funcionar ${one ? "o formulário web" : "os formulários web"} ${list}: desative-${one ? "o" : "os"} ou ajuste-${one ? "o" : "os"} antes.`;
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

// 429 del límite de pedidos por IP: código rate_limited (antes bad_request, con el texto del plugin en inglés; un proxy
// puede responderlo sin cuerpo). Los topes de negocio (reminded_recently, form_rate_limited…) traen su propio texto.
const RATE_LIMITED: Record<"es" | "pt-BR" | "en", string> = {
  es: "Demasiados pedidos seguidos: esperá un minuto y reintentá.",
  "pt-BR": "Muitas requisições seguidas: aguarde um minuto e tente novamente.",
  en: "Too many requests in a row: wait a minute and try again.",
};

const RECIPIENT_WORD: Record<"es" | "pt-BR" | "en", string> = { es: "Destinatario", "pt-BR": "Destinatário", en: "Recipient" };

/**
 * Las rutas de validación de destinatarios ("recipients.1.email: Invalid email") no le dicen nada a quien usa la
 * consola: pasan a "Destinatario 2 (email)" o, si se conocen los nombres (en el orden enviado), al nombre.
 */
function humanizeRecipientPaths(text: string, loc: "es" | "pt-BR" | "en", names?: readonly string[]): string {
  return text.replace(/\brecipients\.(\d+)(?:\.([A-Za-z]\w*(?:\.\w+)*))?/g, (_m, n: string, rest: string | undefined) => {
    const i = Number(n);
    const who = names?.[i]?.trim() || `${RECIPIENT_WORD[loc] ?? RECIPIENT_WORD.es} ${i + 1}`;
    return rest ? `${who} (${rest})` : who;
  });
}

/** `recipientNames`: nombres de los destinatarios en el orden en que se mandaron (para los errores "recipients.N…"). */
export function errorText(e: unknown, opts: { recipientNames?: readonly string[] } = {}): string {
  if (e instanceof HttpError) {
    const loc = currentLocale();
    return humanizeRecipientPaths(httpErrorText(e, loc), loc, opts.recipientNames);
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

function httpErrorText(e: HttpError, loc: "es" | "pt-BR" | "en"): string {
  {
    if (e.status === 429 && (e.code === "rate_limited" || e.code === "bad_request" || e.code === "http_429")) {
      // En español, el texto de la API (dice cuántos segundos esperar) si es el nuevo; si no, el propio.
      return loc === "es" && e.code === "rate_limited" && e.message ? e.message : RATE_LIMITED[loc] ?? RATE_LIMITED.es;
    }
    const missing = (e.details as { missing?: unknown } | undefined)?.missing;
    if (loc !== "es" && e.code === "fields_incomplete") {
      const list = Array.isArray(missing) ? [...new Set(missing.map(String))].join(", ") : "";
      return (loc === "en" ? "Still to complete: " : "Ainda falta preencher: ") + list;
    }
    if (loc !== "es" && e.code === "clause_in_use") {
      // Con los nombres de lo que la usa (details.templates / details.clauses), como el mensaje en español.
      const d = e.details as { templates?: { name?: unknown }[]; clauses?: { title?: unknown }[] } | undefined;
      const names = [...(d?.templates ?? []).map((x) => String(x.name ?? "")), ...(d?.clauses ?? []).map((x) => String(x.title ?? ""))].filter(Boolean);
      const base = loc === "en" ? "The clause is used in: " : "A cláusula é usada em: ";
      if (names.length) return base + names.slice(0, 10).join(", ") + (names.length > 10 ? "…" : "");
    }
    const det = e.details as { problems?: unknown; issues?: unknown } | undefined;
    const problems = Array.isArray(det?.issues) ? det.issues : det?.problems;
    if (PROBLEMS_HEADER[e.code] && Array.isArray(problems) && problems.length) {
      return `${PROBLEMS_HEADER[e.code][loc] ?? PROBLEMS_HEADER[e.code].es} ${problems.map((p) => problemText(p, loc)).join(". ")}`;
    }
    if (e.code === "file_too_large" && (e.details as { limit?: unknown } | undefined)?.limit === "total") return FILE_TOO_LARGE_TOTAL[loc] ?? FILE_TOO_LARGE_TOTAL.es;
    const tr = loc !== "es" ? detailText(e.code, e.details, loc) ?? CODE_TEXT[e.code]?.[loc] : undefined;
    return tr ?? (e.message || (NO_MESSAGE[loc] ?? NO_MESSAGE.es)(e.status));
  }
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
    const err = ((await res.json().catch(() => null)) as ApiError | null)?.error;
    signalAuthErrors(res, path, err?.code);
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
