// Formato de los avisos a canales (webhooks entrantes) por plataforma. Sin E/S: lo usan notify-integrations.ts y los tests.
//
// El asunto y los nombres pueden venir de afuera (p. ej. quien completa un formulario web): en cada plataforma se
// escapan para que no armen menciones a todo el canal (@channel, @everyone, <users/all>…) ni links con texto falso.
import type { NotificationEvent, NotificationKind } from "@calasign/shared";

export interface Message {
  /** Título fijo del evento (texto propio, ya traducido). */
  title: string;
  /** Asunto del sobre (externo). */
  subject?: string;
  /** Firmante · organización (externo). */
  detail?: string;
  /** Link al sobre en CalaSign (propio). */
  link?: string;
  linkLabel?: string;
  /** Para el color de la tarjeta (Discord, Mattermost, Rocket.Chat). */
  event?: NotificationEvent | "test";
}

/** Topes propios, muy por debajo de los de cada plataforma (Discord: descripción 4096; Rocket.Chat: 5000 por defecto…). */
export const LIMITS = { subject: 500, detail: 300 } as const;

/** Color por evento (RGB). */
export const EVENT_COLORS: Record<NotificationEvent | "test", number> = {
  "envelope.sent": 0x2563eb,
  "envelope.completed": 0x16a34a,
  "envelope.declined": 0xdc2626,
  "envelope.voided": 0x6b7280,
  "envelope.expired": 0xd97706,
  "recipient.signed": 0x0d9488,
  "recipient.approved": 0x7c3aed,
  test: 0x64748b,
};
const colorOf = (m: Message) => EVENT_COLORS[m.event ?? "test"] ?? EVENT_COLORS.test;
const hexColor = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

/** Corta en `max` caracteres (por código, sin partir emojis ni pares sustitutos) con "…". */
export function clip(t: string, max: number): string {
  const cps = Array.from(t);
  return cps.length <= max ? t : `${cps.slice(0, Math.max(0, max - 1)).join("")}…`;
}

const clipped = (m: Message) => ({
  subject: m.subject ? clip(m.subject.replace(/\s+/g, " ").trim(), LIMITS.subject) : undefined,
  detail: m.detail ? clip(m.detail.replace(/\s+/g, " ").trim(), LIMITS.detail) : undefined,
});

// ───────────────────────────── Escapes ─────────────────────────────

// Slack: &, < y > se escapan (https://api.slack.com/reference/surfaces/formatting#escaping).
export const slackEscape = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Teams (Adaptive Cards) no tiene escape: se corta la sintaxis de link markdown [texto](url). Las menciones exigen
// `entities` en la tarjeta, así que un "<at>" en el texto no avisa a nadie.
export const teamsEscape = (t: string) => t.replace(/\]\s*\(/g, "] (");
// Markdown de Discord: la barra invertida escapa cualquier signo de puntuación ASCII. Se escapan los que dan formato,
// links ([texto](url)), menciones (<@id>, <#canal>, @everyone) y encabezados. Además el envío lleva
// allowed_mentions: {parse: []}, así que aunque algo se colara no avisaría a nadie.
export const discordEscape = (t: string) => t.replace(/[\\*_~`|<>[\]()#@:-]/g, "\\$&");
// Google Chat: los textParagraph de las tarjetas usan un subconjunto de HTML.
export const htmlEscape = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Mattermost y Rocket.Chat: markdown con barra invertida, y "@" seguido de un espacio de ancho cero para que
// @channel/@all/@here/@usuario no avise (ninguno de los dos tiene un equivalente de allowed_mentions).
export const chatMdEscape = (t: string) => t.replace(/[\\*_~`|<>[\]()#]/g, "\\$&").replace(/@/g, "@\u200b");
// Webex: markdown; < y > como entidades (las menciones son <@all>, <@personEmail:…>) y "@" como en Mattermost.
export const webexEscape = (t: string) =>
  t
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\*_~`|[\]()#]/g, "\\$&")
    .replace(/@/g, "@\u200b");

// ───────────────────────────── Formatos ─────────────────────────────

export function slackPayload(m: Message) {
  const c = clipped(m);
  const parts = [m.title, c.subject, c.detail].map((x) => (x ? slackEscape(x) : x));
  return {
    text: parts.filter(Boolean).join(" — "),
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: [`*${parts[0]}*`, parts[1], parts[2]].filter(Boolean).join("\n") } },
      ...(m.link ? [{ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: m.linkLabel ?? "Abrir" }, url: m.link }] }] : []),
    ],
  };
}

/**
 * Tarjeta adaptable dentro de un mensaje: es el formato que piden los webhooks de Workflows de Teams (Power Automate,
 * "Publicar en un canal cuando se recibe una solicitud de webhook"), y también lo aceptaban los conectores de
 * Office 365 ya retirados, así que sirve con URLs de los dos tipos. No se usa MessageCard (formato viejo de conectores).
 */
export function teamsPayload(m: Message) {
  const c = clipped(m);
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            { type: "TextBlock", text: teamsEscape(m.title), weight: "Bolder", size: "Medium", wrap: true },
            ...(c.subject ? [{ type: "TextBlock", text: teamsEscape(c.subject), wrap: true }] : []),
            ...(c.detail ? [{ type: "TextBlock", text: teamsEscape(c.detail), isSubtle: true, wrap: true }] : []),
          ],
          actions: m.link ? [{ type: "Action.OpenUrl", title: m.linkLabel ?? "Abrir", url: m.link }] : [],
        },
      },
    ],
  };
}

/** Discord: un embed con color por evento y el título linkeado al sobre. */
export function discordPayload(m: Message) {
  const c = clipped(m);
  const desc = [c.subject ? `**${discordEscape(c.subject)}**` : null, c.detail ? discordEscape(c.detail) : null, m.link ? `[${discordEscape(m.linkLabel ?? "Abrir")}](${m.link})` : null]
    .filter(Boolean)
    .join("\n");
  return {
    username: "CalaSign",
    allowed_mentions: { parse: [] as string[] },
    embeds: [
      {
        title: clip(m.title, 256), // texto propio
        ...(m.link ? { url: m.link } : {}),
        ...(desc ? { description: clip(desc, 4096) } : {}),
        color: colorOf(m),
      },
    ],
  };
}

/** Google Chat: tarjeta (cardsV2) con encabezado, texto y botón al sobre. */
export function googleChatPayload(m: Message) {
  const c = clipped(m);
  const widgets: unknown[] = [];
  if (c.subject) widgets.push({ textParagraph: { text: `<b>${htmlEscape(c.subject)}</b>` } });
  if (c.detail) widgets.push({ textParagraph: { text: htmlEscape(c.detail) } });
  if (m.link) widgets.push({ buttonList: { buttons: [{ text: m.linkLabel ?? "Abrir", onClick: { openLink: { url: m.link } } }] } });
  return {
    cardsV2: [
      {
        cardId: `calasign-${(m.event ?? "test").replace(/\./g, "-")}`,
        card: {
          header: { title: m.title, subtitle: "CalaSign" },
          ...(widgets.length ? { sections: [{ widgets }] } : {}),
        },
      },
    ],
  };
}

/**
 * Mattermost y Rocket.Chat: los dos aceptan los "attachments" del formato de Slack en sus webhooks entrantes
 * (no los blocks), con color, título linkeado y texto en markdown.
 */
export function slackCompatPayload(m: Message) {
  const c = clipped(m);
  const text = [c.subject ? `**${chatMdEscape(c.subject)}**` : null, c.detail ? chatMdEscape(c.detail) : null].filter(Boolean).join("\n");
  return {
    text: m.title,
    attachments: [
      {
        fallback: m.title,
        color: hexColor(colorOf(m)),
        ...(m.link ? { title: m.linkLabel ?? "Abrir", title_link: m.link } : {}),
        ...(text ? { text } : {}),
      },
    ],
  };
}

/** Webex (app "Incoming Webhooks"): un mensaje en markdown. */
export function webexPayload(m: Message) {
  const c = clipped(m);
  const lines = [`**${m.title}**`, c.subject ? webexEscape(c.subject) : null, c.detail ? `_${webexEscape(c.detail)}_` : null, m.link ? `[${webexEscape(m.linkLabel ?? "Abrir")}](${m.link})` : null];
  return { markdown: lines.filter(Boolean).join("  \n") };
}

export function payloadFor(kind: NotificationKind, m: Message): unknown {
  switch (kind) {
    case "slack":
      return slackPayload(m);
    case "teams":
      return teamsPayload(m);
    case "discord":
      return discordPayload(m);
    case "google_chat":
      return googleChatPayload(m);
    case "mattermost":
    case "rocketchat":
      return slackCompatPayload(m);
    case "webex":
      return webexPayload(m);
    default: {
      const never: never = kind;
      throw new Error(`canal desconocido: ${String(never)}`);
    }
  }
}
