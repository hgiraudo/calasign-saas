// Verifica una base restaurada desde un backup contra la base en uso (SEG-43). Lo corre scripts/prueba-restauracion.sh
// en el EC2, con el código de la versión activa: la cadena de evidencia se recalcula con el mismo verifyRows que usa
// el certificado, no con una copia.
//   tsx verificar-restauracion.mts <base restaurada> <base en uso>
// Sale con 1 si algo no cierra. Sólo lee: no escribe en ninguna de las dos bases.
import { createRequire } from "node:module";

const API = process.env.CALASIGN_API_DIR ?? "/opt/calasign/current/apps/api";
const require = createRequire(`${API}/package.json`);
const pg = require("pg") as typeof import("pg");
type Client = import("pg").Client;
const { verifyRows } = (await import(`${API}/src/infra/evidence.ts`)) as typeof import("../apps/api/src/infra/evidence");

const [restoredDb, liveDb] = process.argv.slice(2);
if (!restoredDb || !liveDb) {
  console.error("uso: verificar-restauracion.mts <base restaurada> <base en uso>");
  process.exit(2);
}

async function connect(database: string) {
  const c = new pg.Client({ host: "/var/run/postgresql", user: "calasign", database });
  await c.connect();
  // Las dos sólo se leen: si un bug de este script intentara escribir, Postgres lo rechaza.
  await c.query("SET default_transaction_read_only = on");
  return c;
}

const restored = await connect(restoredDb);
const live = await connect(liveDb);
const errors: string[] = [];
const warnings: string[] = [];

const tables = async (c: Client) =>
  (await c.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows.map((r) => r.t);
const migrations = async (c: Client) => new Set((await c.query<{ name: string }>(`SELECT name FROM schema_migrations`)).rows.map((r) => r.name));

// 1. Esquema: las mismas tablas y las migraciones del dump son un prefijo de las de la base en uso.
const [tR, tL] = [await tables(restored), await tables(live)];
const [mR, mL] = [await migrations(restored), await migrations(live)];
const missingTables = tL.filter((t) => !tR.includes(t));
if (missingTables.length) {
  const newer = [...mL].filter((m) => !mR.has(m));
  (newer.length ? warnings : errors).push(
    `tablas que no están en la restaurada: ${missingTables.join(", ")}${newer.length ? ` (migraciones posteriores al dump: ${newer.join(", ")})` : ""}`,
  );
}
const unknown = [...mR].filter((m) => !mL.has(m));
if (unknown.length) errors.push(`migraciones del dump que la base en uso no tiene: ${unknown.join(", ")}`);
console.log(`esquema: ${tR.length} tablas restauradas (en uso: ${tL.length}), ${mR.size} migraciones (en uso: ${mL.size})`);

// 2. Filas por tabla. La base en uso siguió recibiendo datos después del dump: la restaurada puede tener menos.
const counts: Array<[string, number, number]> = [];
for (const t of tR) {
  const q = `SELECT count(*)::bigint AS n FROM "${t.replace(/"/g, '""')}"`;
  const n = Number((await restored.query<{ n: string }>(q)).rows[0]!.n);
  const m = tL.includes(t) ? Number((await live.query<{ n: string }>(q)).rows[0]!.n) : NaN;
  counts.push([t, n, m]);
}
const total = counts.reduce((s, [, n]) => s + n, 0);
console.log(`filas: ${total} en ${counts.filter(([, n]) => n > 0).length} tablas con datos`);
for (const t of ["tenants", "users", "envelopes", "documents", "envelope_events", "account_audit_log"]) {
  const row = counts.find(([name]) => name === t);
  if (!row) errors.push(`falta la tabla ${t}`);
  else {
    console.log(`  ${t.padEnd(18)} ${String(row[1]).padStart(8)}  (en uso: ${row[2]})`);
    if (row[1] === 0) errors.push(`${t} quedó vacía`);
  }
}

// 3. La cadena de evidencia de cada sobre, recalculada.
const ev = await restored.query(`SELECT * FROM envelope_events ORDER BY envelope_id, seq`);
const byEnvelope = new Map<string, any[]>();
for (const r of ev.rows) {
  const list = byEnvelope.get(r.envelope_id) ?? [];
  list.push(r);
  byEnvelope.set(r.envelope_id, list);
}
let broken = 0;
for (const [id, rows] of byEnvelope) {
  const v = verifyRows(rows);
  if (!v.ok) {
    broken++;
    if (broken <= 5) errors.push(`cadena de evidencia rota en el sobre ${id}, evento ${v.brokenAt}`);
  }
}
if (broken > 5) errors.push(`… y ${broken - 5} sobres más con la cadena rota`);
console.log(`evidencia: ${ev.rows.length} eventos de ${byEnvelope.size} sobres, ${broken} cadenas rotas`);

// 4. La evidencia restaurada es la misma que la de la base en uso (que no se edita nunca): mismo hash por id.
const maxId = ev.rows.reduce((m, r) => (BigInt(r.id) > m ? BigInt(r.id) : m), 0n);
const liveHashes = new Map(
  (await live.query<{ id: string; hash: string }>(`SELECT id::text, hash FROM envelope_events WHERE id <= $1`, [maxId.toString()])).rows.map((r) => [
    r.id,
    r.hash,
  ]),
);
let differ = 0;
let gone = 0;
for (const r of ev.rows) {
  const h = liveHashes.get(String(r.id));
  if (h === undefined) gone++;
  else if (h !== r.hash) differ++;
}
if (differ) errors.push(`${differ} eventos con un hash distinto del de la base en uso`);
// Un evento que ya no está en la base en uso es una purga de retención posterior al dump (borra el sobre entero).
if (gone) warnings.push(`${gone} eventos del dump ya no están en la base en uso (retención posterior al dump)`);
console.log(`evidencia contra la base en uso: ${ev.rows.length - gone - differ} iguales, ${differ} distintos, ${gone} purgados después`);

await restored.end();
await live.end();
for (const w of warnings) console.log(`AVISO: ${w}`);
for (const e of errors) console.log(`ERROR: ${e}`);
console.log(errors.length ? "VERIFICACION_FALLO" : "VERIFICACION_OK");
process.exit(errors.length ? 1 : 0);
