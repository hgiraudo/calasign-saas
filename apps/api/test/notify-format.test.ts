import { describe, expect, it } from "vitest";
import { NOTIFICATION_KINDS } from "@calasign/shared";
import {
  EVENT_COLORS,
  LIMITS,
  chatMdEscape,
  clip,
  discordEscape,
  discordPayload,
  googleChatPayload,
  payloadFor,
  slackCompatPayload,
  slackPayload,
  teamsPayload,
  webexPayload,
  type Message,
} from "../src/modules/notify-format";

// Asunto y nombre "hostiles": menciones masivas y links con texto falso en la sintaxis de cada plataforma.
const EVIL = "@everyone @channel <!channel> <@123> <users/all> [Ver](https://evil.example) **x**";
const msg: Message = {
  title: "✅ Sobre completado",
  subject: `Contrato ${EVIL}`,
  detail: "por Ana <@all> · Acme",
  link: "https://app.calasign.com/app/envelopes/0190",
  linkLabel: "Ver sobre",
  event: "envelope.completed",
};

describe("avisos a canales: formato por plataforma", () => {
  it("todos los tipos tienen formato", () => {
    for (const k of NOTIFICATION_KINDS) expect(payloadFor(k, msg)).toBeTruthy();
  });

  it("clip corta por caracteres sin partir emojis", () => {
    expect(clip("abc", 3)).toBe("abc");
    expect(clip("abcd", 3)).toBe("ab…");
    expect(clip("😀😀😀😀", 3)).toBe("😀😀…");
  });

  it("Slack: escapa <, > y &", () => {
    const p = slackPayload(msg);
    expect(JSON.stringify(p)).not.toContain("<!channel>");
    expect(p.text).toContain("&lt;!channel&gt;");
  });

  it("Teams: tarjeta adaptable para Workflows, sin links markdown inyectados", () => {
    const p = teamsPayload(msg);
    expect(p.type).toBe("message");
    expect(p.attachments[0].contentType).toBe("application/vnd.microsoft.card.adaptive");
    const card = p.attachments[0].content;
    expect(card.type).toBe("AdaptiveCard");
    expect(card.body[1].text).toContain("[Ver] (https://evil.example)");
    expect(card.actions[0]).toEqual({ type: "Action.OpenUrl", title: "Ver sobre", url: msg.link });
  });

  it("Discord: embed con color por evento, link al sobre y sin menciones", () => {
    const p = discordPayload(msg);
    expect(p.allowed_mentions).toEqual({ parse: [] });
    const e = p.embeds[0];
    expect(e.title).toBe(msg.title);
    expect(e.url).toBe(msg.link);
    expect(e.color).toBe(EVENT_COLORS["envelope.completed"]);
    expect(e.description).toContain(`[Ver sobre](${msg.link})`);
    // Nada de lo externo queda como mención o link: cada signo va escapado.
    expect(e.description).toContain("\\@everyone");
    expect(e.description).toContain("\\<\\@123\\>");
    expect(e.description).toContain("\\[Ver\\]\\(https\\://evil.example\\)");
    expect(e.description).not.toMatch(/(^|[^\\])@everyone/);
    expect(discordPayload({ ...msg, event: "envelope.declined" }).embeds[0].color).toBe(EVENT_COLORS["envelope.declined"]);
    expect(discordEscape("a\\b")).toBe("a\\\\b");
  });

  it("Discord: respeta los límites (título 256, descripción 4096, embed 6000)", () => {
    const long = { ...msg, title: "T".repeat(400), subject: "*".repeat(10_000), detail: "_".repeat(10_000) };
    const e = discordPayload(long).embeds[0];
    expect(Array.from(e.title).length).toBeLessThanOrEqual(256);
    expect(Array.from(e.description!).length).toBeLessThanOrEqual(4096);
    expect(e.title.length + e.description!.length).toBeLessThanOrEqual(6000);
    // El asunto se corta antes de escapar: no queda una barra suelta que escape el "…".
    expect(e.description).toContain("*".repeat(LIMITS.subject - 1).replace(/\*/g, "\\*") + "…");
  });

  it("Discord: mensaje de prueba sin link ni descripción", () => {
    const e = discordPayload({ title: "🔔 prueba: ok", event: "test" }).embeds[0];
    expect(e).toEqual({ title: "🔔 prueba: ok", color: EVENT_COLORS.test });
  });

  it("Google Chat: cardsV2 con HTML escapado y botón al sobre", () => {
    const p = googleChatPayload(msg);
    const card = p.cardsV2[0].card as any;
    expect(p.cardsV2[0].cardId).toBe("calasign-envelope-completed");
    expect(card.header.title).toBe(msg.title);
    const json = JSON.stringify(card.sections);
    expect(json).not.toContain("<users/all>");
    expect(json).toContain("&lt;users/all&gt;");
    expect(card.sections[0].widgets.at(-1)).toEqual({ buttonList: { buttons: [{ text: "Ver sobre", onClick: { openLink: { url: msg.link } } }] } });
    expect((googleChatPayload({ title: "x" }).cardsV2[0].card as any).sections).toBeUndefined();
  });

  it("Mattermost / Rocket.Chat: attachments del formato de Slack, sin menciones ni links", () => {
    expect(payloadFor("mattermost", msg)).toEqual(payloadFor("rocketchat", msg));
    const p = slackCompatPayload(msg);
    expect(p.text).toBe(msg.title);
    const a = p.attachments[0];
    expect(a.color).toBe("#16a34a");
    expect(a.title_link).toBe(msg.link);
    expect(a.text).not.toMatch(/@(channel|all|everyone|here)/);
    expect(a.text).toContain("@​channel");
    expect(a.text).toContain("\\[Ver\\]\\(https://evil.example\\)");
    expect(chatMdEscape("**x**")).toBe("\\*\\*x\\*\\*");
  });

  it("Webex: markdown con menciones y HTML neutralizados", () => {
    const p = webexPayload(msg);
    expect(p.markdown).not.toContain("<@all>");
    expect(p.markdown).toContain("&lt;@​all&gt;");
    expect(p.markdown).toContain(`[Ver sobre](${msg.link})`);
    expect(p.markdown).not.toContain("[Ver](https://evil.example)");
    expect(Buffer.byteLength(webexPayload({ ...msg, subject: "<".repeat(5000), detail: "&".repeat(5000) }).markdown)).toBeLessThan(7439);
  });
});
