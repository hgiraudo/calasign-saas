// Migraciones `-- no-transaction`: en Postgres corren fuera de una transacción (CREATE INDEX CONCURRENTLY), en una
// conexión fija con el candado de sesión, y un índice inválido de un intento anterior se borra y se rehace. En PGlite
// se quita CONCURRENTLY y corren en una transacción como las demás.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-migrate-"));
delete process.env.DATABASE_URL;

const D = await import("../src/infra/db");
type Db = Awaited<ReturnType<typeof D.createDb>>;

function dirWith(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "calasign-migs-"));
  for (const [f, sql] of Object.entries(files)) writeFileSync(join(dir, f), sql);
  return dir;
}

const NO_TX = `-- no-transaction
-- un comentario
CREATE INDEX CONCURRENTLY IF NOT EXISTS t_a_idx ON t (a);
`;

describe("migraciones sin transacción", () => {
  it("marca, nombre del índice y CONCURRENTLY quitado", () => {
    expect(D.isNoTransactionMigration(NO_TX)).toBe(true);
    expect(D.isNoTransactionMigration(`-- Otro comentario\n-- no-transaction\nSELECT 1;`)).toBe(false);
    expect(D.concurrentIndexName(`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS x_idx ON t (a)`)).toBe("x_idx");
    expect(D.concurrentIndexName(`CREATE INDEX IF NOT EXISTS x_idx ON t (a)`)).toBeNull();
    expect(D.stripConcurrently(`CREATE INDEX CONCURRENTLY IF NOT EXISTS x ON t (a)`)).toBe(`CREATE INDEX IF NOT EXISTS x ON t (a)`);
    expect(D.stripConcurrently(`DROP INDEX CONCURRENTLY IF EXISTS x`)).toBe(`DROP INDEX IF EXISTS x`);
  });

  it("PGlite: corre sin CONCURRENTLY y queda registrada (re-ejecutar no hace nada)", async () => {
    const db = await D.createDb();
    try {
      const dir = dirWith({ "0001_t.sql": `CREATE TABLE t (a int);`, "0002_idx.sql": NO_TX });
      const logs: string[] = [];
      await D.migrate(db, (m) => logs.push(m), { dir });
      expect(logs).toEqual(["migración aplicada: 0001_t.sql", "migración aplicada: 0002_idx.sql"]);
      expect(await db.one(`SELECT 1 AS ok FROM pg_indexes WHERE indexname = 't_a_idx'`)).toEqual({ ok: 1 });
      await D.migrate(db, (m) => logs.push(m), { dir });
      expect(logs).toHaveLength(2);
    } finally {
      await db.close();
    }
  }, 60_000);

  // Doble de Postgres: registra cada sentencia y si fue dentro de una transacción o de la conexión fija.
  // `busy`: cuántos intentos de pg_try_advisory_[xact_]lock devuelven false antes de conseguirlo.
  function fakePg(opts: { invalid?: boolean; failOn?: RegExp; busy?: number } = {}) {
    const log: string[] = [];
    const recorded = new Set<string>();
    let busy = opts.busy ?? 0;
    const mk = (ctx: string): Db => {
      const db: Db = {
        dialect: "pg",
        async query(sql: string, params?: unknown[]) {
          log.push(`${ctx}: ${sql.replace(/\s+/g, " ").trim()}`);
          if (opts.failOn?.test(sql)) throw new Error("falló");
          if (/pg_try_advisory/.test(sql)) return [{ locked: busy-- <= 0 }] as any;
          if (/^SELECT name FROM schema_migrations/.test(sql)) return [...recorded].map((name) => ({ name })) as any;
          if (/SELECT 1 FROM schema_migrations/.test(sql)) return (recorded.has(String(params?.[0])) ? [{ "?column?": 1 }] : []) as any;
          if (/INSERT INTO schema_migrations/.test(sql)) recorded.add(String(params?.[0]));
          if (/FROM pg_index/.test(sql)) return (opts.invalid ? [{ "?column?": 1 }] : []) as any;
          return [];
        },
        async one(sql: string, params?: unknown[]) {
          return ((await db.query(sql, params))[0] as any) ?? null;
        },
        tx: async (fn) => {
          log.push("tx: BEGIN");
          try {
            const r = await fn(mk("tx"));
            log.push("tx: COMMIT");
            return r;
          } catch (e) {
            log.push("tx: ROLLBACK");
            throw e;
          }
        },
        session: async (fn) => fn(mk("session")),
        close: async () => {},
      };
      return db;
    };
    return { db: mk("root"), log, recorded };
  }

  it("Postgres: fuera de la transacción, con candado de sesión; un índice inválido se borra y se rehace", async () => {
    const dir = dirWith({ "0002_idx.sql": NO_TX });
    const { db, log, recorded } = fakePg({ invalid: true });
    await D.migrate(db, () => {}, { dir });
    const mine = log.filter((l) => l.startsWith("session:"));
    expect(mine).toEqual([
      "session: SET statement_timeout = 0",
      "session: SELECT pg_try_advisory_lock($1) AS locked",
      "session: SELECT 1 FROM schema_migrations WHERE name = $1",
      "session: SELECT 1 FROM pg_index WHERE indexrelid = to_regclass($1) AND NOT indisvalid",
      "session: DROP INDEX CONCURRENTLY IF EXISTS t_a_idx",
      "session: CREATE INDEX CONCURRENTLY IF NOT EXISTS t_a_idx ON t (a)",
      "session: INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING",
      "session: SELECT pg_advisory_unlock($1)",
      "session: RESET statement_timeout",
    ]);
    expect(log.some((l) => l.startsWith("tx:") && /CREATE INDEX/.test(l))).toBe(false);
    expect([...recorded]).toEqual(["0002_idx.sql"]);
  });

  // Un proceso bloqueado dentro de pg_advisory_[xact_]lock retiene una instantánea, y el CREATE INDEX CONCURRENTLY de
  // quien tiene el candado la espera: se trababan. Ahora se prueba el candado y se duerme fuera de la transacción.
  it("Postgres: con el candado tomado, reintenta la transacción entera y duerme fuera de ella", async () => {
    const dir = dirWith({ "0001_t.sql": `CREATE TABLE t (a int);` });
    const { db, log, recorded } = fakePg({ busy: 2 });
    const msgs: string[] = [];
    await D.migrate(db, (m) => msgs.push(m), { dir, lockPollMs: 1 });
    const first = log.slice(0, 12);
    expect(first).toEqual([
      "tx: BEGIN",
      "tx: SET LOCAL statement_timeout = 0",
      "tx: SELECT pg_try_advisory_xact_lock($1) AS locked",
      "tx: ROLLBACK",
      "tx: BEGIN",
      "tx: SET LOCAL statement_timeout = 0",
      "tx: SELECT pg_try_advisory_xact_lock($1) AS locked",
      "tx: ROLLBACK",
      "tx: BEGIN",
      "tx: SET LOCAL statement_timeout = 0",
      "tx: SELECT pg_try_advisory_xact_lock($1) AS locked",
      expect.stringMatching(/^tx: CREATE TABLE IF NOT EXISTS schema_migrations/),
    ]);
    expect(log.some((l) => /pg_advisory_(xact_)?lock\(/.test(l))).toBe(false); // nunca la espera bloqueante
    expect(msgs[0]).toMatch(/esperando el candado/);
    expect([...recorded]).toEqual(["0001_t.sql"]);
  });

  it("Postgres: sin transacción, prueba el candado de sesión hasta conseguirlo; pasado el tope falla sin soltar uno ajeno", async () => {
    const dir = dirWith({ "0002_idx.sql": NO_TX });
    {
      const { db, log, recorded } = fakePg({ busy: 0 });
      // La primera transacción (schema_migrations) lo consigue; después, el de sesión está ocupado 3 veces.
      const orig = db.session!;
      let tries = 0;
      db.session = (fn) =>
        orig(async (c) => {
          const q = c.query.bind(c);
          c.query = (async (sql: string, params?: unknown[]) =>
            /pg_try_advisory_lock/.test(sql) ? (q(sql, params), [{ locked: ++tries > 3 }]) : q(sql, params)) as any;
          return fn(c);
        });
      await D.migrate(db, () => {}, { dir, lockPollMs: 1 });
      expect(log.filter((l) => l === "session: SELECT pg_try_advisory_lock($1) AS locked")).toHaveLength(4);
      expect([...recorded]).toEqual(["0002_idx.sql"]);
    }
    {
      const { db, log, recorded } = fakePg({ busy: 0 });
      const orig = db.session!;
      db.session = (fn) =>
        orig(async (c) => {
          const q = c.query.bind(c);
          c.query = (async (sql: string, params?: unknown[]) =>
            /pg_try_advisory_lock/.test(sql) ? (q(sql, params), [{ locked: false }]) : q(sql, params)) as any;
          return fn(c);
        });
      await expect(D.migrate(db, () => {}, { dir, lockPollMs: 5, lockTimeoutMs: 30 })).rejects.toThrow(/candado de migraciones/);
      expect(log.some((l) => /pg_advisory_unlock/.test(l))).toBe(false);
      expect(log).toContain("session: RESET statement_timeout");
      expect(recorded.size).toBe(0);
    }
  });

  it("Postgres: si el CREATE INDEX falla, suelta el candado y no la registra (se reintenta en el próximo arranque)", async () => {
    const dir = dirWith({ "0002_idx.sql": NO_TX });
    const { db, log, recorded } = fakePg({ failOn: /CREATE INDEX CONCURRENTLY/ });
    await expect(D.migrate(db, () => {}, { dir })).rejects.toThrow("falló");
    expect(log).toContain("session: SELECT pg_advisory_unlock($1)");
    expect(recorded.size).toBe(0);
    // Índice válido (o inexistente): no se borra nada.
    expect(log.some((l) => /DROP INDEX/.test(l))).toBe(false);
  });
});
