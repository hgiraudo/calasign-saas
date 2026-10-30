// Firma importada (kind "uploaded") y firma dibujada en el celular (pase de firma, migración 0124): la evidencia dice
// cómo se hizo; el pase es de un solo uso, vence, no sirve para otro destinatario ni otro sobre, valida el PNG como
// una firma dibujada y manda el link por SMS (buzón de desarrollo) con sus topes. App real sobre PGlite.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-signature-handoff-"));
delete process.env.DATABASE_URL;

type Db = Awaited<ReturnType<(typeof import("../src/infra/db"))["createDb"]>>;
type App = Awaited<ReturnType<(typeof import("../src/app"))["buildApp"]>>;
let db: Db;
let app: App;
let tenant = "";

/** PNG en escala de grises con alfa (tipo 4), `ink` píxeles negros opacos y el resto transparentes. */
function png(w: number, h: number, ink: number, extra = 0): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 4;
  const raw = Buffer.alloc((w * 2 + 1) * h);
  let left = ink;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = y * (w * 2 + 1) + 1 + x * 2;
      raw[o] = 0;
      raw[o + 1] = left-- > 0 ? 255 : 0;
    }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // `extra`: bytes de relleno en un chunk auxiliar (para pasar el tope de tamaño con una imagen válida).
  const pad = extra ? [chunk("tEXt", Buffer.alloc(extra, 0x61))] : [];
  return Buffer.concat([sig, chunk("IHDR", ihdr), ...pad, chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}
const INKED = png(20, 10, 120);
const OTHER = png(20, 10, 150);
const PHONE_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 7) Celular de prueba";

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  const { uuidv7 } = await import("../src/lib/util");
  db = await createDb();
  await migrate(db);
  tenant = uuidv7();
  await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'T')`, [tenant, `t-${tenant.slice(-8)}`]);
  app = await buildApp({ db, blobs: createBlobStore(), logger: false });
  await app.ready();
}, 120_000);
afterAll(async () => {
  await app?.close();
  await db?.close();
});

async function setup(o: { consented?: boolean; authMethod?: string; envelope?: string } = {}) {
  const { randomToken, sha256Hex, uuidv7 } = await import("../src/lib/util");
  const envelope = o.envelope ?? uuidv7();
  const recipient = uuidv7();
  const token = randomToken();
  if (!o.envelope) await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status) VALUES ($1, $2, 'Contrato', 'sent')`, [envelope, tenant]);
  await db.query(
    `INSERT INTO recipients (id, tenant_id, envelope_id, role, name, email, status, access_token_hash, consented_at, auth_method)
     VALUES ($1,$2,$3,'signer','Ana','ana@x.test','viewed',$4,$5,$6)`,
    [recipient, tenant, envelope, sha256Hex(token), o.consented === false ? null : new Date(), o.authMethod ?? "link"],
  );
  return { envelope, recipient, token };
}

const signing = (token: string, path: string, method: "GET" | "POST" = "GET", payload?: unknown) =>
  app.inject({ method, url: `/v1/signing/${token}${path}`, payload: payload as any });
const phone = (handoffToken: string, method: "GET" | "POST" = "GET", payload?: unknown) =>
  app.inject({
    method,
    url: `/v1/public/signature-handoffs/${handoffToken}`,
    payload: payload as any,
    headers: { "user-agent": PHONE_UA },
    remoteAddress: "203.0.113.7",
  });
const tokenOf = (url: string) => url.split("/h/")[1]!;
const events = (envelope: string, type: string) =>
  db.query<any>(`SELECT * FROM envelope_events WHERE envelope_id = $1 AND type = $2 ORDER BY seq`, [envelope, type]);

describe("firma importada", () => {
  it("kind uploaded se acepta, queda en la firma adoptada y en la evidencia, y la cadena sigue íntegra", async () => {
    const s = await setup();
    const r = await signing(s.token, "/complete", "POST", { fields: [], signature: { kind: "uploaded", imagePng: INKED } });
    expect(r.statusCode).toBe(200);
    const adopted = await db.one<any>(`SELECT kind FROM adopted_signatures WHERE recipient_id = $1`, [s.recipient]);
    expect(adopted.kind).toBe("uploaded");
    const [signed] = await events(s.envelope, "recipient.signed");
    expect(signed.data.signature).toEqual([expect.objectContaining({ purpose: "signature", kind: "uploaded" })]);
    expect(signed.data.signature[0]).not.toHaveProperty("device");
    const { verifyChain } = await import("../src/infra/evidence");
    expect((await verifyChain(db, s.envelope)).ok).toBe(true);
  });

  it("una imagen importada vacía se rechaza igual que una dibujada", async () => {
    const s = await setup();
    const r = await signing(s.token, "/complete", "POST", { fields: [], signature: { kind: "uploaded", imagePng: png(20, 10, 3) } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("blank_signature");
  });
});

describe("firma dibujada en el celular (pase de firma)", () => {
  it("crear el pase, firmar en el celular, la computadora la recibe y la adopta; la evidencia registra el celular sin el token", async () => {
    const s = await setup();
    const c = await signing(s.token, "/signature-handoffs", "POST", {});
    expect(c.statusCode).toBe(201);
    const h = c.json();
    expect(h).toMatchObject({ purpose: "signature", sent: null });
    expect(h.url).toMatch(/\/h\/[A-Za-z0-9_-]{43}$/);
    expect(h.channels).toEqual(expect.arrayContaining(["sms", "whatsapp"]));
    const ht = tokenOf(h.url);
    const { sha256Hex } = await import("../src/lib/util");
    const row = await db.one<any>(`SELECT * FROM signature_handoffs WHERE id = $1`, [h.id]);
    // Guardado como hash (y cifrado para reenviarlo), nunca en claro; vence a los 10 minutos.
    expect(row.token_hash).toBe(sha256Hex(ht));
    expect(JSON.stringify(row)).not.toContain(ht);
    const ttl = (new Date(row.expires_at).getTime() - Date.now()) / 60_000;
    expect(ttl).toBeGreaterThan(9);
    expect(ttl).toBeLessThanOrEqual(10);

    const pending = await signing(s.token, `/signature-handoffs/${h.id}`);
    expect(pending.json()).toMatchObject({ status: "pending", imagePng: null });

    const info = await phone(ht);
    expect(info.statusCode).toBe(200);
    expect(info.json()).toEqual({ purpose: "signature", expiresAt: expect.any(String), locale: "es" });
    const sub = await phone(ht, "POST", { imagePng: INKED });
    expect(sub.statusCode).toBe(200);

    const got = await signing(s.token, `/signature-handoffs/${h.id}`);
    expect(got.json()).toMatchObject({ status: "submitted", imagePng: INKED });

    const done = await signing(s.token, "/complete", "POST", { fields: [], signature: { kind: "drawn", imagePng: INKED, handoffId: h.id } });
    expect(done.statusCode).toBe(200);
    const [drawn] = await events(s.envelope, "recipient.signature_handoff_submitted");
    expect(drawn).toMatchObject({ actor_type: "recipient", actor_id: s.recipient, ip: "203.0.113.7", user_agent: PHONE_UA });
    expect(drawn.data).toMatchObject({ handoffId: h.id, purpose: "signature" });
    const [signed] = await events(s.envelope, "recipient.signed");
    expect(signed.data.signature[0]).toMatchObject({
      kind: "drawn",
      device: { handoffId: h.id, ip: "203.0.113.7", userAgent: PHONE_UA, submittedAt: expect.any(String) },
    });
    const all = await db.query<any>(`SELECT * FROM envelope_events WHERE envelope_id = $1`, [s.envelope]);
    expect(JSON.stringify(all)).not.toContain(ht);
    // La imagen ya está en la firma adoptada: el pase no la guarda más.
    expect((await db.one<any>(`SELECT image_png FROM signature_handoffs WHERE id = $1`, [h.id])).image_png).toBeNull();
    const { verifyChain } = await import("../src/infra/evidence");
    expect((await verifyChain(db, s.envelope)).ok).toBe(true);
  });

  it("un solo uso: el segundo envío desde el celular da handoff_used", async () => {
    const s = await setup();
    const ht = tokenOf((await signing(s.token, "/signature-handoffs", "POST", {})).json().url);
    expect((await phone(ht, "POST", { imagePng: INKED })).statusCode).toBe(200);
    const again = await phone(ht, "POST", { imagePng: OTHER });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("handoff_used");
    expect((await phone(ht)).json().error.code).toBe("handoff_used");
  });

  it("vence: pasado el plazo el celular ve handoff_expired y no puede enviar; un pase nuevo deja sin efecto el anterior", async () => {
    const s = await setup();
    const h = (await signing(s.token, "/signature-handoffs", "POST", {})).json();
    await db.query(`UPDATE signature_handoffs SET expires_at = now() - interval '1 second' WHERE id = $1`, [h.id]);
    const info = await phone(tokenOf(h.url));
    expect(info.statusCode).toBe(410);
    expect(info.json().error.code).toBe("handoff_expired");
    expect((await phone(tokenOf(h.url), "POST", { imagePng: INKED })).statusCode).toBe(410);
    expect((await signing(s.token, `/signature-handoffs/${h.id}`)).json().status).toBe("expired");

    const a = (await signing(s.token, "/signature-handoffs", "POST", {})).json();
    const b = (await signing(s.token, "/signature-handoffs", "POST", {})).json();
    expect((await phone(tokenOf(a.url))).statusCode).toBe(410);
    expect((await phone(tokenOf(b.url))).statusCode).toBe(200);
  });

  it("no sirve para otro destinatario ni otro sobre", async () => {
    const a = await setup();
    const sameEnvelope = await setup({ envelope: a.envelope });
    const otherEnvelope = await setup();
    const h = (await signing(a.token, "/signature-handoffs", "POST", {})).json();
    expect((await phone(tokenOf(h.url), "POST", { imagePng: INKED })).statusCode).toBe(200);
    for (const other of [sameEnvelope, otherEnvelope]) {
      // Ni consultarlo ni adoptarlo desde la sesión de otro destinatario.
      expect((await signing(other.token, `/signature-handoffs/${h.id}`)).statusCode).toBe(404);
      const r = await signing(other.token, "/complete", "POST", { fields: [], signature: { kind: "drawn", imagePng: INKED, handoffId: h.id } });
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe("invalid_handoff");
    }
    // Y el dueño tampoco puede atribuirle al celular una imagen que no llegó por ese pase.
    const forged = await signing(a.token, "/complete", "POST", { fields: [], signature: { kind: "drawn", imagePng: OTHER, handoffId: h.id } });
    expect(forged.statusCode).toBe(400);
    expect(forged.json().error.code).toBe("invalid_handoff");
    expect(
      (await signing(a.token, "/complete", "POST", { fields: [], signature: { kind: "drawn", imagePng: INKED, handoffId: h.id } })).statusCode,
    ).toBe(200);
  });

  it("valida el PNG del celular como una firma dibujada: demasiado grande, vacío o que no es PNG", async () => {
    const s = await setup();
    const ht = tokenOf((await signing(s.token, "/signature-handoffs", "POST", {})).json().url);
    const big = await phone(ht, "POST", { imagePng: png(20, 10, 120, 710 * 1024) });
    expect(big.statusCode).toBe(400);
    expect(big.json().error).toMatchObject({ code: "invalid_image", message: expect.stringMatching(/demasiado grande/) });
    expect((await phone(ht, "POST", { imagePng: png(20, 10, 2) })).json().error.code).toBe("blank_signature");
    expect(
      (await phone(ht, "POST", { imagePng: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>".repeat(4)).toString("base64") })).json().error
        .code,
    ).toBe("invalid_image");
    // Nada de eso consumió el pase.
    expect((await phone(ht, "POST", { imagePng: INKED })).statusCode).toBe(200);
  });

  it("pide las mismas guardas que firmar: consentimiento y código OTP", async () => {
    const noConsent = await setup({ consented: false });
    const r1 = await signing(noConsent.token, "/signature-handoffs", "POST", {});
    expect(r1.statusCode).toBe(409);
    expect(r1.json().error.code).toBe("consent_required");
    const otp = await setup({ authMethod: "otp_sms" });
    const r2 = await signing(otp.token, "/signature-handoffs", "POST", {});
    expect(r2.statusCode).toBe(401);
    expect(r2.json().error.code).toBe("otp_required");
    expect(await db.query(`SELECT 1 FROM signature_handoffs WHERE recipient_id IN ($1, $2)`, [noConsent.recipient, otp.recipient])).toEqual([]);
    // Un token que no es de ningún pase: 404.
    expect((await phone("x".repeat(43))).statusCode).toBe(404);
  });

  it("manda el link por SMS (buzón de desarrollo) y respeta la espera entre envíos y el tope por destinatario", async () => {
    const s = await setup();
    const { readMailbox } = await import("../src/notifications/channels");
    const c = await signing(s.token, "/signature-handoffs", "POST", { channel: "sms", phone: "+5491122334455" });
    expect(c.statusCode).toBe(201);
    const h = c.json();
    expect(h.sent).toEqual({ channel: "sms", destination: "+549***55", resendInSeconds: 30 });
    const sms = (await readMailbox(tenant)).filter((m: any) => m.channel === "sms" && m.to === "+5491122334455");
    expect(sms).toHaveLength(1);
    expect(sms[0].text).toContain(h.url);
    const [sent] = await events(s.envelope, "recipient.signature_handoff_sent");
    expect(sent.data).toMatchObject({ handoffId: h.id, channel: "sms", destination: "+549***55" });
    expect(JSON.stringify(sent.data)).not.toContain(tokenOf(h.url));

    // Sin teléfono no se puede mandar por SMS (validación del contrato).
    expect((await signing(s.token, `/signature-handoffs/${h.id}/send`, "POST", { channel: "sms" })).statusCode).toBe(400);
    const again = await signing(s.token, `/signature-handoffs/${h.id}/send`, "POST", { channel: "sms", phone: "+5491122334455" });
    expect(again.statusCode).toBe(429);
    expect(again.json().error).toMatchObject({ code: "handoff_cooldown", details: { resendInSeconds: expect.any(Number) } });

    // Pasada la espera (se corren los envíos anteriores en el tiempo), hasta 5 por hora.
    const age = () =>
      db.query(`UPDATE signature_handoff_sends SET created_at = created_at - interval '40 seconds' WHERE recipient_id = $1`, [s.recipient]);
    for (let i = 2; i <= 5; i++) {
      await age();
      const r = await signing(s.token, `/signature-handoffs/${h.id}/send`, "POST", { channel: "sms", phone: `+54911223344${50 + i}` });
      expect(r.statusCode, `envío ${i}`).toBe(200);
    }
    await age();
    const limit = await signing(s.token, `/signature-handoffs/${h.id}/send`, "POST", { channel: "sms", phone: "+5491100000000" });
    expect(limit.statusCode).toBe(429);
    expect(limit.json().error.code).toBe("handoff_send_limit");
    expect((await readMailbox(tenant)).filter((m: any) => m.channel === "sms" && m.text.includes(h.url))).toHaveLength(5);
  });

  it("tope por destino: muchos firmantes no pueden llenar de mensajes el mismo teléfono", async () => {
    const { config } = await import("../src/config");
    const max = config.otp.maxPerDestinationHour;
    const to = "+5491199990000";
    for (let i = 0; i < max; i++) {
      const s = await setup();
      expect((await signing(s.token, "/signature-handoffs", "POST", { channel: "sms", phone: to })).statusCode, `envío ${i + 1}`).toBe(201);
    }
    const s = await setup();
    const r = await signing(s.token, "/signature-handoffs", "POST", { channel: "sms", phone: to });
    expect(r.statusCode).toBe(429);
    expect(r.json().error.code).toBe("handoff_destination_limit");
  });

  it("Telegram solo al chat vinculado: sin vincular, handoff_channel_unavailable", async () => {
    const s = await setup();
    const h = (await signing(s.token, "/signature-handoffs", "POST", {})).json();
    expect(h.channels).not.toContain("telegram");
    const r = await signing(s.token, `/signature-handoffs/${h.id}/send`, "POST", { channel: "telegram" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("handoff_channel_unavailable");
    await db.query(`UPDATE recipients SET telegram_chat_id = '123456789' WHERE id = $1`, [s.recipient]);
    const ok = await signing(s.token, `/signature-handoffs/${h.id}/send`, "POST", { channel: "telegram" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().channels).toContain("telegram");
    expect(ok.json().sent).toMatchObject({ channel: "telegram", destination: "Telegram" });
  });

  it("un pase pedido con un link anterior (se corrigió el contacto) no se consulta ni se adopta con el link nuevo", async () => {
    const s = await setup();
    const h = (await signing(s.token, "/signature-handoffs", "POST", {})).json();
    expect((await phone(tokenOf(h.url), "POST", { imagePng: INKED })).statusCode).toBe(200);
    // Corrección del contacto: el link de firma rota y el anterior deja de servir.
    const { randomToken, sha256Hex } = await import("../src/lib/util");
    const nuevo = randomToken();
    await db.query(`UPDATE recipients SET access_token_hash = $2 WHERE id = $1`, [s.recipient, sha256Hex(nuevo)]);
    expect((await signing(nuevo, `/signature-handoffs/${h.id}`)).statusCode).toBe(404);
    const r = await signing(nuevo, "/complete", "POST", { fields: [], signature: { kind: "drawn", imagePng: INKED, handoffId: h.id } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("invalid_handoff");
  });

  it("crear con channel: si el envío falla, el error trae el pase creado para copiar el link o reenviarlo", async () => {
    const s = await setup();
    expect((await signing(s.token, "/signature-handoffs", "POST", { channel: "sms", phone: "+5491122334400" })).statusCode).toBe(201);
    // Otro pase con envío enseguida: la espera de 30 s entre envíos lo frena, pero el pase nuevo ya existe.
    const r = await signing(s.token, "/signature-handoffs", "POST", { channel: "sms", phone: "+5491122334400" });
    expect(r.statusCode).toBe(429);
    const err = r.json().error;
    expect(err.code).toBe("handoff_cooldown");
    expect(err.details).toMatchObject({ resendInSeconds: expect.any(Number), handoff: { id: expect.any(String), sent: null } });
    expect(err.details.handoff.url).toMatch(/\/h\/[A-Za-z0-9_-]{43}$/);
    expect((await signing(s.token, `/signature-handoffs/${err.details.handoff.id}`)).json().status).toBe("pending");
    expect((await phone(tokenOf(err.details.handoff.url))).statusCode).toBe(200);
  });

  it("marca blanca: el SMS con el link sale con el remitente de la marca del sobre, como el código OTP", async () => {
    const { uuidv7 } = await import("../src/lib/util");
    const { config } = await import("../src/config");
    const { readMailbox } = await import("../src/notifications/channels");
    const brand = uuidv7();
    await db.query(`INSERT INTO brands (id, tenant_id, name, slug, config) VALUES ($1,$2,'Acme',$3,$4)`, [
      brand,
      tenant,
      `acme-${brand.slice(-8)}`,
      JSON.stringify({ sms: { senderId: "ACME" } }),
    ]);
    const envelope = uuidv7();
    await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status, brand_id) VALUES ($1, $2, 'Contrato', 'sent', $3)`, [
      envelope,
      tenant,
      brand,
    ]);
    const s = await setup({ envelope });
    config.sms.alphanumericAllowedTenants.push(tenant);
    try {
      const c = await signing(s.token, "/signature-handoffs", "POST", { channel: "sms", phone: "+5491122334411" });
      expect(c.statusCode).toBe(201);
      const sms = (await readMailbox(tenant)).filter((m: any) => m.channel === "sms" && m.text.includes(c.json().url));
      expect(sms).toHaveLength(1);
      expect(sms[0].from).toBe("ACME");
    } finally {
      config.sms.alphanumericAllowedTenants.length = 0;
    }
  });

  it("barrido: una firma que llegó y no se adoptó espera 7 días; lo demás se borra pasado un día", async () => {
    const mk = async (age: string, image: boolean) => {
      const s = await setup();
      const h = (await signing(s.token, "/signature-handoffs", "POST", {})).json();
      if (image) expect((await phone(tokenOf(h.url), "POST", { imagePng: INKED })).statusCode).toBe(200);
      await db.query(`UPDATE signature_handoffs SET created_at = now() - $2::interval WHERE id = $1`, [h.id, age]);
      return h.id as string;
    };
    const fresh = await mk("1 hour", false);
    const oldNoImage = await mk("2 days", false);
    const oldWithImage = await mk("2 days", true);
    const ancientWithImage = await mk("8 days", true);
    const { sweep } = await import("../src/modules/jobs");
    const { createBlobStore } = await import("../src/infra/storage");
    await sweep({ db, blobs: createBlobStore(), log: { info() {}, warn() {}, error() {} } } as any);
    const left = (
      await db.query<{ id: string }>(`SELECT id FROM signature_handoffs WHERE id = ANY($1)`, [[fresh, oldNoImage, oldWithImage, ancientWithImage]])
    ).map((r) => r.id);
    expect(left.sort()).toEqual([fresh, oldWithImage].sort());
  });

  it("la espera cuenta por firmante: varios firmantes detrás de la misma IP no se reparten el tope; tokens inventados sí topan", async () => {
    const office = "198.51.100.20";
    const poll = (token: string, id: string, ip = office) =>
      app.inject({ method: "GET", url: `/v1/signing/${token}/signature-handoffs/${id}`, remoteAddress: ip });
    const a = await setup();
    const b = await setup();
    const ha = (await signing(a.token, "/signature-handoffs", "POST", {})).json();
    const hb = (await signing(b.token, "/signature-handoffs", "POST", {})).json();
    // A espera su firma 3 minutos de consultas seguidas (90 por minuto): no se corta.
    const codes = await Promise.all(Array.from({ length: 90 }, () => poll(a.token, ha.id).then((r) => r.statusCode)));
    expect(codes.every((c) => c === 200)).toBe(true);
    // B, desde la misma oficina, sigue pudiendo esperar la suya (por IP, a partir del cuarto firmante daba 429).
    expect((await poll(b.token, hb.id)).statusCode).toBe(200);
    // A se pasa de su cupo: 429 con el código estable.
    const over = await poll(a.token, ha.id);
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe("rate_limited");

    // Cada token inventado tendría su propio cupo: el techo por IP (600 por minuto) los frena igual.
    const { randomToken } = await import("../src/lib/util");
    const scanner = "198.51.100.66";
    const fake = await Promise.all(Array.from({ length: 600 }, () => poll(randomToken(), ha.id, scanner).then((r) => r.statusCode)));
    expect(fake.every((c) => c === 404)).toBe(true);
    expect((await poll(randomToken(), ha.id, scanner)).statusCode).toBe(429);
  }, 60_000);
});
