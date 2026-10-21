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
  function fakePg(opts: { invalid?: boolean; failOn?: RegExp } = {}) {
    const log: string[] = [];
    const recorded = new Set<string>();
    const mk = (ctx: string): Db => {
      const db: Db = {
        dialect: "pg",
        async query(sql: string, params?: unknown[]) {
          log.push(`${ctx}: ${sql.replace(/\s+/g, " ").trim()}`);
          if (opts.failOn?.test(sql)) throw new Error("falló");
          if (/^SELECT name FROM schema_migrations/.test(sql)) return [...recorded].map((name) => ({ name })) as any;
          if (/SELECT 1 FROM schema_migrations/.test(sql)) return (recorded.has(String(params?.[0])) ? [{ "?column?": 1 }] : []) as any;
          if (/INSERT INTO schema_migrations/.test(sql)) recorded.add(String(params?.[0]));
          if (/FROM pg_index/.test(sql)) return (opts.invalid ? [{ "?column?": 1 }] : []) as any;
          return [];
        },
        async one(sql: string, params?: unknown[]) {
          return ((await db.query(sql, params))[0] as any) ?? null;
        },
        tx: async (fn) => fn(mk("tx")),
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
      "session: SELECT pg_advisory_lock($1)",
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
