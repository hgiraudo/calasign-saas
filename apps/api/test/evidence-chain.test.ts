// Cadena de hashes de la evidencia (infra/evidence.ts, docs/estandares/tests-automatizados.md §8): appendEvent calcula
// el hash de cada evento sobre el anterior y verifyRows lo recalcula. Sin base: una Db falsa en memoria que sólo
// entiende las dos consultas del módulo (y falla con cualquier otra), y el outbox de webhooks simulado. Cada caso
// afirma algo que un mutante de Stryker rompía sin que los tests sobre PGlite lo notaran.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fanout = vi.fn();
vi.mock("../src/infra/webhook-outbox", () => ({ queueWebhookFanout: (...a: unknown[]) => fanout(...a) }));

const { GENESIS_HASH, SYSTEM, appendEvent, verifyChain, verifyRows } = await import("../src/infra/evidence");
type Db = Parameters<typeof appendEvent>[0];

type Row = Record<string, any>;

/** Db en memoria: la última fila del sobre (ORDER BY seq DESC LIMIT 1), el INSERT y la lectura ordenada por seq. */
function fakeDb() {
  const rows: Row[] = [];
  const inserts: unknown[][] = [];
  const ofEnvelope = (id: unknown) => rows.filter((r) => r.envelope_id === id);
  const db = {
    async one(sql: string, params: unknown[]) {
      expect(sql).toMatch(/^SELECT seq, hash FROM envelope_events WHERE envelope_id = \$1 ORDER BY seq DESC LIMIT 1$/);
      const last = ofEnvelope(params[0]).sort((a, b) => b.seq - a.seq)[0];
      return last ? { seq: last.seq, hash: last.hash } : null;
    },
    async query(sql: string, params: unknown[]) {
      if (sql.startsWith("INSERT INTO envelope_events")) {
        inserts.push(params);
        const cols = sql
          .slice(sql.indexOf("(") + 1, sql.indexOf(")"))
          .split(",")
          .map((c) => c.trim());
        const r: Row = Object.fromEntries(cols.map((c, i) => [c, params[i]]));
        // Como lo devuelve Postgres: data jsonb parseado y occurred_at como Date.
        rows.push({ ...r, data: JSON.parse(r.data), occurred_at: new Date(r.occurred_at) });
        return [];
      }
      expect(sql).toBe("SELECT * FROM envelope_events WHERE envelope_id = $1 ORDER BY seq");
      return ofEnvelope(params[0]).sort((a, b) => a.seq - b.seq);
    },
  };
  return { db: db as unknown as Db, rows, inserts };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const T = "11111111-1111-4111-8111-111111111111";
const E = "22222222-2222-4222-8222-222222222222";

beforeEach(() => fanout.mockReset());

describe("appendEvent", () => {
  it("el primero encadena sobre el génesis (64 ceros) con seq 1; el hash es sha256(prev \\n JSON canónico)", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-03T12:00:00.000Z") });
    const { db, rows } = fakeDb();
    const r = await appendEvent(db, {
      tenantId: T,
      envelopeId: E,
      type: "envelope.sent",
      actor: { type: "user", id: "u1", label: "Ana", ip: "203.0.113.9", userAgent: "UA/1" },
      data: { b: 2, a: 1 },
    });
    vi.useRealTimers();
    expect(GENESIS_HASH).toBe("0".repeat(64));
    const canonical =
      '{"actor_id":"u1","actor_type":"user","data":{"a":1,"b":2},"ip":"203.0.113.9","occurred_at":"2026-11-03T12:00:00.000Z","seq":1,"type":"envelope.sent","user_agent":"UA/1"}';
    expect(r).toEqual({ seq: 1, hash: sha(`${"0".repeat(64)}\n${canonical}`) });
    expect(rows[0]).toMatchObject({ seq: 1, prev_hash: "0".repeat(64), hash: r.hash, actor_label: "Ana", tenant_id: T });
  });

  it("guarda todas las columnas: actor sin id, ip ni user agent queda en null; data por defecto {}", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-03T12:00:00.000Z") });
    const { db, inserts } = fakeDb();
    const r = await appendEvent(db, { tenantId: T, envelopeId: E, type: "envelope.expired", actor: SYSTEM });
    vi.useRealTimers();
    expect(inserts[0]).toEqual([
      T,
      E,
      1,
      "envelope.expired",
      "system",
      null,
      "CalaSign",
      null,
      null,
      "{}",
      "2026-11-03T12:00:00.000Z",
      GENESIS_HASH,
      r.hash,
    ]);
    const canonical =
      '{"actor_id":null,"actor_type":"system","data":{},"ip":null,"occurred_at":"2026-11-03T12:00:00.000Z","seq":1,"type":"envelope.expired","user_agent":null}';
    expect(r.hash).toBe(sha(`${GENESIS_HASH}\n${canonical}`));
    expect(SYSTEM).toEqual({ type: "system", label: "CalaSign" });
  });

  it("el siguiente toma seq+1 y el hash del último de ESE sobre como prev_hash", async () => {
    const { db, rows } = fakeDb();
    const a = await appendEvent(db, { tenantId: T, envelopeId: E, type: "a", actor: SYSTEM });
    await appendEvent(db, { tenantId: T, envelopeId: "otro", type: "x", actor: SYSTEM });
    const b = await appendEvent(db, { tenantId: T, envelopeId: E, type: "b", actor: SYSTEM });
    expect(b.seq).toBe(2);
    expect(rows.find((r) => r.envelope_id === E && r.seq === 2)?.prev_hash).toBe(a.hash);
    expect(verifyRows(rows.filter((r) => r.envelope_id === E))).toEqual({ ok: true, brokenAt: null, head: b.hash });
  });

  it("avisa al outbox de webhooks con el destinatario del evento", async () => {
    const { db } = fakeDb();
    await appendEvent(db, { tenantId: T, envelopeId: E, type: "recipient.signed", actor: { type: "recipient", id: "r1" }, data: { k: 1 } });
    expect(fanout).toHaveBeenLastCalledWith(db, T, E, "recipient.signed", 1, { k: 1 }, "r1");
    // data.recipientId manda sobre el actor (rechazo en persona registrado por el anfitrión).
    await appendEvent(db, { tenantId: T, envelopeId: E, type: "recipient.declined", actor: { type: "user", id: "u1" }, data: { recipientId: "r2" } });
    expect(fanout).toHaveBeenLastCalledWith(db, T, E, "recipient.declined", 2, { recipientId: "r2" }, "r2");
    // Un recipientId que no es string no cuenta; un actor que no es destinatario no es destinatario.
    await appendEvent(db, { tenantId: T, envelopeId: E, type: "envelope.voided", actor: { type: "user", id: "u1" }, data: { recipientId: 5 } });
    expect(fanout).toHaveBeenLastCalledWith(db, T, E, "envelope.voided", 3, { recipientId: 5 }, null);
    await appendEvent(db, { tenantId: T, envelopeId: E, type: "recipient.viewed", actor: { type: "recipient" } });
    expect(fanout).toHaveBeenLastCalledWith(db, T, E, "recipient.viewed", 4, {}, null);
  });
});

describe("verifyRows / verifyChain", () => {
  async function chain(n = 3) {
    const f = fakeDb();
    for (let i = 0; i < n; i++)
      await appendEvent(f.db, {
        tenantId: T,
        envelopeId: E,
        type: `t${i}`,
        actor: { type: "recipient", id: `r${i}`, ip: "198.51.100.7", userAgent: "UA" },
        data: { i },
      });
    return f;
  }

  it("una cadena sin tocar es íntegra y su cabeza es el hash del último", async () => {
    const { db, rows } = await chain();
    expect(await verifyChain(db, E)).toEqual({ ok: true, brokenAt: null, head: rows[2].hash });
    expect(verifyRows([])).toEqual({ ok: true, brokenAt: null, head: GENESIS_HASH });
  });

  it.each([
    ["type", "otro"],
    ["actor_type", "user"],
    ["actor_id", "r9"],
    ["ip", "198.51.100.8"],
    ["user_agent", "UA2"],
    ["data", { i: 99 }],
    ["occurred_at", new Date("2020-01-01T00:00:00Z")],
    ["seq", 7],
    ["hash", "f".repeat(64)],
    ["prev_hash", "e".repeat(64)],
  ])("cambiar %s del segundo evento rompe la cadena en él, con la cabeza del anterior", async (col, value) => {
    const { rows } = await chain();
    const expectedHead = rows[0].hash;
    const brokenSeq = col === "seq" ? value : 2;
    rows[1] = { ...rows[1], [col]: value };
    expect(verifyRows(rows)).toEqual({ ok: false, brokenAt: brokenSeq, head: expectedHead });
  });

  it("borrar o reordenar eventos rompe la cadena", async () => {
    const { rows } = await chain();
    expect(verifyRows([rows[0], rows[2]])).toMatchObject({ ok: false, brokenAt: 3 });
    expect(verifyRows([rows[1], rows[2]])).toMatchObject({ ok: false, brokenAt: 2, head: GENESIS_HASH });
    expect(verifyRows([rows[0], rows[2], rows[1]])).toMatchObject({ ok: false, brokenAt: 3 });
  });

  it("actor_label no entra en el hash (se puede mostrar distinto sin romper la evidencia)", async () => {
    const { rows } = await chain();
    rows[1] = { ...rows[1], actor_label: "Otro nombre" };
    expect(verifyRows(rows).ok).toBe(true);
  });

  it("occurred_at como string ISO (otro driver) verifica igual", async () => {
    const { rows } = await chain();
    expect(verifyRows(rows.map((r) => ({ ...r, occurred_at: r.occurred_at.toISOString() }))).ok).toBe(true);
  });
});
