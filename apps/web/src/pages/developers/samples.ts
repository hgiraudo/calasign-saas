// Generador de ejemplos de pedidos HTTP en curl, Node.js (fetch) y Python (requests).
// Lo usan las guías escritas a mano y la referencia generada desde OpenAPI, así todos los ejemplos tienen la misma forma.
import { BASE } from "./constants";
import type { CodeTab } from "./ui";

export interface ApiCall {
  method: string;
  /** Ruta con variables entre llaves: /v1/envelopes/{envelopeId}/send */
  path: string;
  /** Cuerpo JSON. */
  body?: unknown;
  /** Cuerpo application/x-www-form-urlencoded. */
  form?: Record<string, string>;
  /** Subida multipart: nombre del campo y archivo local de ejemplo. */
  multipart?: { field: string; file: string };
  /** Query string. */
  query?: Record<string, string>;
  idempotencyKey?: string;
  /** false: endpoint público, sin Authorization. "basic": credenciales del cliente OAuth. */
  auth?: boolean | "basic";
  /** La respuesta es un archivo (PDF/CSV): se guarda en disco. */
  saveAs?: string;
  /** La respuesta exitosa no tiene cuerpo (204): no se intenta leer JSON. */
  noContent?: boolean;
  /** Pestañas extra (SDK). */
  extra?: CodeTab[];
}

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const shellVar = (s: string) => `$${snake(s).toUpperCase()}`;

function q(query?: Record<string, string>) {
  if (!query || !Object.keys(query).length) return "";
  return "?" + new URLSearchParams(query).toString().replace(/%2C/g, ",");
}

/** Literal de Python equivalente a un valor JSON. */
export function pyLiteral(v: unknown, indent = 0): string {
  const pad = "    ".repeat(indent + 1);
  const end = "    ".repeat(indent);
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    const flat = v.every((x) => x === null || typeof x !== "object");
    if (flat) return `[${v.map((x) => pyLiteral(x)).join(", ")}]`;
    return `[\n${v.map((x) => pad + pyLiteral(x, indent + 1)).join(",\n")},\n${end}]`;
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (!entries.length) return "{}";
  return `{\n${entries.map(([k, x]) => `${pad}${JSON.stringify(k)}: ${pyLiteral(x, indent + 1)}`).join(",\n")},\n${end}}`;
}

function indentJson(v: unknown, spaces: number) {
  return JSON.stringify(v, null, 2).replace(/\n/g, "\n" + " ".repeat(spaces));
}

export function curlFor(c: ApiCall): string {
  const path = c.path.replace(/\{(\w+)\}/g, (_m, n) => shellVar(n));
  const lines = [`curl${c.method.toUpperCase() === "GET" ? "" : ` -X ${c.method.toUpperCase()}`} "${BASE}${path}${q(c.query)}"`];
  if (c.auth === "basic") lines.push(`-u "$CLIENT_ID:$CLIENT_SECRET"`);
  else if (c.auth !== false) lines.push(`-H "Authorization: Bearer $CALASIGN_API_KEY"`);
  if (c.idempotencyKey) lines.push(`-H "Idempotency-Key: ${c.idempotencyKey}"`);
  if (c.body !== undefined) {
    lines.push(`-H "Content-Type: application/json"`);
    lines.push(`-d '${JSON.stringify(c.body, null, 2).replace(/'/g, "'\\''")}'`);
  }
  if (c.form) for (const [k, v] of Object.entries(c.form)) lines.push(`--data-urlencode "${k}=${v}"`);
  if (c.multipart) lines.push(`-F ${c.multipart.field}=@${c.multipart.file}`);
  if (c.saveAs) lines.push(`-o ${c.saveAs}`);
  return lines.join(" \\\n  ");
}

export function nodeFor(c: ApiCall): string {
  const path = c.path.replace(/\{(\w+)\}/g, (_m, n) => `\${${n}}`);
  const url = `\`${BASE}${path}${q(c.query)}\``;
  const headers: string[] = [];
  if (c.auth === "basic") headers.push('Authorization: "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")');
  else if (c.auth !== false) headers.push("Authorization: `Bearer ${process.env.CALASIGN_API_KEY}`");
  if (c.body !== undefined) headers.push('"Content-Type": "application/json"');
  if (c.form) headers.push('"Content-Type": "application/x-www-form-urlencoded"');
  if (c.idempotencyKey) headers.push(`"Idempotency-Key": "${c.idempotencyKey}"`);
  const pre: string[] = [];
  const opts: string[] = [];
  if (c.method.toUpperCase() !== "GET") opts.push(`method: "${c.method.toUpperCase()}"`);
  if (headers.length) opts.push(`headers: {\n    ${headers.join(",\n    ")},\n  }`);
  if (c.body !== undefined) opts.push(`body: JSON.stringify(${indentJson(c.body, 2)})`);
  if (c.form) opts.push(`body: new URLSearchParams(${indentJson(c.form, 2)})`);
  const fsImports = [c.multipart && "readFile", c.saveAs && "writeFile"].filter(Boolean);
  if (fsImports.length) pre.push(`import { ${fsImports.join(", ")} } from "node:fs/promises";`, "");
  if (c.multipart) {
    pre.push("const form = new FormData();");
    pre.push(`form.append("${c.multipart.field}", new Blob([await readFile("${c.multipart.file}")], { type: "application/pdf" }), "${c.multipart.file}");`, "");
    opts.push("body: form");
  }
  const call = `const res = await fetch(${url}${opts.length ? `, {\n  ${opts.join(",\n  ")},\n}` : ""});`;
  const tail = c.saveAs
    ? [`if (!res.ok) throw new Error(\`\${res.status}: \${await res.text()}\`);`, `await writeFile("${c.saveAs}", Buffer.from(await res.arrayBuffer()));`]
    : c.noContent
      ? [`if (!res.ok) throw new Error(\`\${res.status}: \${await res.text()}\`);`]
      : [`const data = await res.json();`, `if (!res.ok) throw new Error(\`\${data.error?.code}: \${data.error?.message}\`);`];
  return [...pre, call, ...tail].join("\n");
}

export function pythonFor(c: ApiCall): string {
  const path = c.path.replace(/\{(\w+)\}/g, (_m, n) => `{${snake(n)}}`);
  const url = `f"${BASE}${path}"`;
  const args: string[] = [url];
  const headers: string[] = [];
  if (c.auth === "basic") args.push("auth=(CLIENT_ID, CLIENT_SECRET)");
  else if (c.auth !== false) headers.push(`"Authorization": f"Bearer {os.environ['CALASIGN_API_KEY']}"`);
  if (c.idempotencyKey) headers.push(`"Idempotency-Key": "${c.idempotencyKey}"`);
  if (headers.length) args.push(`headers={${headers.join(", ")}}`);
  if (c.query && Object.keys(c.query).length) args.push(`params=${pyLiteral(c.query)}`);
  if (c.body !== undefined) args.push(`json=${pyLiteral(c.body)}`);
  if (c.form) args.push(`data=${pyLiteral(c.form)}`);
  if (c.multipart) args.push(`files={"${c.multipart.field}": open("${c.multipart.file}", "rb")}`);
  const lines = ["import os", "import requests", "", `r = requests.${c.method.toLowerCase()}(\n    ${args.join(",\n    ")},\n)`, "r.raise_for_status()"];
  if (c.saveAs) lines.push(`open("${c.saveAs}", "wb").write(r.content)`);
  else lines.push("data = r.json() if r.content else None");
  return lines.join("\n");
}

/** Pestañas curl / Node.js / Python (+ las extra) para un pedido. */
export function apiTabs(c: ApiCall): CodeTab[] {
  return [
    { id: "curl", label: "curl", lang: "bash", code: curlFor(c) },
    { id: "node", label: "Node.js", lang: "js", code: nodeFor(c) },
    { id: "python", label: "Python", lang: "python", code: pythonFor(c) },
    ...(c.extra ?? []),
  ];
}

export const sdkPy = (code: string): CodeTab => ({ id: "sdk-python", label: "Python SDK", lang: "python", code });
export const sdkNode = (code: string): CodeTab => ({ id: "sdk-node", label: "Node SDK", lang: "ts", code });
