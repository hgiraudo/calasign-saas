import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "../config";

/** Acceso mínimo a SQL, igual sobre node-postgres (producción) o PGlite (desarrollo). */
export interface Db {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T | null>;
  /** Transacción. Anidada: reutiliza la transacción en curso. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> };

function wrap(q: Queryable, txImpl: Db["tx"], close: () => Promise<void>): Db {
  const db: Db = {
    async query(sql, params) {
      const r = await q.query(sql, params as any[]);
      return r.rows;
    },
    async one(sql, params) {
      const rows = await db.query(sql, params);
      return (rows[0] as any) ?? null;
    },
    tx: txImpl,
    close,
  };
  return db;
}

// bigint → number (los ids de jobs y eventos entran holgados en 2^53).
pg.types.setTypeParser(20, (v) => Number(v));

async function createPgDb(url: string): Promise<Db> {
  const pool = new pg.Pool({ connectionString: url, max: Number(process.env.DB_POOL_MAX ?? 10) });
  const close = () => pool.end();
  const root: Db = wrap(
    pool,
    async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const inner: Db = wrap(client, (f) => f(inner), async () => {});
        const res = await fn(inner);
        await client.query("COMMIT");
        return res;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    close,
  );
  return root;
}

async function createPgliteDb(dir: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const lite = await PGlite.create(dir);
  const close = () => lite.close();
  const root: Db = wrap(
    lite as unknown as Queryable,
    (fn) =>
      lite.transaction(async (t) => {
        const inner: Db = wrap(t as unknown as Queryable, (f) => f(inner), async () => {});
        return fn(inner);
      }) as Promise<any>,
    close,
  );
  return root;
}

export async function createDb(): Promise<Db> {
  if (config.databaseUrl) return createPgDb(config.databaseUrl);
  return createPgliteDb(resolve(config.dataDir, "pglite"));
}

const migrationsDir = fileURLToPath(new URL("../../migrations/", import.meta.url));

export async function migrate(db: Db, log: (m: string) => void = () => {}) {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied = new Set((await db.query<{ name: string }>(`SELECT name FROM schema_migrations`)).map((r) => r.name));
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(resolve(migrationsDir, f), "utf8");
    await db.tx(async (t) => {
      // Una sentencia por llamada: PGlite y pg con parámetros no aceptan múltiples.
      for (const stmt of splitSql(sql)) await t.query(stmt);
      await t.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [f]);
    });
    log(`migración aplicada: ${f}`);
  }
}

function splitSql(sql: string): string[] {
  return sql
    .replace(/--[^\n]*(\n|$)/g, "\n")
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}
