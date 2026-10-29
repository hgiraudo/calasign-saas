// Plegado del título de acuerdos en SQL (titleFoldSql, índice trigram 0090) alineado con fold() de JS: la búsqueda
// pliega el texto con fold() y después pasa los dos lados del LIKE por titleFoldSql.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-title-fold-"));
delete process.env.DATABASE_URL;

type Db = Awaited<ReturnType<(typeof import("../src/infra/db"))["createDb"]>>;
let db: Db;
let titleFoldSql: (e: string) => string;
let fold: (s: string) => string;

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  ({ titleFoldSql } = await import("../src/modules/agreements/repository"));
  ({ fold } = await import("../src/modules/agreements/common"));
  db = await createDb();
  await migrate(db);
}, 120_000);
afterAll(async () => {
  await db?.close();
});

const sqlFold = async (s: string) => (await db.one<{ v: string }>(`SELECT ${titleFoldSql("$1::text")} AS v`, [s]))!.v;

describe("titleFoldSql", () => {
  it("coincide con fold() + minúsculas en letras con diacríticos (también mayúsculas y tildes combinantes)", async () => {
    const cases = [
      "Género y Ñandú",
      "ÁRBOL ÉPICO ÍNDICE ÓRBITA ÚLTIMO",
      "Contrato de prestação de serviços — São Paulo",
      "Brașov, Țară, Ștefan, Măgura",
      "Kraków Gdańsk Źródo Żóraw",
      "Ōsaka Ő Ű ő ű",
      "Česko Šárka Žďár Řeka",
      "Garçon ÇA",
      "Café decomposto",
      "Ğüzel İçin",
    ];
    for (const c of cases) {
      const expected = fold(c.normalize("NFC")).toLowerCase();
      expect(await sqlFold(c), c).toBe(expected);
    }
  });

  it("las letras que fold() no descompone (ł, ø, đ, ħ) se pliegan igual de los dos lados del LIKE", async () => {
    for (const [title, query] of [
      ["Łódź Białystok", "lodz bialystok"],
      ["Øresund", "oresund"],
      ["Đakovo", "dakovo"],
    ]) {
      expect(await sqlFold(title)).toBe(await sqlFold(fold(query)));
      expect(await sqlFold(fold(title))).toBe(query);
    }
  });

  it("la migración 0090 crea el índice con la expresión exacta de titleFoldSql", async () => {
    const mig = readFileSync(resolve(__dirname, "../migrations/0090_agreements_title_fold_v2.sql"), "utf8");
    expect(mig).toContain(titleFoldSql("title").replace(/'/g, "''"));
    const idx = await db.one<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE indexname = 'agreements_title_fold_trgm_idx'`);
    expect(idx?.indexdef).toMatch(/normalize\(title, NFC\)/i);
  });
});
