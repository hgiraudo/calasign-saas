#!/usr/bin/env node
// Pruebas de las integraciones (sin red): corre el build en una carpeta temporal y verifica
//   1. la skill (estructura del zip y frontmatter),
//   2. el marketplace de Claude Code (sha256 del zip del plugin),
//   3. el servidor stdio del .mcpb contra un servidor MCP remoto simulado (initialize, tools/list con anotaciones,
//      tools/call, API key inválida, sin API key),
//   4. la página de firmas del complemento de Office (pdf-lib),
//   5. que no quede ningún {{PLACEHOLDER}} sin reemplazar.
//
//   node integrations/test/run.mjs
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { PDFDocument } from "pdf-lib";
import { z } from "zod";

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), "calasign-integrations-"));
const KEY = "cs_test_mock_key";
let failures = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✔ ${name}`);
  } catch (e) {
    failures++;
    console.error(`✘ ${name}\n  ${e?.stack ?? e}`);
  }
}

/** Lector mínimo de zip (entradas guardadas o deflate, sin data descriptors: lo que escribe lib/zip.mjs). */
function readZip(buf) {
  const files = new Map();
  let o = 0;
  while (buf.readUInt32LE(o) === 0x04034b50) {
    const method = buf.readUInt16LE(o + 8);
    const csize = buf.readUInt32LE(o + 18);
    const nlen = buf.readUInt16LE(o + 26);
    const xlen = buf.readUInt16LE(o + 28);
    const name = buf.subarray(o + 30, o + 30 + nlen).toString("utf8");
    const data = buf.subarray(o + 30 + nlen + xlen, o + 30 + nlen + xlen + csize);
    files.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    o += 30 + nlen + xlen + csize;
  }
  return files;
}

// ───────── Build en una carpeta temporal ─────────

const OUT = join(TMP, "out");
execFileSync(process.execPath, [join(HERE, "../build.mjs")], {
  env: { ...process.env, CALASIGN_BASE_URL: "https://example.calasign.test", CALASIGN_INTEGRATIONS_OUT: OUT },
  stdio: "pipe",
});

await test("skill: zip con calasign/SKILL.md y references", () => {
  const z = readZip(readFileSync(join(OUT, "calasign-skill.zip")));
  assert.ok(z.has("calasign/SKILL.md"));
  for (const r of ["rest-api", "lifecycle", "fields-and-anchors", "webhooks", "errors", "mcp-tools"])
    assert.ok(z.has(`calasign/references/${r}.md`), r);
  const md = z.get("calasign/SKILL.md").toString();
  assert.match(md, /^---\nname: calasign\ndescription: .{20,200}\n/);
  assert.match(md, /https:\/\/example\.calasign\.test\/mcp/);
});

await test("claude code: marketplace con sha256 del zip del plugin", () => {
  const mk = JSON.parse(readFileSync(join(OUT, "claude-code/marketplace.json"), "utf8"));
  const src = mk.plugins[0].source;
  assert.equal(src.source, "archive");
  const file = src.url.replace("https://example.calasign.test/integrations/", "");
  const zip = readFileSync(join(OUT, file));
  assert.equal(createHash("sha256").update(zip).digest("hex"), src.sha256);
  const z = readZip(zip);
  for (const f of [".claude-plugin/plugin.json", ".mcp.json", "commands/send.md", "commands/status.md", "skills/calasign/SKILL.md"])
    assert.ok(z.has(f), f);
  assert.equal(JSON.parse(z.get(".mcp.json")).mcpServers.calasign.url, "https://example.calasign.test/mcp");
});

await test("sin placeholders sin reemplazar", () => {
  const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  for (const f of walk(OUT)) {
    if (!/\.(md|json|html|css|js|mjs|py|xml)$/.test(f)) continue;
    const s = readFileSync(f, "utf8");
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(s), `placeholder en ${f}`);
    assert.ok(!s.includes("__DEFAULT_BASE_URL__") && !s.includes("__VERSION__"), `marcador en ${f}`);
  }
  for (const [name, data] of readZip(readFileSync(join(OUT, "calasign.mcpb")))) {
    if (/\.(json|mjs|md)$/.test(name)) assert.ok(!/\{\{[A-Z_]+\}\}|__DEFAULT_BASE_URL__/.test(data.toString()), name);
  }
});

// ───────── Servidor MCP remoto simulado ─────────

function mockRemote() {
  const calls = [];
  const http = createServer(async (req, res) => {
    if (req.url !== "/mcp") return res.writeHead(404).end();
    if (req.headers.authorization !== `Bearer ${KEY}`) {
      return res
        .writeHead(401, { "content-type": "application/json", "www-authenticate": 'Bearer resource_metadata="x"' })
        .end('{"error":{"code":"unauthorized"}}');
    }
    // Como el servidor real (sin sesiones): solo POST; GET (stream SSE) y DELETE responden 405.
    if (req.method !== "POST") return res.writeHead(405, { allow: "POST" }).end();
    let body = "";
    for await (const c of req) body += c;
    const server = new McpServer({ name: "calasign", version: "test" });
    server.registerTool(
      "list_envelopes",
      { title: "Listar sobres", description: "Lista sobres", inputSchema: { status: z.string().optional() }, annotations: { readOnlyHint: true } },
      async (a) => {
        calls.push(["list_envelopes", a]);
        return { content: [{ type: "text", text: JSON.stringify({ items: [{ id: "e1", status: a.status ?? "sent" }] }) }] };
      },
    );
    server.registerTool(
      "send_envelope",
      {
        title: "Enviar sobre",
        description: "Envía",
        inputSchema: { envelopeId: z.string(), confirm: z.boolean().optional() },
        annotations: { destructiveHint: false, openWorldHint: true },
      },
      async (a) =>
        a.confirm ? { content: [{ type: "text", text: "sent" }] } : { isError: true, content: [{ type: "text", text: "Confirmación requerida" }] },
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, JSON.parse(body));
  });
  return new Promise((resolve) => http.listen(0, "127.0.0.1", () => resolve({ http, calls, url: `http://127.0.0.1:${http.address().port}` })));
}

/** Arranca el servidor stdio del .mcpb y devuelve una función para mandar pedidos JSON-RPC. */
function startStdio(env) {
  const dir = join(TMP, `mcpb-${Math.random().toString(36).slice(2)}`);
  for (const [name, data] of readZip(readFileSync(join(OUT, "calasign.mcpb")))) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), data);
  }
  const child = spawn(process.execPath, [join(dir, "server/index.mjs")], {
    env: { PATH: process.env.PATH, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const waiting = new Map();
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
    }
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  let id = 0;
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const myId = ++id;
      const timer = setTimeout(() => reject(new Error(`timeout en ${method}; stderr: ${stderr}`)), 15000);
      waiting.set(myId, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: myId, method, params })}\n`);
    });
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  const init = async () => {
    const r = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    notify("notifications/initialized");
    return r;
  };
  return { rpc, init, stop: () => child.kill(), stderr: () => stderr };
}

const remote = await mockRemote();

await test("mcpb: initialize, tools/list (con anotaciones) y tools/call contra el remoto", async () => {
  const s = startStdio({ CALASIGN_API_KEY: KEY, CALASIGN_BASE_URL: remote.url });
  try {
    const init = await s.init();
    assert.equal(init.result.serverInfo.name, "calasign");
    assert.ok(init.result.capabilities.tools);
    const list = await s.rpc("tools/list", {});
    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["list_envelopes", "send_envelope"]);
    const le = list.result.tools.find((t) => t.name === "list_envelopes");
    assert.equal(le.annotations.readOnlyHint, true);
    assert.equal(le.title, "Listar sobres");
    const se = list.result.tools.find((t) => t.name === "send_envelope");
    assert.equal(se.annotations.openWorldHint, true);
    const call = await s.rpc("tools/call", { name: "list_envelopes", arguments: { status: "completed" } });
    assert.equal(JSON.parse(call.result.content[0].text).items[0].status, "completed");
    assert.deepEqual(remote.calls.at(-1), ["list_envelopes", { status: "completed" }]);
    const unconfirmed = await s.rpc("tools/call", { name: "send_envelope", arguments: { envelopeId: "e1" } });
    assert.equal(unconfirmed.result.isError, true);
  } finally {
    s.stop();
  }
});

await test("mcpb: API key inválida → error legible", async () => {
  const s = startStdio({ CALASIGN_API_KEY: "cs_live_mala", CALASIGN_BASE_URL: remote.url });
  try {
    await s.init();
    const list = await s.rpc("tools/list", {});
    assert.ok(list.error, JSON.stringify(list));
    const call = await s.rpc("tools/call", { name: "list_envelopes", arguments: {} });
    assert.equal(call.result.isError, true);
    assert.match(call.result.content[0].text, /401|API key/);
  } finally {
    s.stop();
  }
});

await test("mcpb: sin API key (placeholder de Claude Desktop sin completar) → pide configurarla", async () => {
  const s = startStdio({ CALASIGN_API_KEY: "${user_config.api_key}", CALASIGN_BASE_URL: "${user_config.base_url}" });
  try {
    await s.init();
    const list = await s.rpc("tools/list", {});
    assert.match(list.error.message, /API key/);
  } finally {
    s.stop();
  }
});

remote.http.close();

// ───────── Página de firmas (Office) ─────────

await test("office: página de firmas con campos dentro de la página", async () => {
  // signature-page.js solo usa pdf-lib: se puede importar en Node.
  const { appendSignaturePage } = await import("../office/src/signature-page.js");
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  doc.addPage([842, 595]); // última apaisada: la de firmas sale vertical
  const signers = Array.from({ length: 5 }, (_, i) => ({ name: `Firmante ${i + 1} Ñandú`, email: `f${i + 1}@ejemplo.com` }));
  const r = await appendSignaturePage(await doc.save(), signers, { title: "Firmas", date: "Fecha" });
  const out = await PDFDocument.load(r.bytes);
  assert.equal(out.getPageCount(), 4); // 2 originales + 2 de firmas (4 + 1)
  const { width, height } = out.getPage(2).getSize();
  assert.ok(height > width);
  assert.equal(r.placements.length, 5);
  assert.deepEqual([...new Set(r.placements.map((p) => p.page))], [2, 3]);
  for (const p of r.placements)
    for (const box of [p.signature, p.date]) {
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 1 && box.y + box.height <= 1, JSON.stringify(box));
    }
  // Un nombre fuera de WinAnsi no rompe el dibujo.
  await appendSignaturePage(await doc.save(), [{ name: "王小明 😀", email: "x@y.com" }], { title: "Assinaturas", date: "Data" });
});

rmSync(TMP, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} prueba(s) fallaron`);
  process.exit(1);
}
console.log("\nTodas las pruebas pasaron");
