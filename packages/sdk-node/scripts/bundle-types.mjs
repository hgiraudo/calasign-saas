// Después de `tsc -p tsconfig.build.json`: dist/index.d.ts importa tipos de @calasign/shared, que es privado y no se
// publica. Este script los expande (también los de zod: z.infer) a dist/shared-types.d.ts y reescribe los imports, así
// el paquete publicado no depende de @calasign/shared ni de zod. Solo usa el compilador de TypeScript.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dtsPath = join(root, "dist/index.d.ts");
const SHARED = "@calasign/shared";
let dts = readFileSync(dtsPath, "utf8");

// Nombres que usa la declaración: los del `import type { … } from "@calasign/shared"` y los `import("@calasign/shared").X`.
const wanted = new Set();
for (const m of dts.matchAll(/import type \{([^}]*)\} from "@calasign\/shared";/g)) {
  for (const n of m[1].split(",")) if (n.trim()) wanted.add(n.trim().split(/\s+as\s+/)[0]);
}
for (const m of dts.matchAll(/import\("@calasign\/shared"\)\.(\w+)/g)) wanted.add(m[1]);

// Un programa con un archivo que importa todo lo pedido: el checker resuelve cada nombre.
const probe = join(root, "src/__bundle_types_probe.ts");
const host = ts.createCompilerHost({});
const probeText = `import type * as S from "${SHARED}";\nexport type __All = [${[...wanted].map((n) => `S.${n}`).join(", ")}];\n`;
const origRead = host.readFile;
host.readFile = (f) => (resolve(f) === probe ? probeText : origRead(f));
const origExists = host.fileExists;
host.fileExists = (f) => resolve(f) === probe || origExists(f);
const opts = { strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, types: ["node"], noEmit: true, skipLibCheck: true };
const program = ts.createProgram([probe], opts, host);
const checker = program.getTypeChecker();
const sf = program.getSourceFile(probe);
const importDecl = sf.statements.find(ts.isImportDeclaration);
const nsSym = checker.getSymbolAtLocation(importDecl.importClause.namedBindings.name);
const moduleSym = checker.getAliasedSymbol(nsSym);
const exportsByName = new Map(checker.getExportsOfModule(moduleSym).map((s) => [s.name, s]));

const isShared = (decl) => decl && /packages[\\/]shared[\\/]/.test(decl.getSourceFile().fileName);
const queue = [...wanted];
const done = new Map();

/** Nombre a referenciar si el tipo es una interfaz/alias no genérico de shared (se emite aparte). */
function namedRef(type) {
  const alias = type.aliasSymbol;
  if (alias && !type.aliasTypeArguments?.length && isShared(alias.declarations?.[0])) return alias.name;
  const sym = type.symbol;
  if (sym && type.flags & ts.TypeFlags.Object && type.objectFlags & ts.ObjectFlags.Interface && isShared(sym.declarations?.[0])) return sym.name;
  return null;
}

function print(type, depth = 0, top = false) {
  if (depth > 40) return "unknown";
  if (!top) {
    const n = namedRef(type);
    if (n) {
      if (!done.has(n) && !queue.includes(n)) queue.push(n);
      return n;
    }
  }
  const f = type.flags;
  if (f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.String | ts.TypeFlags.Number | ts.TypeFlags.Boolean | ts.TypeFlags.BigInt | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Never | ts.TypeFlags.Literal | ts.TypeFlags.ESSymbol | ts.TypeFlags.NonPrimitive))
    return checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
  if (type.isUnion()) return printUnion(type.types, depth);
  if (type.isIntersection()) return type.types.map((t) => `(${print(t, depth + 1)})`).join(" & ");
  if (checker.isTupleType(type)) return `[${checker.getTypeArguments(type).map((t) => print(t, depth + 1)).join(", ")}]`;
  if (checker.isArrayType(type)) {
    const ro = type.symbol?.name === "ReadonlyArray" ? "readonly " : "";
    return `${ro}(${print(checker.getTypeArguments(type)[0], depth + 1)})[]`;
  }
  if (f & ts.TypeFlags.Object) {
    const decl = type.symbol?.declarations?.[0];
    // Tipos de la biblioteca estándar (Date, Uint8Array, Record ya expandido…): tal cual.
    if (decl && !isShared(decl) && !/node_modules[\\/](zod|\.pnpm[\\/]zod)/.test(decl.getSourceFile().fileName) && type.symbol.name !== "__type" && type.symbol.name !== "__object")
      return checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
    const sigs = type.getCallSignatures();
    if (sigs.length) return checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
    const members = [];
    for (const info of checker.getIndexInfosOfType(type)) {
      members.push(`[key: ${checker.typeToString(info.keyType)}]: ${print(info.type, depth + 1)};`);
    }
    for (const p of checker.getPropertiesOfType(type)) {
      const opt = p.flags & ts.SymbolFlags.Optional ? "?" : "";
      let pt = checker.getTypeOfSymbol(p);
      // Con strict, el opcional ya trae `undefined`: se saca para no duplicarlo.
      if (opt && pt.isUnion()) {
        const rest = pt.types.filter((t) => !(t.flags & ts.TypeFlags.Undefined));
        if (rest.length === 1) pt = rest[0];
        else if (rest.length < pt.types.length) {
          members.push(`${JSON.stringify(p.name)}${opt}: ${printUnion(rest, depth)};`);
          continue;
        }
      }
      members.push(`${JSON.stringify(p.name)}${opt}: ${print(pt, depth + 1)};`);
    }
    return `{ ${members.join(" ")} }`;
  }
  return checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
}

function printUnion(types, depth) {
  // boolean llega como true | false: se vuelve a juntar.
  const parts = types.map((t) => print(t, depth + 1));
  if (parts.includes("true") && parts.includes("false")) parts.splice(parts.indexOf("false"), 1, "boolean"), parts.splice(parts.indexOf("true"), 1);
  return parts.map((p) => (/=>/.test(p) ? `(${p})` : p)).join(" | ");
}

while (queue.length) {
  const name = queue.shift();
  if (done.has(name)) continue;
  const sym = exportsByName.get(name);
  if (!sym) throw new Error(`bundle-types: ${name} no está exportado por ${SHARED}`);
  const target = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
  const type = checker.getDeclaredTypeOfSymbol(target);
  done.set(name, "");
  done.set(name, `export type ${name} = ${print(type, 0, true)};`);
}

const header = "// Generado por scripts/bundle-types.mjs desde @calasign/shared (no editar).\n";
const body = [...done.values()].join("\n") + "\n";
writeFileSync(join(root, "dist/shared-types.d.ts"), header + body);
dts = dts.replace(/from "@calasign\/shared";/g, 'from "./shared-types.js";').replace(/import\("@calasign\/shared"\)/g, 'import("./shared-types.js")');
writeFileSync(dtsPath, dts);
if (/@calasign\/shared|"zod"|\bz\.|Zod/.test(body + dts)) {
  throw new Error("bundle-types: quedó una referencia a @calasign/shared o zod en dist");
}
console.log(`bundle-types: ${done.size} tipos en dist/shared-types.d.ts`);
