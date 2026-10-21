// Avisos salientes: WhatsApp (botón de la plantilla de autenticación e idiomas aprobados), SMS del código corto, rechazo
// de SES del dominio propio (reintento desde la plataforma), Reply-To de los avisos al firmante, invitaciones al equipo
// con la marca, restablecimiento de contraseña con supresión, alerta BYOK con idioma y marca, plantillas propias
// ({{ message }}, {{reason}}/{{code}} de finalize_failed), quejas "not-spam" y nombre del producto en los canales.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-outbound-fixes-"));
delete process.env.DATABASE_URL;

type Sent = { to: string; subject: string; text: string; html?: string; from?: string | null; replyTo?: string | null; link?: string | null; fallbackFrom?: string | null };
const mails: Sent[] = [];
let nextResult: Record<string, unknown> = {};
vi.mock("../src/notifications/channels", async (orig) => ({
  ...(await orig<typeof import("../src/notifications/channels")>()),
  deliver: vi.fn(async (m: Sent) => {
    mails.push(m);
    return { provider: "smtp", messageId: `id-${mails.length}`, ...nextResult };
  }),
}));

type Db = Awaited<ReturnType<typeof import("../src/infra/db")["createDb"]>>;
let db: Db;
const log = { info() {}, warn() {}, error() {} };

async function newTenant(branding?: object) {
  const { uuidv7 } = await import("../src/lib/util");
  const t = uuidv7();
  await db.query(`INSERT INTO tenants (id, slug, name, branding) VALUES ($1, $2, 'Org', COALESCE($3::jsonb, '{}'::jsonb))`, [t, `t-${t.slice(-8)}`, branding ? JSON.stringify(branding) : null]);
  return t;
}

async function newUser(tenant: string | null, email: string, role = "owner", locale: string | null = null) {
  const { uuidv7 } = await import("../src/lib/util");
  const u = uuidv7();
  await db.query(`INSERT INTO users (id, email, name, password_hash, locale) VALUES ($1,$2,'Ana','x',COALESCE($3,'es'))`, [u, email, locale]);
  if (tenant) await db.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,$3)`, [tenant, u, role]);
  return u;
}

async function verifiedMailDomain(tenant: string, domain: string) {
  const { uuidv7, encrypt } = await import("../src/lib/util");
  await db.query(
    `INSERT INTO email_domains (id, tenant_id, domain, status, verification_token, dkim_selector, dkim_public_key, dkim_private_key_enc, verified_at)
     VALUES ($1,$2,$3,'verified','tok','cs1','pub',$4, now())`,
    [uuidv7(), tenant, domain, encrypt("-----BEGIN PRIVATE KEY-----x")],
  );
}

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  db = await createDb();
  await migrate(db);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("WhatsApp", () => {
  it("la plantilla de autenticación lleva el código también en el botón (URL, índice 0)", async () => {
    const { whatsAppPayload } = await import("../src/notifications/channels");
    const { config } = await import("../src/config");
    expect(config.whatsapp.otpTemplateKind).toBe("authentication");
    const p = whatsAppPayload({ channel: "whatsapp", to: "+5491100000000", subject: "", text: "", templateParams: ["123456"], buttonParams: ["123456"], template: "calasign_verification_code", locale: "es" });
    expect(p.to).toBe("5491100000000");
    expect(p.template.components).toEqual([
      { type: "body", parameters: [{ type: "text", text: "123456" }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "123456" }] },
    ]);
    // Sin botón (plantilla "utility" o un aviso): solo el cuerpo.
    const q = whatsAppPayload({ channel: "whatsapp", to: "+1", subject: "", text: "", templateParams: ["a", "b"] });
    expect(q.template.components).toHaveLength(1);
  });

  it("idioma: el del destinatario si está aprobado; si no, español", async () => {
    const { whatsAppLanguage, whatsAppPayload } = await import("../src/notifications/channels");
    expect(whatsAppLanguage("en", ["es", "en", "pt_BR"])).toBe("en");
    expect(whatsAppLanguage("pt-BR", ["es", "en", "pt_BR"])).toBe("pt_BR");
    expect(whatsAppLanguage("pt-BR", ["es"])).toBe("es");
    expect(whatsAppLanguage("fr", ["es", "en"])).toBe("es");
    // Sin español aprobado: el primero de la lista. "pt-BR" vale como pt_BR.
    expect(whatsAppLanguage("fr", ["en", "pt_BR"])).toBe("en");
    expect(whatsAppLanguage("pt-BR", ["pt-BR"])).toBe("pt_BR");
    expect(whatsAppLanguage("en", ["pt-BR"])).toBe("pt_BR");
    // Por defecto (WHATSAPP_TEMPLATE_LANGS sin definir) están los tres, como antes de existir la variable.
    const { config } = await import("../src/config");
    expect(config.whatsapp.templateLangs).toEqual(["es", "en", "pt_BR"]);
    expect(whatsAppPayload({ channel: "whatsapp", to: "1", subject: "", text: "", locale: "en" }).template.language.code).toBe("en");
    expect(whatsAppPayload({ channel: "whatsapp", to: "1", subject: "", text: "", locale: "pt-BR" }).template.language.code).toBe("pt_BR");
  });
});

describe("SMS del código de verificación", () => {
  it("texto corto en GSM-7 (un segmento); la plantilla de la marca sólo si entra en 2 segmentos y lleva el código", async () => {
    const { otpSmsText, smsSegments } = await import("../src/modules/white-label/otp-text");
    const { resolveBrand } = await import("../src/modules/white-label/brand");
    const t = await newTenant();
    const longSubject = "Contrato de prestación de servicios profesionales con anexos y condiciones generales 2026";
    const plain = await resolveBrand(db, t, null);
    for (const [loc, want] of [
      ["es", "Tu codigo de CalaSign: 123456. Vence en 10 min. No lo compartas."],
      ["pt-BR", "Seu codigo da CalaSign: 123456. Expira em 10 min. Nao compartilhe."],
      ["en", "Your CalaSign code: 123456. Expires in 10 min. Don't share it."],
    ] as const) {
      const s = otpSmsText(plain, loc, "123456", longSubject);
      expect(s).toBe(want);
      expect(smsSegments(s)).toBe(1);
      // GSM-7 puro: 160 caracteres por segmento.
      expect(smsSegments(`${s}${"x".repeat(160 - s.length)}`)).toBe(1);
    }

    // Segmentos: GSM-7 160/153 (la tabla extendida cuenta doble), UCS-2 70/67.
    expect(smsSegments("a".repeat(160))).toBe(1);
    expect(smsSegments("a".repeat(161))).toBe(2);
    expect(smsSegments("a".repeat(306))).toBe(2);
    expect(smsSegments("a".repeat(307))).toBe(3);
    expect(smsSegments("€".repeat(80))).toBe(1);
    expect(smsSegments("€".repeat(81))).toBe(2);
    expect(smsSegments("ó".repeat(70))).toBe(1);
    expect(smsSegments(`código ${"a".repeat(64)}`)).toBe(2);
    expect(smsSegments("ó".repeat(134))).toBe(2);
    expect(smsSegments("ó".repeat(135))).toBe(3);

    // Producto con tildes (pasaría a UCS-2 y a 2 segmentos): se translitera a GSM-7 y entra en un segmento.
    const own = await resolveBrand(db, t, null, { override: { productName: "Firmación Ágil" } });
    const o = otpSmsText(own, "es", "654321", "NDA");
    expect(o).toBe("Tu codigo de Firmacion Agil: 654321. Vence en 10 min. No lo compartas.");
    expect(smsSegments(o)).toBe(1);
    const pt = await resolveBrand(db, t, null, { override: { productName: "Assinatura Fácil" } });
    const op = otpSmsText(pt, "pt-BR", "654321", "NDA");
    expect(op).toBe("Seu codigo da Assinatura Facil: 654321. Expira em 10 min. Nao compartilhe.");
    expect(smsSegments(op)).toBe(1);
    // Los que ya son GSM-7 (é, ñ, ü) quedan; lo que no tiene equivalente se descarta.
    const { toGsm7 } = await import("../src/modules/white-label/otp-text");
    expect(toGsm7("Señal Café Über ção õ 签名")).toBe("Señal Café Über cao o");
    // Producto sin nada transliterable: el texto sin el nombre del producto.
    const cjk = await resolveBrand(db, t, null, { override: { productName: "签名" } });
    expect(otpSmsText(cjk, "es", "654321", "NDA")).toBe("Tu codigo de verificacion: 654321. Vence en 10 min. No lo compartas.");
    // Tabla extendida (cuenta doble) hasta el máximo: sigue en un segmento.
    const ext = await resolveBrand(db, t, null, { override: { productName: "€".repeat(40) } });
    expect(smsSegments(otpSmsText(ext, "es", "654321", "NDA"))).toBe(1);

    // Plantilla propia de más de 2 segmentos: el texto corto (antes se recortaba a 320 caracteres, que con una tilde son 5 segmentos).
    const long = await resolveBrand(db, t, null, { override: { templates: { otp_code: { es: { body: `Código {{code}}. ${"x".repeat(200)}` } } } } });
    expect(otpSmsText(long, "es", "111222", "NDA")).toBe("Tu codigo de CalaSign: 111222. Vence en 10 min. No lo compartas.");
    // En GSM-7 entra en 2 segmentos (≤ 306): tal cual.
    const gsm = await resolveBrand(db, t, null, { override: { templates: { otp_code: { es: { body: `Codigo {{code}}. ${"x".repeat(250)}` } } } } });
    expect(otpSmsText(gsm, "es", "111222", "NDA")).toBe(`Codigo 111222. ${"x".repeat(250)}`);
    // Más de 1600 caracteres: el texto corto.
    const huge = await resolveBrand(db, t, null, { override: { templates: { otp_code: { es: { body: `{{code}} ${"y".repeat(2000)}` } } } } });
    expect(otpSmsText(huge, "es", "555666", "NDA")).toContain("555666. Vence");
    // Corta: tal cual.
    const ok = await resolveBrand(db, t, null, { override: { templates: { otp_code: { es: { body: "Tu código ACME: {{code}}" } } } } });
    expect(otpSmsText(ok, "es", "777888", "NDA")).toBe("Tu código ACME: 777888");
  });
});

describe("rechazo de SES del dominio propio", () => {
  it("554 identidad sin verificar: reintenta una vez desde la plataforma con el nombre de la marca", async () => {
    const { sendEmail, setMailTransportForTests, isSesIdentityRejection, resetSesIdentityBackoffForTests } = await import("../src/notifications/channels");
    resetSesIdentityBackoffForTests();
    const { config } = await import("../src/config");
    const calls: any[] = [];
    let failFirst = true;
    setMailTransportForTests({
      sendMail: (async (msg: any) => {
        calls.push(msg);
        if (failFirst && calls.length === 1) {
          throw Object.assign(new Error("Message failed: 554 Message rejected: Email address is not verified. The following identities failed the check in region US-EAST-1: firmas@acme.test"), {
            responseCode: 554,
            response: "554 Message rejected: Email address is not verified. The following identities failed the check in region US-EAST-1: firmas@acme.test",
          });
        }
        return { response: "250 Ok 0100abc-000000", messageId: "<x@y>" };
      }) as any,
    });
    try {
      const dkim = { domainName: "acme.test", keySelector: "cs1", privateKey: "k" };
      const res = await sendEmail({ channel: "email", to: "ana@x.com", subject: "s", text: "t", from: '"Firmas ACME" <firmas@acme.test>', dkim });
      expect(calls).toHaveLength(2);
      expect(calls[0].dkim).toEqual(dkim);
      expect(calls[1].dkim).toBeUndefined();
      expect(calls[1].from).toContain("Firmas ACME");
      expect(calls[1].from).toContain(/<([^>]+)>/.exec(config.mail.from)?.[1] ?? config.mail.from);
      // Las respuestas siguen yendo a la dirección de la marca.
      expect(calls[1].replyTo).toBe("firmas@acme.test");
      expect(res).toEqual({ provider: "smtp", messageId: "0100abc-000000", identityRejectedDomain: "acme.test" });

      // Sin dominio propio (sin DKIM) o con otro error: no se reintenta.
      calls.length = 0;
      await expect(sendEmail({ channel: "email", to: "ana@x.com", subject: "s", text: "t", from: '"X" <no-reply@calasign.test>' })).rejects.toThrow(/554/);
      expect(calls).toHaveLength(1);
      expect(isSesIdentityRejection(Object.assign(new Error("550 mailbox unavailable"), { responseCode: 550 }))).toBe(false);
      expect(isSesIdentityRejection(new Error("554 Message rejected: Email address is not verified."))).toBe(true);

      // Después del rechazo, el mismo dominio sale directo desde la plataforma (sin otro intento fallido) por un rato.
      failFirst = false;
      calls.length = 0;
      const again = await sendEmail({ channel: "email", to: "ana@x.com", subject: "s", text: "t", from: '"Firmas ACME" <firmas@acme.test>', dkim });
      expect(calls).toHaveLength(1);
      expect(calls[0].dkim).toBeUndefined();
      expect(calls[0].from).toContain("Firmas ACME");
      // Se informa igual el rechazo (en espera) para que el aviso siga anotado en el dominio.
      expect(again.identityRejectedDomain).toBe("acme.test");
      expect(again.identityBackoff).toBe(true);
      expect(again.dkimDomain).toBeUndefined();
      // Otro dominio no está en espera; un envío con DKIM aceptado lo informa.
      calls.length = 0;
      const other = await sendEmail({ channel: "email", to: "ana@x.com", subject: "s", text: "t", from: '"B" <b@otro.test>', dkim: { ...dkim, domainName: "otro.test" } });
      expect(calls).toHaveLength(1);
      expect(calls[0].dkim?.domainName).toBe("otro.test");
      expect(other.dkimDomain).toBe("otro.test");
      // Vencida la espera, se vuelve a intentar con el dominio propio.
      vi.useFakeTimers({ now: Date.now() + 16 * 60_000, toFake: ["Date"] });
      try {
        calls.length = 0;
        const later = await sendEmail({ channel: "email", to: "ana@x.com", subject: "s", text: "t", from: '"Firmas ACME" <firmas@acme.test>', dkim });
        expect(calls).toHaveLength(1);
        expect(calls[0].dkim).toEqual(dkim);
        expect(later.dkimDomain).toBe("acme.test");
      } finally {
        vi.useRealTimers();
      }
    } finally {
      setMailTransportForTests(null);
      resetSesIdentityBackoffForTests();
    }
  });

  it("un envío con DKIM aceptado borra el aviso de rechazo de SES (una sola vez por dominio y proceso)", async () => {
    const { sendTracked, SES_IDENTITY_ERROR } = await import("../src/notifications/outbound");
    const t = await newTenant();
    await verifiedMailDomain(t, "acme5.test");
    const send = async (r: Record<string, unknown>) => {
      nextResult = r;
      try {
        expect((await sendTracked(db, { tenantId: t, template: "invite" }, { channel: "email", to: "ana@x.com", subject: "s", text: "t", tenantId: t })).status).toBe("sent");
      } finally {
        nextResult = {};
      }
    };
    const lastError = async () => (await db.one<any>(`SELECT last_error FROM email_domains WHERE tenant_id = $1`, [t])).last_error;
    await send({ identityRejectedDomain: "acme5.test" });
    expect(await lastError()).toBe(SES_IDENTITY_ERROR);
    await send({ dkimDomain: "acme5.test" });
    expect(await lastError()).toBeNull();
    // Ya limpio en este proceso: los envíos siguientes no escriben en email_domains.
    const spy = vi.spyOn(db, "query");
    try {
      await send({ dkimDomain: "acme5.test" });
      expect(spy.mock.calls.filter(([q]) => /email_domains/.test(String(q)))).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
    // Otra réplica lo vuelve a anotar: pasado el vencimiento del caché, un envío aceptado lo borra otra vez.
    await db.query(`UPDATE email_domains SET last_error = $2 WHERE tenant_id = $1`, [t, SES_IDENTITY_ERROR]);
    await send({ dkimDomain: "acme5.test" });
    expect(await lastError()).toBe(SES_IDENTITY_ERROR);
    vi.useFakeTimers({ now: Date.now() + 11 * 60_000, toFake: ["Date"] });
    try {
      await send({ dkimDomain: "acme5.test" });
    } finally {
      vi.useRealTimers();
    }
    expect(await lastError()).toBeNull();
    // Un error distinto (p. ej. de la re-verificación) no se borra.
    await send({ identityRejectedDomain: "acme5.test" });
    await db.query(`UPDATE email_domains SET last_error = 'otro' WHERE tenant_id = $1`, [t]);
    await send({ dkimDomain: "acme5.test" });
    expect(await lastError()).toBe("otro");
  });

  it("en espera por el rechazo: cada envío vuelve a anotar el aviso si se borró (sin escribir si ya está, sin repetir el log)", async () => {
    const { sendTracked, SES_IDENTITY_ERROR } = await import("../src/notifications/outbound");
    const t = await newTenant();
    await verifiedMailDomain(t, "acme6.test");
    const warn = vi.fn();
    const send = async (r: Record<string, unknown>) => {
      nextResult = r;
      try {
        await sendTracked(db, { tenantId: t, template: "invite", log: { error: vi.fn(), warn } }, { channel: "email", to: "ana@x.com", subject: "s", text: "t", tenantId: t });
      } finally {
        nextResult = {};
      }
    };
    await db.query(`UPDATE email_domains SET last_error = NULL WHERE tenant_id = $1`, [t]);
    await send({ identityRejectedDomain: "acme6.test", identityBackoff: true });
    expect((await db.one<any>(`SELECT last_error FROM email_domains WHERE tenant_id = $1`, [t])).last_error).toBe(SES_IDENTITY_ERROR);
    expect(warn).not.toHaveBeenCalled();
    // Ya anotado: la consulta no coincide con ninguna fila (IS DISTINCT FROM), no hay escritura (la versión de la fila no cambia).
    const version = async () => (await db.one<any>(`SELECT xmin::text AS v FROM email_domains WHERE tenant_id = $1`, [t])).v;
    const before = await version();
    await send({ identityRejectedDomain: "acme6.test", identityBackoff: true });
    expect(await version()).toBe(before);
    // Un rechazo nuevo (no en espera) sí se registra en el log.
    await send({ identityRejectedDomain: "acme6.test" });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("el envío registrado anota el rechazo en el dominio de correo", async () => {
    const { sendTracked } = await import("../src/notifications/outbound");
    const t = await newTenant();
    await verifiedMailDomain(t, "acme.test");
    nextResult = { identityRejectedDomain: "acme.test" };
    try {
      const out = await sendTracked(db, { tenantId: t, template: "invite" }, { channel: "email", to: "ana@x.com", subject: "s", text: "t", tenantId: t });
      expect(out.status).toBe("sent");
    } finally {
      nextResult = {};
    }
    const d = await db.one<any>(`SELECT status, last_error FROM email_domains WHERE tenant_id = $1`, [t]);
    expect(d.status).toBe("verified");
    expect(d.last_error).toMatch(/Amazon SES/);
  });

  it("senderFor da la dirección de la plataforma de reserva con un dominio propio", async () => {
    const { resolveBrand, senderFor } = await import("../src/modules/white-label/brand");
    const t = await newTenant({ whiteLabel: { email: { fromName: "Firmas ACME", fromEmail: "firmas@acme2.test" } } });
    await verifiedMailDomain(t, "acme2.test");
    const s = await senderFor(db, await resolveBrand(db, t, null));
    expect(s.customDomain).toBe(true);
    expect(s.fallbackFrom).toMatch(/^"Firmas ACME" </);
    expect(s.fallbackFrom).not.toContain("acme2.test");
  });
});

describe("Reply-To de los avisos al firmante", () => {
  it("la dirección de respuesta explícita de la marca gana; sin ella, quien creó el sobre (si sigue siendo miembro); si no, la de la marca", async () => {
    const { signerReplyTo, createJobHandlers } = await import("../src/modules/jobs");
    const { createBlobStore } = await import("../src/infra/storage");
    const { uuidv7, encrypt, sha256Hex, randomToken } = await import("../src/lib/util");
    expect(signerReplyTo({ email: "a@x.com", is_member: true }, "marca@x.com", "marca@x.com")).toBe("marca@x.com");
    expect(signerReplyTo({ email: "a@x.com", is_member: true }, null, "desde@x.com")).toBe("a@x.com");
    expect(signerReplyTo({ email: "a@x.com", is_member: false }, null, "desde@x.com")).toBe("desde@x.com");
    expect(signerReplyTo(null, null, null)).toBeNull();

    // Marca con Reply-To explícito: gana sobre el creador.
    {
      const t = await newTenant({ whiteLabel: { email: { replyTo: "respuestas@org.test" } } });
      const creator = await newUser(t, `creador-${t.slice(-6)}@org.test`);
      const env = uuidv7();
      await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status, sent_at, created_by) VALUES ($1,$2,'Contrato','sent',now(),$3)`, [env, t, creator]);
      const rec = uuidv7();
      const token = randomToken();
      await db.query(
        `INSERT INTO recipients (id, tenant_id, envelope_id, role, routing_order, name, email, channels, status, sent_at, access_token_hash, access_token_enc)
         VALUES ($1,$2,$3,'signer',1,'Bea','bea@x.com',$4,'sent',now(),$5,$6)`,
        [rec, t, env, ["email"], sha256Hex(token), encrypt(token)],
      );
      const handlers = createJobHandlers({ db, blobs: createBlobStore(), log });
      mails.length = 0;
      await handlers.notify({ kind: "invite", envelopeId: env, tenantId: t, recipientId: rec }, { id: 9003, attempts: 1, maxAttempts: 8 });
      expect(mails.map((m) => m.replyTo)).toEqual(["respuestas@org.test"]);
    }

    // Sin Reply-To explícito: el creador; si deja la organización, el de la marca (su fromEmail sin dominio propio).
    const t = await newTenant({ whiteLabel: { email: { fromEmail: "firmas@org-sin-dominio.test" } } });
    const creator = await newUser(t, `creador-${t.slice(-6)}@org.test`);
    const env = uuidv7();
    await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status, sent_at, created_by) VALUES ($1,$2,'Contrato','sent',now(),$3)`, [env, t, creator]);
    const rec = uuidv7();
    const token = randomToken();
    await db.query(
      `INSERT INTO recipients (id, tenant_id, envelope_id, role, routing_order, name, email, channels, status, sent_at, access_token_hash, access_token_enc)
       VALUES ($1,$2,$3,'signer',1,'Bea','bea@x.com',$4,'sent',now(),$5,$6)`,
      [rec, t, env, ["email"], sha256Hex(token), encrypt(token)],
    );
    const handlers = createJobHandlers({ db, blobs: createBlobStore(), log });
    mails.length = 0;
    await handlers.notify({ kind: "invite", envelopeId: env, tenantId: t, recipientId: rec }, { id: 9001, attempts: 1, maxAttempts: 8 });
    expect(mails.map((m) => m.replyTo)).toEqual([`creador-${t.slice(-6)}@org.test`]);

    await db.query(`DELETE FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [t, creator]);
    mails.length = 0;
    await handlers.notify({ kind: "reminder", envelopeId: env, tenantId: t, recipientId: rec }, { id: 9002, attempts: 1, maxAttempts: 8 });
    expect(mails.map((m) => m.replyTo)).toEqual(["firmas@org-sin-dominio.test"]);
  }, 60_000);
});

describe("invitación al equipo", () => {
  it("sale con la marca y el remitente de la organización", async () => {
    const { sendInvitationEmail } = await import("../src/modules/teams");
    const t = await newTenant({ whiteLabel: { productName: "FirmaYa", email: { fromName: "Firmas ACME", fromEmail: "firmas@acme3.test" } } });
    await verifiedMailDomain(t, "acme3.test");
    mails.length = 0;
    await sendInvitationEmail(db, t, "nuevo@x.com", "ACME", "Ana", "Administrador", "https://firmas.acme3.test/invite/tok", "en");
    expect(mails).toHaveLength(1);
    const m = mails[0];
    expect(m.from).toBe('"Firmas ACME" <firmas@acme3.test>');
    expect(m.subject).toBe("You've been invited to ACME on FirmaYa");
    expect(m.text).toContain("https://firmas.acme3.test/invite/tok");
    expect(m.text).not.toContain("CalaSign");
    expect(m.html).not.toContain("CalaSign");
    expect(m.fallbackFrom).toMatch(/^"Firmas ACME" </);
  });

  it("el link de aceptación va a la app principal aunque la organización tenga dominio propio (allí no se sirven las páginas de cuenta)", async () => {
    const { config } = await import("../src/config");
    const { buildApp } = await import("../src/app");
    const { createBlobStore } = await import("../src/infra/storage");
    const { uuidv7, sha256Hex } = await import("../src/lib/util");
    const t = await newTenant();
    await db.query(
      `INSERT INTO custom_domains (id, tenant_id, domain, verification_token, status, verified_at, last_checked_at) VALUES ($1,$2,'firmas.org4.test','tok','verified',now(),now())`,
      [uuidv7(), t],
    );
    const key = `cs_test_inv_${t.slice(-8)}`;
    await db.query(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash) VALUES ($1,$2,'k','cs_test',$3)`, [uuidv7(), t, sha256Hex(key)]);
    const app = await buildApp({ db, blobs: createBlobStore(), logger: false });
    await app.ready();
    try {
      mails.length = 0;
      const res = await app.inject({ method: "POST", url: "/v1/invitations", headers: { authorization: `Bearer ${key}` }, payload: { email: "otra@x.com", role: "member" } });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().acceptUrl.startsWith(`${config.appUrl}/invite/`)).toBe(true);
      expect(mails).toHaveLength(1);
      expect(new URL(mails[0].link!).host).toBe(new URL(config.appUrl).host);
      expect(mails[0].link).not.toContain("firmas.org4.test");
    } finally {
      await app.close();
    }
  }, 60_000);
});

describe("restablecimiento de contraseña", () => {
  it("no se manda a una dirección con rebote permanente vigente (supresión global)", async () => {
    const { createJobHandlers } = await import("../src/modules/jobs");
    const { createBlobStore } = await import("../src/infra/storage");
    const { encrypt, sha256Hex, randomToken } = await import("../src/lib/util");
    const handlers = createJobHandlers({ db, blobs: createBlobStore(), log });
    const run = async (email: string) => {
      const u = await newUser(null, email);
      const token = randomToken();
      await db.query(`INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1,$2, now() + interval '1 hour')`, [sha256Hex(token), u]);
      mails.length = 0;
      await handlers.notify({ kind: "password_reset", envelopeId: "", tenantId: "", userId: u, tokenEnc: encrypt(token) } as any, { id: 1, attempts: 1, maxAttempts: 8 });
      return mails.length;
    };
    await db.query(`INSERT INTO email_suppressions (address, reason, expires_at) VALUES ('rebota-reset@x.com', 'bounce', now() + interval '30 days')`);
    expect(await run("rebota-reset@x.com")).toBe(0);
    expect(await run("ok-reset@x.com")).toBe(1);
  });
});

describe("alerta BYOK", () => {
  it("en el idioma de cada administrador y con el nombre del producto de la marca", async () => {
    const { markKeyFailing } = await import("../src/modules/data/byok");
    const t = await newTenant({ whiteLabel: { productName: "FirmaYa" } });
    await newUser(t, `admin-en-${t.slice(-6)}@x.com`, "owner", "en");
    await newUser(t, `admin-pt-${t.slice(-6)}@x.com`, "admin", "pt-BR");
    await db.query(`UPDATE tenants SET byok_key_arn = 'arn:k', byok_status = 'active' WHERE id = $1`, [t]);
    mails.length = 0;
    await markKeyFailing(db, t, "arn:k", "AccessDenied");
    const byTo = Object.fromEntries(mails.map((m) => [m.to.split("-")[1], m]));
    expect(byTo.en.subject).toBe("FirmaYa: your organization's encryption key (BYOK) is not responding");
    expect(byTo.pt.subject).toContain("FirmaYa: a chave de criptografia");
    for (const m of mails) {
      expect(m.text).not.toContain("CalaSign");
      expect(m.text).toContain("AccessDenied");
    }
  });
});

describe("plantillas propias", () => {
  it("{{ message }} con espacios: el mensaje no se repite", async () => {
    const { render } = await import("../src/notifications/templates");
    const vars = { recipientName: "Ana", senderName: "Juan", organizationName: "ACME", subject: "NDA", message: "Mensaje único 42", link: "https://x/s/t" };
    const m = render("invite", "es", vars, { template: { body: "Hola\n\n{{ message }}" } });
    expect(m.text.split("Mensaje único 42").length - 1).toBe(1);
    expect(m.html.split("Mensaje único 42").length - 1).toBe(1);
    // Sin la variable: el mensaje se agrega una vez.
    const n = render("invite", "es", vars, { template: { body: "Hola" } });
    expect(n.text.split("Mensaje único 42").length - 1).toBe(1);
  });

  it("finalize_failed: {{code}} y {{reason}}; sin ninguno, se agrega la explicación de un documento que no se puede sellar", async () => {
    const { render } = await import("../src/notifications/templates");
    const vars = { recipientName: "Ana", senderName: "Juan", organizationName: "ACME", subject: "NDA", link: "https://x/app", unsealableCode: "pdf_form_unsupported" };
    const withCode = render("finalize_failed", "es", vars, { template: { body: "Falló el sellado (código {{code}})." } });
    expect(withCode.text).toContain("Falló el sellado (código pdf_form_unsupported).");
    expect(withCode.text).not.toContain("Reintentar no lo resuelve");
    const withReason = render("finalize_failed", "en", vars, { template: { body: "Problem: {{ reason }}" } });
    expect(withReason.text).toContain("Retrying won't fix it");
    const without = render("finalize_failed", "es", vars, { template: { body: "No se pudo terminar el sobre." } });
    expect(without.text).toContain("No se pudo terminar el sobre.");
    expect(without.text).toContain("pdf_form_unsupported");
    expect(without.text).toContain("Reintentar no lo resuelve");
    // Fallo transitorio (sin código): la plantilla propia queda como está.
    const transient = render("finalize_failed", "es", { ...vars, unsealableCode: null }, { template: { body: "No se pudo terminar el sobre." } });
    expect(transient.text).not.toContain("Reintentar");
  });
});

describe("quejas de SES", () => {
  it("not-spam no suprime la dirección", async () => {
    const { applySesEvent } = await import("../src/notifications/ses-feedback");
    const t = await newTenant();
    const ev = (type: string) => ({
      notificationType: "Complaint",
      mail: { messageId: `m-${type}`, tags: { tenant: [t] } },
      complaint: { complaintFeedbackType: type, complainedRecipients: [{ emailAddress: `${type}@x.com` }] },
    });
    expect(await applySesEvent(db, ev("not-spam"))).toBe("complaint_not_spam");
    expect(await db.one(`SELECT 1 FROM email_suppressions WHERE address = 'not-spam@x.com'`)).toBeFalsy();
    expect(await applySesEvent(db, ev("abuse"))).toBe("complaint");
    expect(await db.one(`SELECT 1 FROM email_suppressions WHERE address = 'abuse@x.com'`)).toBeTruthy();
  });
});

describe("canales de avisos", () => {
  it("el nombre del producto de la marca en lugar de CalaSign", async () => {
    const { discordPayload, googleChatPayload } = await import("../src/modules/notify-format");
    expect(discordPayload({ title: "x", product: "FirmaYa" }).username).toBe("FirmaYa");
    expect(googleChatPayload({ title: "x", product: "FirmaYa" }).cardsV2[0].card.header.subtitle).toBe("FirmaYa");
    expect(discordPayload({ title: "x" }).username).toBe("CalaSign");
  });
});
