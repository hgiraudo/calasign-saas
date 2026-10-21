// Barridos y cola: prioridad 0 sin esperar al masivo, jobs dados por fallados con el worker muerto (finalización,
// masivo, webhook), respaldo durable de finalize_failed, retención y vencimiento que no se traban con un sobre que
// falla siempre, recordatorios (primer recordatorio a tiempo, etapa de certificados) y borrado de archivos durable.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-sweep-rob-"));
delete process.env.DATABASE_URL;

const { createDb, migrate } = await import("../src/infra/db");
const { uuidv7 } = await import("../src/lib/util");
const Q = await import("../src/infra/queue");
const jobs = await import("../src/modules/jobs");
const { purgeExpiredEnvelopes } = await import("../src/modules/retention");
const { runAutomaticReminders } = await import("../src/modules/reminders");
const FC = await import("../src/modules/file-cleanup");

type Db = Awaited<ReturnType<typeof createDb>>;
let db: Db;
const log = { info() {}, warn() {}, error() {} };

beforeAll(async () => {
  db = await createDb();
  await migrate(db);
}, 180_000);
afterAll(async () => db?.close());

const until = async (cond: () => Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timeout esperando la condición");
    await new Promise((r) => setTimeout(r, 20));
  }
};

async function tenant(extra = "") {
  const id = uuidv7();
  await db.query(`INSERT INTO tenants (id, slug, name${extra ? ", retention_days" : ""}) VALUES ($1, $2, 'T'${extra ? ", 30" : ""})`, [id, `t-${id.slice(-12)}`]);
  return id;
}

describe("toma de jobs", () => {
  it("los de prioridad 0 (webhooks, plataforma, acuerdos) no esperan detrás de un atraso de masivos", async () => {
    expect(Q.URGENT_PRIORITIES).toEqual([20, 10, 5, 2, 0]);
    await db.query(`DELETE FROM jobs`);
    await db.query(
      `INSERT INTO jobs (queue, payload, run_at, priority) SELECT 'bulk', jsonb_build_object('n', g), now() - interval '1 hour' + g * interval '1 second', -10 FROM generate_series(1, 30) g`,
    );
    await db.query(`INSERT INTO jobs (queue, payload, run_at, priority) VALUES ('webhook', '{"kind":"fanout"}', now() - interval '1 second', 0)`);
    const order: string[] = [];
    const worker = Q.startWorker(db, {
      handlers: { bulk: async (p: any) => void order.push(`bulk${p.n}`), webhook: async () => void order.push("webhook") } as any,
      concurrency: 1,
      claimCandidates: 3,
      pollMs: 20,
      log,
    });
    try {
      await until(async () => order.length >= 2);
      expect(order[0]).toBe("webhook");
    } finally {
      await worker.stop();
      await db.query(`DELETE FROM jobs`);
    }
  }, 60_000);
});

describe("jobs dados por fallados con el worker muerto", () => {
  it("finalización: un aviso que falla no pierde los demás; el respaldo durable lo registra una sola vez", async () => {
    const t = await tenant();
    const envs = [uuidv7(), uuidv7()];
    for (const e of envs) await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status) VALUES ($1, $2, 'S', 'finalizing')`, [e, t]);
    for (const e of envs) {
      await db.query(
        `INSERT INTO jobs (queue, payload, status, attempts, max_attempts, locked_at, dedupe_key) VALUES ('finalize', $1, 'running', 8, 8, now() - interval '11 minutes', $2)`,
        [JSON.stringify({ envelopeId: e, tenantId: t }), `finalize:${e}`],
      );
    }
    // La base falla para el primer sobre al registrar el fallo (como una caída breve): el segundo igual se registra.
    let broke = false;
    const flaky: Db = {
      ...db,
      tx: (fn) =>
        db.tx((tt) =>
          fn({
            ...tt,
            one: async (sql: string, params?: unknown[]) => {
              if (!broke && /FOR UPDATE/.test(sql) && params?.[0] === envs[0]) {
                broke = true;
                throw new Error("conexión cortada");
              }
              return tt.one(sql, params);
            },
          } as Db),
        ),
    };
    const errors: string[] = [];
    await jobs.requeueStuckJobsAndClose({ db: flaky, blobs: {} as any, log: { ...log, error: (_o: object, m?: string) => void errors.push(String(m)) } });
    expect(broke).toBe(true);
    expect(errors).toContain("no se pudo cerrar un job dado por fallado");
    const failedEv = async (e: string) => (await db.query(`SELECT 1 FROM envelope_events WHERE envelope_id = $1 AND type = 'envelope.finalize_failed'`, [e])).length;
    expect(await failedEv(envs[0])).toBe(0);
    expect(await failedEv(envs[1])).toBe(1);

    // Respaldo: el primero se registra; el segundo (ya avisado) no se repite. Idempotente.
    await jobs.sweepUnreportedFinalizeFailures({ db, blobs: {} as any, log });
    await jobs.sweepUnreportedFinalizeFailures({ db, blobs: {} as any, log });
    expect(await failedEv(envs[0])).toBe(1);
    expect(await failedEv(envs[1])).toBe(1);
    const notices = await db.query<any>(`SELECT payload->>'envelopeId' AS e FROM jobs WHERE queue = 'notify' AND payload->>'kind' = 'finalize_failed'`);
    expect(notices.map((n) => n.e).sort()).toEqual([...envs].sort());

    // Un reintento manual pendiente: el respaldo no lo toca hasta que falle también.
    await db.query(`INSERT INTO jobs (queue, payload, status, dedupe_key) VALUES ('finalize', $1, 'pending', $2)`, [JSON.stringify({ envelopeId: envs[0], tenantId: t }), `finalize:${envs[0]}:retry:1`]);
    expect(await jobs.sweepUnreportedFinalizeFailures({ db, blobs: {} as any, log })).toBe(0);
    await db.query(`UPDATE jobs SET status = 'failed', finished_at = now() WHERE dedupe_key = $1`, [`finalize:${envs[0]}:retry:1`]);
    expect(await jobs.sweepUnreportedFinalizeFailures({ db, blobs: {} as any, log })).toBe(1);
    expect(await failedEv(envs[0])).toBe(2);
    await db.query(`DELETE FROM jobs`);
  }, 60_000);

  it("masivo y webhook: el barrido cierra las filas del masivo y la entrega del webhook", async () => {
    const t = await tenant();
    const bulk = uuidv7();
    const items = [uuidv7(), uuidv7()];
    await db.query(
      `INSERT INTO bulk_sends (id, tenant_id, template_name, status, total, options, actor) VALUES ($1, $2, 'P', 'running', 2, '{}', '{"type":"system"}')`,
      [bulk, t],
    );
    for (const [i, it] of items.entries()) {
      await db.query(`INSERT INTO bulk_send_items (id, tenant_id, bulk_send_id, row_number, input, status) VALUES ($1, $2, $3, $4, '{}', 'pending')`, [it, t, bulk, i + 1]);
    }
    const ep = uuidv7();
    const del = uuidv7();
    await db.query(`INSERT INTO webhook_endpoints (id, tenant_id, url, secret_enc, secret_prefix) VALUES ($1, $2, 'https://x', 'e', 'whsec_')`, [ep, t]);
    await db.query(
      `INSERT INTO webhook_deliveries (id, tenant_id, endpoint_id, event_id, event_type, payload, status) VALUES ($1, $2, $3, $4, 'envelope.sent', '{}', 'pending')`,
      [del, t, ep, uuidv7()],
    );
    const stuck = (queue: string, payload: unknown) =>
      db.query(`INSERT INTO jobs (queue, payload, status, attempts, max_attempts, locked_at) VALUES ($1, $2, 'running', 8, 8, now() - interval '11 minutes')`, [
        queue,
        JSON.stringify(payload),
      ]);
    await stuck("bulk", { bulkSendId: bulk, tenantId: t, itemIds: items, retryRound: 0 });
    await stuck("webhook", { kind: "deliver", deliveryId: del });

    await jobs.requeueStuckJobsAndClose({ db, blobs: {} as any, log });
    expect((await db.one<any>(`SELECT status FROM bulk_sends WHERE id = $1`, [bulk]))?.status).toBe("completed");
    const rows = await db.query<any>(`SELECT status, error FROM bulk_send_items WHERE bulk_send_id = $1`, [bulk]);
    expect(rows.every((r) => r.status === "failed" && /worker se detuvo/.test(r.error))).toBe(true);
    expect((await db.one<any>(`SELECT status, next_retry_at FROM webhook_deliveries WHERE id = $1`, [del]))).toMatchObject({ status: "failed", next_retry_at: null });
    await db.query(`DELETE FROM jobs`);
  }, 60_000);
});

describe("retención y vencimiento", () => {
  it("un sobre que falla siempre no traba la retención: se registra el error y se saltea por unas horas", async () => {
    const t = await tenant("ret");
    const mk = async (daysAgo: number) => {
      const env = uuidv7();
      const f = uuidv7();
      await db.query(`INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'original',$3,'application/pdf',1,'x')`, [f, t, `k-${f}`]);
      await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status, completed_at) VALUES ($1,$2,'S','completed', now() - make_interval(days => $3))`, [env, t, daysAgo]);
      await db.query(`INSERT INTO documents (id, tenant_id, envelope_id, position, name, file_id, page_count, pages) VALUES ($1,$2,$3,1,'d.pdf',$4,1,'[]')`, [uuidv7(), t, env, f]);
      return { env, key: `k-${f}` };
    };
    const bad = await mk(90); // el más viejo: primero en el orden
    const good = await mk(60);
    const blobs = {
      delete: async (k: string) => {
        if (k === bad.key) throw new Error("almacenamiento: acceso denegado");
      },
    };
    const r = await purgeExpiredEnvelopes({ db, blobs: blobs as any, log }, { tenantId: t, limit: 1 });
    expect(r).toMatchObject({ purged: 0, failed: 1 });
    const b = await db.one<any>(`SELECT retention_attempted_at, retention_error, purged_at FROM envelopes WHERE id = $1`, [bad.env]);
    expect(b.retention_attempted_at).not.toBeNull();
    expect(b.retention_error).toMatch(/archivo/);
    expect(b.purged_at).toBeNull();
    // Con tanda de 1, la siguiente pasada toma el otro (antes volvía a tomar el que falla, para siempre).
    expect((await purgeExpiredEnvelopes({ db, blobs: blobs as any, log }, { tenantId: t, limit: 1 })).purged).toBe(1);
    expect((await db.one<any>(`SELECT purged_at FROM envelopes WHERE id = $1`, [good.env]))?.purged_at).not.toBeNull();
    // Pasadas las 6 h se vuelve a intentar.
    await db.query(`UPDATE envelopes SET retention_attempted_at = now() - interval '7 hours' WHERE id = $1`, [bad.env]);
    expect((await purgeExpiredEnvelopes({ db, blobs: { delete: async () => {} } as any, log }, { tenantId: t, limit: 1 })).purged).toBe(1);
  }, 60_000);

  it("vencimiento: un sobre que falla queda marcado y no frena a los demás en la próxima pasada", async () => {
    const t = await tenant();
    const bad = uuidv7();
    const good = uuidv7();
    await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status, expires_at) VALUES ($1,$2,'S','sent', now() - interval '2 days')`, [bad, t]);
    await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status, expires_at) VALUES ($1,$2,'S','sent', now() - interval '1 day')`, [good, t]);
    const flaky: Db = {
      ...db,
      tx: (fn) =>
        db.tx((tt) =>
          fn({
            ...tt,
            one: async (sql: string, params?: unknown[]) => {
              if (/FOR UPDATE/.test(sql) && params?.[0] === bad) throw new Error("integración rota");
              return tt.one(sql, params);
            },
          } as Db),
        ),
    };
    await jobs.expireDueEnvelopes({ db: flaky, blobs: { delete: async () => {} } as any, log });
    const st = async (id: string) => db.one<any>(`SELECT status, sweep_failed_at FROM envelopes WHERE id = $1`, [id]);
    expect((await st(bad))?.sweep_failed_at).not.toBeNull();
    expect((await st(good))?.status).toBe("expired");
    // Dentro de la hora no se vuelve a tomar.
    const seen: string[] = [];
    const spy: Db = { ...db, tx: (fn) => db.tx((tt) => fn({ ...tt, one: async (sql: string, p?: unknown[]) => (seen.push(String(p?.[0])), tt.one(sql, p)) } as Db)) };
    await jobs.expireDueEnvelopes({ db: spy, blobs: {} as any, log });
    expect(seen).not.toContain(bad);
  }, 60_000);
});

describe("recordatorios", () => {
  it("sin nadie a quien recordarle todavía, el primer recordatorio llega a los N días de la invitación (no 2N)", async () => {
    const t = await tenant();
    const env = uuidv7();
    const a = uuidv7();
    const b = uuidv7();
    const now = new Date("2027-03-10T12:00:00Z");
    const at = (days: number) => new Date(now.getTime() + days * 86400_000);
    // Sobre enviado hace 5 días; el turno actual (orden 2) se activó hace 1 día: todavía no le toca.
    await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status, sent_at, reminder_every_days) VALUES ($1,$2,'S','sent',$3,3)`, [env, t, at(-5).toISOString()]);
    await db.query(`INSERT INTO recipients (id, tenant_id, envelope_id, role, routing_order, name, email, status, sent_at) VALUES ($1,$2,$3,'signer',1,'A','a@x.com','signed',$4)`, [a, t, env, at(-5).toISOString()]);
    await db.query(`INSERT INTO recipients (id, tenant_id, envelope_id, role, routing_order, name, email, status, sent_at) VALUES ($1,$2,$3,'signer',2,'B','b@x.com','sent',$4)`, [b, t, env, at(-1).toISOString()]);
    expect((await runAutomaticReminders(db, now)).reminded).toBe(0);
    // last_reminder_at quedó en la invitación de B: el sobre no se vuelve a mirar hasta que le toque.
    expect(new Date((await db.one<any>(`SELECT last_reminder_at FROM envelopes WHERE id = $1`, [env]))!.last_reminder_at).getTime()).toBe(at(-1).getTime());
    expect((await runAutomaticReminders(db, at(1))).reminded).toBe(0);
    // A los 3 días de su invitación (no a los 3 días de la pasada anterior).
    expect((await runAutomaticReminders(db, new Date(at(2).getTime() + 1000))).reminded).toBe(1);
    const q = await db.query<any>(`SELECT payload FROM jobs WHERE payload->>'envelopeId' = $1`, [env]);
    expect(q.map((j) => [j.payload.kind, j.payload.recipientId])).toEqual([["reminder", b]]);
  }, 60_000);

  it("esperando firmas con certificado: recordatorio (pedido de certificado) y aviso de vencimiento al firmante pendiente", async () => {
    const t = await tenant();
    const env = uuidv7();
    const r1 = uuidv7();
    const r2 = uuidv7();
    const now = new Date("2027-04-10T12:00:00Z");
    const at = (days: number) => new Date(now.getTime() + days * 86400_000).toISOString();
    await db.query(
      `INSERT INTO envelopes (id, tenant_id, subject, status, sent_at, expires_at, reminder_every_days, expiry_warning_days) VALUES ($1,$2,'S','awaiting_certificates',$3,$4,2,3)`,
      [env, t, at(-10), at(2)],
    );
    for (const [i, r] of [r1, r2].entries()) {
      await db.query(`INSERT INTO recipients (id, tenant_id, envelope_id, role, routing_order, name, email, status, sent_at) VALUES ($1,$2,$3,'signer',1,$4,$5,'signed',$6)`, [
        r,
        t,
        env,
        `R${i}`,
        `r${i}@x.com`,
        at(-10),
      ]);
    }
    // El primero ya firmó con certificado hace 3 días; el segundo es al que le toca.
    await db.query(
      `INSERT INTO certificate_signatures (id, tenant_id, envelope_id, recipient_id, position, field_name, status, signed_at, created_at) VALUES ($1,$2,$3,$4,1,'F1','signed',$5,$6)`,
      [uuidv7(), t, env, r1, at(-3), at(-8)],
    );
    await db.query(`INSERT INTO certificate_signatures (id, tenant_id, envelope_id, recipient_id, position, field_name, created_at) VALUES ($1,$2,$3,$4,2,'F2',$5)`, [
      uuidv7(),
      t,
      env,
      r2,
      at(-8),
    ]);
    // (La base es compartida: otros sobres de pruebas anteriores también pueden tocar; se mira solo este.)
    await runAutomaticReminders(db, now);
    const q = await db.query<any>(`SELECT payload, dedupe_key FROM jobs WHERE payload->>'envelopeId' = $1 ORDER BY id`, [env]);
    expect(q.map((j) => [j.payload.kind, j.payload.recipientId])).toEqual([
      ["certificate_request", r2],
      ["expiry_warning", r2],
    ]);
    expect(q[1].dedupe_key).toMatch(/:cert$/);
    const ev = await db.query<any>(`SELECT type, data FROM envelope_events WHERE envelope_id = $1 ORDER BY seq`, [env]);
    expect(ev[0]).toMatchObject({ type: "envelope.reminded", data: { stage: "certificates" } });
  }, 60_000);

  it("esperando firmas con certificado: sin recordatorio al firmante que no recibe avisos (embebido)", async () => {
    const t = await tenant();
    const env = uuidv7();
    const r = uuidv7();
    const now = new Date("2027-05-10T12:00:00Z");
    const at = (days: number) => new Date(now.getTime() + days * 86400_000).toISOString();
    await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status, sent_at, reminder_every_days) VALUES ($1,$2,'S','awaiting_certificates',$3,2)`, [env, t, at(-10)]);
    await db.query(`INSERT INTO recipients (id, tenant_id, envelope_id, role, routing_order, name, email, status, sent_at, embedded) VALUES ($1,$2,$3,'signer',1,'E','e@x.com','signed',$4,true)`, [r, t, env, at(-10)]);
    await db.query(`INSERT INTO certificate_signatures (id, tenant_id, envelope_id, recipient_id, position, field_name, created_at) VALUES ($1,$2,$3,$4,1,'F1',$5)`, [uuidv7(), t, env, r, at(-8)]);
    await runAutomaticReminders(db, now);
    expect(await db.query(`SELECT 1 FROM jobs WHERE payload->>'envelopeId' = $1`, [env])).toEqual([]);
  }, 60_000);
});

describe("borrado de archivos sin uso", () => {
  it("dos fases: la fila se borra (y se anota con su clave) antes de tocar el almacenamiento; si este falla, el barrido lo reintenta", async () => {
    const t = await tenant();
    const f = uuidv7();
    await db.query(`INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'original','k-fail','application/pdf',1,'x')`, [f, t]);
    let down = true;
    const deleted: string[] = [];
    let inTx: boolean | null = null;
    const blobs = {
      delete: async (k: string) => {
        // El blob se borra fuera de la transacción: la fila ya no está y la anotación ya se confirmó.
        inTx = !(await db.one(`SELECT 1 FROM pending_file_deletions WHERE file_id = $1 AND storage_key = $2`, [f, k]));
        if (down) throw new Error("almacenamiento caído");
        deleted.push(k);
      },
    } as any;
    expect(await FC.deleteFilesIfUnused(db, blobs, [f])).toBe(1);
    expect(inTx).toBe(false);
    expect(await db.one(`SELECT 1 FROM files WHERE id = $1`, [f])).toBeNull();
    expect(await db.one<any>(`SELECT storage_key, error FROM pending_file_deletions WHERE file_id = $1`, [f])).toEqual({ storage_key: "k-fail", error: "almacenamiento caído" });
    // Recién anotada: el barrido la deja (su llamador podría estar borrando el archivo ahora).
    expect((await FC.retryPendingFileDeletions(db, blobs)).seen).toBe(0);
    await db.query(`UPDATE pending_file_deletions SET queued_at = now() - interval '10 minutes' WHERE file_id = $1`, [f]);
    // Sigue caído: queda para dentro de una hora.
    await FC.retryPendingFileDeletions(db, blobs);
    expect((await db.one<any>(`SELECT attempted_at FROM pending_file_deletions WHERE file_id = $1`, [f]))?.attempted_at).not.toBeNull();
    down = false;
    await db.query(`UPDATE pending_file_deletions SET attempted_at = now() - interval '2 hours'`);
    expect((await FC.retryPendingFileDeletions(db, blobs)).deleted).toBe(1);
    expect(deleted).toEqual(["k-fail"]);
    expect(await db.one(`SELECT 1 FROM pending_file_deletions WHERE file_id = $1`, [f])).toBeNull();
  }, 60_000);

  it("un archivo en uso no se borra ni se anota; una anotación vieja sin clave se resuelve con el borrado entero", async () => {
    const t = await tenant();
    const f = uuidv7();
    await db.query(`INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'original','k-used','application/pdf',1,'x')`, [f, t]);
    const env = uuidv7();
    await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status) VALUES ($1, $2, 'S', 'draft')`, [env, t]);
    await db.query(`INSERT INTO documents (id, tenant_id, envelope_id, file_id, name, position, page_count, pages) VALUES ($1, $4, $2, $3, 'd', 0, 1, '[]')`, [uuidv7(), env, f, t]);
    const deleted: string[] = [];
    const blobs = { delete: async (k: string) => void deleted.push(k) } as any;
    expect(await FC.deleteFileIfUnused(db, blobs, f)).toBe(false);
    expect(await db.one(`SELECT 1 FROM files WHERE id = $1`, [f])).not.toBeNull();
    expect(await db.one(`SELECT 1 FROM pending_file_deletions WHERE file_id = $1`, [f])).toBeNull();
    // Anotación sin clave (de antes del cambio) de un archivo que hoy está en uso: se descarta sin borrar nada.
    await db.query(`INSERT INTO pending_file_deletions (file_id, queued_at) VALUES ($1, now() - interval '1 day')`, [f]);
    await FC.retryPendingFileDeletions(db, blobs);
    expect(await db.one(`SELECT 1 FROM pending_file_deletions WHERE file_id = $1`, [f])).toBeNull();
    expect(deleted).toEqual([]);
  }, 60_000);
});
