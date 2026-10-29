// POST /v1/signing/:token/complete sobre PGlite: la lógica no confía en valores inventados para adjuntos, firmas y
// automáticos; el 422 trae ids y tipos de los campos; firmas en blanco rechazadas; el texto solo en firmas escritas;
// y el chequeo previo sin bloqueo evita subir imágenes de un pedido que igual va a fallar.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-signing-complete-"));
delete process.env.DATABASE_URL;

type Db = Awaited<ReturnType<(typeof import("../src/infra/db"))["createDb"]>>;
type App = Awaited<ReturnType<(typeof import("../src/app"))["buildApp"]>>;
let db: Db;
let app: App;
let tenant = "";
let puts = 0;

/** PNG en escala de grises con alfa (tipo 4), `ink` píxeles negros opacos y el resto transparentes. */
function png(w: number, h: number, ink: number): string {
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
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}
const INKED = png(20, 10, 120);

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  const { uuidv7 } = await import("../src/lib/util");
  db = await createDb();
  await migrate(db);
  tenant = uuidv7();
  await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'T')`, [tenant, `t-${tenant.slice(-8)}`]);
  const real = createBlobStore();
  // Cuenta las subidas: el chequeo previo tiene que cortar antes de subir la firma.
  const blobs = new Proxy(real, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (prop === "put" && typeof v === "function")
        return (...args: unknown[]) => {
          puts++;
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  app = await buildApp({ db, blobs, logger: false });
  await app.ready();
}, 120_000);
afterAll(async () => {
  await app?.close();
  await db?.close();
});

type FieldSpec = { type: string; required?: boolean; label?: string | null; conditions?: unknown; key: string };

async function setup(fields: FieldSpec[], o: { consented?: boolean } = {}) {
  const { randomToken, sha256Hex, uuidv7 } = await import("../src/lib/util");
  const envelope = uuidv7();
  const recipient = uuidv7();
  const token = randomToken();
  await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status) VALUES ($1, $2, 'Contrato', 'sent')`, [envelope, tenant]);
  await db.query(
    `INSERT INTO recipients (id, tenant_id, envelope_id, role, name, email, status, access_token_hash, consented_at)
     VALUES ($1,$2,$3,'signer','Ana','ana@x.test','viewed',$4,$5)`,
    [recipient, tenant, envelope, sha256Hex(token), o.consented === false ? null : new Date()],
  );
  const file = uuidv7();
  const doc = uuidv7();
  await db.query(
    `INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'original','k','application/pdf',1,'h')`,
    [file, tenant],
  );
  await db.query(
    `INSERT INTO documents (id, tenant_id, envelope_id, position, name, file_id, page_count, pages) VALUES ($1,$2,$3,1,'c.pdf',$4,1,$5)`,
    [doc, tenant, envelope, file, JSON.stringify([{ width: 600, height: 800 }])],
  );
  const ids: Record<string, string> = {};
  for (const f of fields) ids[f.key] = uuidv7();
  let y = 0;
  for (const f of fields) {
    const conds = f.conditions
      ? JSON.stringify(
          (f.conditions as { fieldKey: string; operator: string; value?: string }[]).map((c) => ({
            fieldId: ids[c.fieldKey],
            operator: c.operator,
            value: c.value ?? null,
          })),
        )
      : null;
    await db.query(
      `INSERT INTO fields (id, tenant_id, envelope_id, document_id, recipient_id, type, page, x, y, width, height, required, label, conditions)
       VALUES ($1,$2,$3,$4,$5,$6,0,0.1,$7,0.3,0.05,$8,$9,$10)`,
      [ids[f.key], tenant, envelope, doc, recipient, f.type, (y += 0.06), f.required ?? true, f.label ?? null, conds],
    );
  }
  return { envelope, recipient, token, ids };
}

const complete = (token: string, payload: unknown) => app.inject({ method: "POST", url: `/v1/signing/${token}/complete`, payload: payload as any });

describe("completar: la lógica usa lo que el servidor va a guardar", () => {
  it("un adjunto sin archivo o un nombre inventado no muestran campos condicionados", async () => {
    const s = await setup([
      { key: "att", type: "attachment", required: false },
      { key: "name", type: "name" },
      { key: "t1", type: "text", label: "Detalle del adjunto", conditions: [{ fieldKey: "att", operator: "filled" }] },
      { key: "t2", type: "text", label: "Solo Hacker", conditions: [{ fieldKey: "name", operator: "equals", value: "Hacker" }] },
    ]);
    // Antes: los valores enviados ("x" en el adjunto sin archivo, "Hacker" en el nombre) mostraban t1 y t2, obligatorios.
    const r = await complete(s.token, {
      fields: [
        { id: s.ids.att, value: "x.pdf" },
        { id: s.ids.name, value: "Hacker" },
      ],
    });
    expect(r.statusCode).toBe(200);
    const rows = await db.query<any>(`SELECT id, hidden, value FROM fields WHERE recipient_id = $1`, [s.recipient]);
    const by = new Map(rows.map((x) => [x.id, x]));
    expect(by.get(s.ids.t1).hidden).toBe(true);
    expect(by.get(s.ids.t2).hidden).toBe(true);
    expect(by.get(s.ids.name).value).toBe("Ana");
    expect(by.get(s.ids.att).value).toBeNull();
  });

  it("una firma no adoptada no cuenta como completa para las condiciones", async () => {
    const s = await setup([
      { key: "sig", type: "signature" },
      { key: "t1", type: "text", label: "Tras firmar", conditions: [{ fieldKey: "sig", operator: "filled" }] },
    ]);
    const r = await complete(s.token, { fields: [{ id: s.ids.sig, value: "signed" }] });
    expect(r.statusCode).toBe(422);
    // Falta la firma, no el texto condicionado (que sin firma queda oculto).
    expect(r.json().error.details.fields).toEqual([{ id: s.ids.sig, type: "signature", label: null }]);
  });
});

describe("completar: 422 con ids, tipos y etiquetas", () => {
  it("fields_incomplete conserva el mensaje y `missing`, y agrega `fields`", async () => {
    const s = await setup([
      { key: "t", type: "text" },
      { key: "c", type: "checkbox", label: "Acepto" },
    ]);
    const r = await complete(s.token, { fields: [] });
    expect(r.statusCode).toBe(422);
    const err = r.json().error;
    expect(err.code).toBe("fields_incomplete");
    expect(err.message).toBe("Faltan completar: Texto, Acepto");
    expect(err.details.missing).toEqual(["Texto", "Acepto"]);
    expect(err.details.fields).toEqual([
      { id: s.ids.t, type: "text", label: null },
      { id: s.ids.c, type: "checkbox", label: "Acepto" },
    ]);
  });

  it("fields_invalid trae los campos con su error", async () => {
    const s = await setup([{ key: "n", type: "number", label: "Monto" }]);
    const r = await complete(s.token, { fields: [{ id: s.ids.n, value: "abc" }] });
    expect(r.statusCode).toBe(422);
    const err = r.json().error;
    expect(err.code).toBe("fields_invalid");
    expect(err.details.invalid).toHaveLength(1);
    expect(err.details.fields).toEqual([{ id: s.ids.n, type: "number", label: "Monto", error: expect.any(String) }]);
  });
});

describe("completar: imagen de la firma", () => {
  it("rechaza una firma transparente o de un punto", async () => {
    const s = await setup([{ key: "sig", type: "signature" }]);
    for (const img of [png(20, 10, 0), png(20, 10, 3)]) {
      const r = await complete(s.token, { fields: [], signature: { kind: "drawn", imagePng: img } });
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe("blank_signature");
    }
    const ok = await complete(s.token, { fields: [], signature: { kind: "drawn", imagePng: INKED } });
    expect(ok.statusCode).toBe(200);
  });

  it("el texto se guarda solo en una firma escrita", async () => {
    const a = await setup([{ key: "sig", type: "signature" }]);
    expect((await complete(a.token, { fields: [], signature: { kind: "drawn", imagePng: INKED, text: "Otra persona" } })).statusCode).toBe(200);
    expect((await db.one<any>(`SELECT kind, text FROM adopted_signatures WHERE recipient_id = $1`, [a.recipient])).text).toBeNull();
    const b = await setup([{ key: "sig", type: "signature" }]);
    expect((await complete(b.token, { fields: [], signature: { kind: "typed", imagePng: INKED, text: " Ana " } })).statusCode).toBe(200);
    expect(await db.one<any>(`SELECT kind, text FROM adopted_signatures WHERE recipient_id = $1`, [b.recipient])).toEqual({
      kind: "typed",
      text: "Ana",
    });
  });
});

describe("completar: chequeo previo sin bloqueo", () => {
  it("sin consentimiento o ya firmado no sube la firma", async () => {
    const s = await setup([{ key: "sig", type: "signature" }], { consented: false });
    const before = puts;
    const r = await complete(s.token, { fields: [], signature: { kind: "drawn", imagePng: INKED } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("consent_required");
    expect(puts).toBe(before);

    // Ya firmado (con el sobre todavía abierto por otros firmantes).
    const done = await setup([{ key: "sig", type: "signature" }]);
    await db.query(`UPDATE recipients SET status = 'signed', signed_at = now() WHERE id = $1`, [done.recipient]);
    const mid = puts;
    const again = await complete(done.token, { fields: [], signature: { kind: "drawn", imagePng: INKED } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("already_signed");
    expect(puts).toBe(mid);
  });
});

describe("completar: iniciales y automáticos en la lógica (mismo criterio que la web)", () => {
  it("con sólo la firma adoptada las iniciales cuentan como firmadas (es lo que se estampa)", async () => {
    const s = await setup([
      { key: "sig", type: "signature" },
      { key: "ini", type: "initials" },
      { key: "t1", type: "text", label: "Tras iniciales", conditions: [{ fieldKey: "ini", operator: "filled" }] },
      { key: "t2", type: "text", label: "Si es Ana", conditions: [{ fieldKey: "name", operator: "equals", value: "Ana" }] },
      { key: "name", type: "name" },
    ]);
    const r = await complete(s.token, { fields: [], signature: { kind: "drawn", imagePng: INKED } });
    expect(r.statusCode).toBe(422);
    // Visibles (y obligatorios) los dos condicionados: iniciales "firmadas" con la firma y el nombre automático.
    expect(
      r
        .json()
        .error.details.fields.map((f: { id: string }) => f.id)
        .sort(),
    ).toEqual([s.ids.t1, s.ids.t2].sort());
  });

  it("signerFixedLogicValue: firma, iniciales y automáticos", async () => {
    const { signerFixedLogicValue } = await import("@calasign/shared");
    const st = (hasSignature: boolean, hasInitials: boolean) => ({ hasSignature, hasInitials, autoValue: (t: string) => `auto:${t}` });
    expect(signerFixedLogicValue("initials", st(true, false))).toBe("signed");
    expect(signerFixedLogicValue("initials", st(false, false))).toBeNull();
    expect(signerFixedLogicValue("signature", st(false, true))).toBeNull();
    expect(signerFixedLogicValue("date_signed", st(false, false))).toBe("auto:date_signed");
    expect(signerFixedLogicValue("text", st(true, true))).toBeUndefined();
  });
});

describe("rechazar: la evidencia dice si la identidad estaba verificada o confirmada", () => {
  const lastDecline = (envelope: string) =>
    db.one<any>(`SELECT actor_type, actor_id, actor_label, data FROM envelope_events WHERE envelope_id = $1 AND type = 'recipient.declined'`, [
      envelope,
    ]);

  it("KYC pendiente: se puede rechazar y queda identityVerified: false", async () => {
    const s = await setup([{ key: "sig", type: "signature" }]);
    await db.query(`UPDATE recipients SET id_verification_provider = 'mock', identity_status = 'pending' WHERE id = $1`, [s.recipient]);
    const r = await app.inject({ method: "POST", url: `/v1/signing/${s.token}/decline`, payload: { reason: "No quiero verificar" } });
    expect(r.statusCode).toBe(200);
    const ev = await lastDecline(s.envelope);
    expect(ev.actor_type).toBe("recipient");
    expect(ev.data).toMatchObject({ reason: "No quiero verificar", recipientId: s.recipient, identityVerified: false });
    expect(ev.data).not.toHaveProperty("inPersonConfirmed");
  });

  it("sin KYC: identityVerified null", async () => {
    const s = await setup([{ key: "sig", type: "signature" }]);
    expect((await app.inject({ method: "POST", url: `/v1/signing/${s.token}/decline`, payload: { reason: "No" } })).statusCode).toBe(200);
    expect((await lastDecline(s.envelope)).data.identityVerified).toBeNull();
  });

  async function inPerson(confirmed: boolean) {
    const { randomToken, sha256Hex, uuidv7 } = await import("../src/lib/util");
    const s = await setup([{ key: "sig", type: "signature" }]);
    const host = uuidv7();
    await db.query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, 'Hugo Host', 'x')`, [host, `host-${host.slice(-6)}@x.test`]);
    await db.query(`UPDATE recipients SET auth_method = 'in_person', in_person_host_user_id = $2, identity_confirmed_at = $3 WHERE id = $1`, [
      s.recipient,
      host,
      confirmed ? new Date() : null,
    ]);
    const cookie = randomToken();
    await db.query(
      `INSERT INTO signer_sessions (token_hash, recipient_id, method, ip, expires_at) VALUES ($1,$2,'in_person','127.0.0.1', now() + interval '1 hour')`,
      [sha256Hex(cookie), s.recipient],
    );
    const r = await app.inject({ method: "POST", url: `/v1/signing/${s.token}/decline`, payload: { reason: "No" }, cookies: { cs_signer: cookie } });
    expect(r.statusCode).toBe(200);
    return { ...s, host, ev: await lastDecline(s.envelope) };
  }

  it("en persona sin identidad confirmada: el actor es el anfitrión", async () => {
    const { ev, host, recipient } = await inPerson(false);
    expect(ev.actor_type).toBe("user");
    expect(ev.actor_id).toBe(host);
    expect(ev.actor_label).toContain("Hugo Host");
    expect(ev.data).toMatchObject({ recipientId: recipient, inPersonConfirmed: false, actorRole: "in_person_host", recipient: "Ana <ana@x.test>" });
  });

  it("en persona con identidad confirmada: el actor es el firmante", async () => {
    const { ev, recipient } = await inPerson(true);
    expect(ev.actor_type).toBe("recipient");
    expect(ev.actor_id).toBe(recipient);
    expect(ev.data).toMatchObject({ inPersonConfirmed: true });
    expect(ev.data).not.toHaveProperty("actorRole");
  });
});
