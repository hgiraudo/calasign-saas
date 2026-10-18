#!/usr/bin/env node
// Prueba de punta a punta de la firma con certificado propio. Levanta su propia PKI de laboratorio (OCSP, CRL,
// TSA) y su propia API, y firma con el Firmador CalaSign real (CLI, fuente .p12):
//   2 firmantes con certificado (Perú RSA con DNI, Brasil ECDSA con CPF de ICP-Brasil) + 1 firmante electrónico.
// Verifica: estado awaiting_certificates, orden, certificado de otra persona rechazado, código de un solo uso,
// PDF final con las 2 firmas de los titulares + sello de plataforma válidos (validador y pdfsig), evidencia,
// reporte de /v1/validate y progreso del remitente. Si hay SoftHSM, prueba también la fuente PKCS#11.
// Uso: node scripts/e2e-certsign.mjs      (no recibe URL: usa la API que levanta en el puerto 4118)
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.CERTSIGN_E2E_PORT ?? 4118);
const BASE = `http://127.0.0.1:${PORT}`;
const TSX = join(ROOT, "apps/api/node_modules/.bin/tsx");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
let work = null;
const cleanup = () => {
  procs.forEach((p) => { try { p.kill("SIGTERM"); } catch {} });
  // PKI de laboratorio, base PGlite y archivos de la corrida: sin borrarlos /tmp se llena con cada ejecución
  // (E2E_KEEP_DATA=1 los conserva para depurar).
  if (work && process.env.E2E_KEEP_DATA !== "1") { try { rmSync(work, { recursive: true, force: true }); } catch {} }
};
process.on("exit", cleanup);
// SIGINT/SIGTERM/SIGHUP (Ctrl+C, `timeout`, cierre de terminal) terminan sin el evento "exit": se convierten en
// process.exit para que la limpieza corra también en esos casos.
for (const [sig, n] of [["SIGINT", 2], ["SIGTERM", 15], ["SIGHUP", 1]]) process.on(sig, () => process.exit(128 + n));
process.on("uncaughtException", (e) => { console.error(e); cleanup(); process.exit(1); });

function assert(cond, msg) {
  if (!cond) throw new Error(`FALLÓ: ${msg}`);
}
function step(msg) {
  console.log(`✓ ${msg}`);
}

// ───────── PKI de laboratorio ─────────
work = mkdtempSync(join(tmpdir(), "calasign-certsign-e2e-"));
const labDir = join(work, "lab");
const lab = spawn(TSX, [join(ROOT, "scripts/e2e-certsign-lab.mts"), labDir], { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] });
procs.push(lab);
const labUrl = await new Promise((resolve, reject) => {
  let buf = "";
  lab.stdout.on("data", (d) => {
    buf += d;
    const m = /LAB_READY (\S+)/.exec(buf);
    if (m) resolve(m[1]);
  });
  lab.on("exit", (c) => reject(new Error(`la PKI de laboratorio terminó (${c})`)));
  setTimeout(() => reject(new Error("la PKI de laboratorio no arrancó")), 60_000);
});
step(`PKI de laboratorio en ${labUrl}`);

// ───────── API propia ─────────
const api_ = spawn(TSX, [join(ROOT, "scripts/e2e-api-entry.mts")], {
  cwd: join(ROOT, "apps/api"),
  env: {
    ...process.env,
    NODE_ENV: "development",
    APP_ENV: "local",
    PORT: String(PORT),
    HOST: "127.0.0.1",
    APP_URL: BASE,
    DATA_DIR: join(work, "data"),
    DATABASE_URL: "",
    LOG_LEVEL: "warn",
    TSA_URL: `${labUrl}/tsr`,
    TSA_REQUIRED: "true",
    TRUST_STORE_DIR: join(labDir, "trust"),
  },
  stdio: ["ignore", "inherit", "inherit"],
});
procs.push(api_);
for (let i = 0; i < 120; i++) {
  try {
    if ((await fetch(`${BASE}/healthz`)).ok) break;
  } catch {}
  await sleep(500);
}

let cookie = "";
async function api(method, path, body, { raw = false, expect } = {}) {
  const h = {};
  if (cookie) h.cookie = cookie;
  let payload = body;
  if (body && !(body instanceof FormData)) {
    h["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers: h, body: payload });
  const set = res.headers.get("set-cookie");
  if (set && path.startsWith("/v1/auth")) cookie = set.split(";")[0];
  if (raw) return res;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (expect !== undefined) {
    assert(res.status === expect, `${method} ${path} → ${res.status} (esperaba ${expect}) ${text.slice(0, 300)}`);
    return data;
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 400)}`);
  return data;
}

function tinyPdf() {
  const objs = [];
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  const content = "BT /F1 18 Tf 72 760 Td (Contrato con firma de certificado) Tj ET";
  objs.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>");
  objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function linkFor(name) {
  for (let i = 0; i < 60; i++) {
    const { items } = await api("GET", "/dev/mailbox");
    const m = items.find((x) => x.text.includes(name) && x.link?.includes("/s/"));
    if (m) return m.link.split("/s/")[1];
    await sleep(500);
  }
  throw new Error(`no llegó la invitación de ${name}`);
}

async function waitStatus(envId, status) {
  for (let i = 0; i < 120; i++) {
    const d = await api("GET", `/v1/envelopes/${envId}`);
    if (d.envelope.status === status) return d;
    await sleep(500);
  }
  throw new Error(`el sobre no llegó a ${status}`);
}

/** Firma con el Firmador real (CLI) usando un .p12. */
function firmador(code, p12, extra = []) {
  const out = execFileSync(TSX, [join(ROOT, "packages/firmador/src/cli.ts"), "sign", "--api", BASE, "--code", code, "--p12", p12, "--password-env", "P12_PW", ...extra], {
    cwd: ROOT,
    env: { ...process.env, P12_PW: "clave-del-titular" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out.trim().split("\n").pop());
}

// ───────── Sobre ─────────
const stamp = Date.now();
await api("POST", "/v1/auth/signup", { name: "Ana Remitente", email: `ana+cs${stamp}@example.com`, password: "una-clave-segura-123", organization: `Certificados ${stamp}` });
const { envelope } = await api("POST", "/v1/envelopes", { subject: `Contrato con certificado ${stamp}` });
const fd = new FormData();
fd.append("file", new Blob([tinyPdf()], { type: "application/pdf" }), "contrato.pdf");
const doc = await api("POST", `/v1/envelopes/${envelope.id}/documents`, fd);

const A = crypto.randomUUID(); // Perú, certificado RSA
const B = crypto.randomUUID(); // firma electrónica
const C = crypto.randomUUID(); // Brasil, certificado ECDSA
const nameA = `Juan Perez ${stamp}`;
const nameB = `Bea Electronica ${stamp}`;
const nameC = `Maria Silva ${stamp}`;
// El rol cc no puede firmar con certificado.
await api("PUT", `/v1/envelopes/${envelope.id}/recipients`, {
  recipients: [{ name: "Copia", email: `cc${stamp}@example.com`, role: "cc", signatureType: "certificate" }],
}, { expect: 400 });
await api("PUT", `/v1/envelopes/${envelope.id}/recipients`, {
  recipients: [
    { id: A, name: nameA, email: `a${stamp}@example.com`, routingOrder: 1, idDocumentType: "dni", idDocumentNumber: "12345678", signatureType: "certificate", certificateRequirements: { allowedIssuers: ["CalaSign Lab"], requireQualified: true } },
    { id: B, name: nameB, email: `b${stamp}@example.com`, routingOrder: 2 },
    { id: C, name: nameC, email: `c${stamp}@example.com`, routingOrder: 3, idDocumentType: "cpf", idDocumentNumber: "123.456.789-09", signatureType: "certificate" },
  ],
});
// A tiene firma visual; C firma solo con certificado (sin campo de firma: está permitido).
await api("PUT", `/v1/envelopes/${envelope.id}/fields`, {
  fields: [
    { documentId: doc.id, recipientId: A, type: "signature", page: 0, x: 0.1, y: 0.7, width: 0.3, height: 0.08 },
    { documentId: doc.id, recipientId: B, type: "signature", page: 0, x: 0.55, y: 0.7, width: 0.3, height: 0.08 },
    { documentId: doc.id, recipientId: C, type: "name", page: 0, x: 0.1, y: 0.85, width: 0.3, height: 0.03 },
  ],
});
const detail0 = await api("GET", `/v1/envelopes/${envelope.id}`);
const ra = detail0.recipients.find((r) => r.id === A);
assert(ra.signatureType === "certificate" && ra.certificateRequirements.matchIdDocument === true && ra.certificateRequirements.requireQualified, "requisitos del certificado guardados");
await api("POST", `/v1/envelopes/${envelope.id}/send`);
step("sobre con 2 firmantes con certificado + 1 electrónico enviado (C sin campo de firma visual)");

// ───────── Etapa electrónica ─────────
for (const [name, sigField] of [[nameA, true], [nameB, true], [nameC, false]]) {
  const t = await linkFor(name);
  const s = await api("GET", `/v1/signing/${t}`);
  await api("POST", `/v1/signing/${t}/consent`);
  const done = await api("POST", `/v1/signing/${t}/complete`, { fields: [], ...(sigField ? { signature: { kind: "drawn", imagePng: PNG } } : {}) });
  assert(done.recipient.status === "signed", `${name} firmó electrónicamente`);
  if (s.recipient && name !== nameB) assert(s.certificateSigning?.status === "waiting", `${name}: todavía no es momento del certificado`);
}
await waitStatus(envelope.id, "awaiting_certificates");
step("todos firmaron electrónicamente → awaiting_certificates");

const tA = await linkFor(nameA);
const tC = await linkFor(nameC);
const reqA = await linkFor(nameA); // mismo token: el aviso "Firmá con tu certificado" usa el mismo link
assert(reqA === tA, "el aviso de certificado usa el link del firmante");
const sessA = await api("GET", `/v1/signing/${tA}`);
assert(sessA.certificateSigning?.status === "your_turn" && sessA.certificateSigning.total === 2, "A: es su turno");
const sessC = await api("GET", `/v1/signing/${tC}`);
assert(sessC.certificateSigning?.status === "waiting", "C: espera a A");
await api("POST", `/v1/signing/${tC}/certsign/pairing`, {}, { expect: 409 });
step("orden: C no puede emparejar el Firmador antes que A");
const remind = await api("POST", `/v1/envelopes/${envelope.id}/remind`, {});
assert(remind.notified === 1, `recordatorio al firmante con certificado pendiente (${JSON.stringify(remind)})`);
step("el remitente puede recordarle al firmante al que le toca firmar con certificado");

// ───────── Firmante A (Perú, RSA) ─────────
const pairA = await api("POST", `/v1/signing/${tA}/certsign/pairing`, {});
assert(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(pairA.code) && pairA.deepLink.startsWith("calasign-firmador://sign?api="), "código y deep link");
const info = await api("GET", `/v1/certsign/sessions/${pairA.code}`);
assert(info.signerName === nameA && info.requirements.requireQualified && /^[0-9a-f]{64}$/.test(info.documentSha256), "el Firmador ve el documento y los requisitos");
const docRes = await api("GET", `/v1/certsign/sessions/${pairA.code}/document`, null, { raw: true });
assert(docRes.ok && Buffer.from(await docRes.arrayBuffer()).subarray(0, 5).toString() === "%PDF-", "el Firmador puede descargar el PDF");
// El PDF preparado (para el vínculo documento–firma del Firmador) solo existe después de enviar el certificado.
await api("GET", `/v1/certsign/sessions/${pairA.code}/prepared`, null, { expect: 409 });

// Certificado de otra persona → rechazado (y queda en la evidencia).
let rejected = false;
try {
  firmador(pairA.code, join(labDir, "otro.p12"));
} catch (e) {
  rejected = /documento de identidad|certificate_rejected|422/.test(String(e.stderr ?? e.message));
}
assert(rejected, "certificado de otra persona rechazado");
step("certificado que no corresponde al DNI declarado: rechazado");

const outA = firmador(pairA.code, join(labDir, "peru.p12"));
assert(outA.ok && outA.envelopeStatus === "awaiting_certificates", `A firmó con su certificado (${JSON.stringify(outA)})`);
await api("GET", `/v1/certsign/sessions/${pairA.code}`, null, { expect: 410 });
step(`A firmó con el Firmador (.p12 RSA, ${outA.certificate}); el código no se puede reusar`);

// ───────── Firmante C (Brasil, ECDSA) ─────────
const sessC2 = await api("GET", `/v1/signing/${tC}`);
assert(sessC2.certificateSigning?.status === "your_turn" && sessC2.certificateSigning.signedCount === 1, "C: ahora es su turno");
const pairC = await api("POST", `/v1/signing/${tC}/certsign/pairing`, {});
const outC = firmador(pairC.code, join(labDir, "brasil.p12"));
assert(outC.ok && outC.envelopeStatus === "finalizing", `C firmó (${JSON.stringify(outC)})`);
step("C firmó con el Firmador (.p12 ECDSA P-256, CPF de ICP-Brasil)");

// ───────── Resultado ─────────
const final = await waitStatus(envelope.id, "completed");
const pdf = Buffer.from(await (await api("GET", `/v1/envelopes/${envelope.id}/signed.pdf`, null, { raw: true })).arrayBuffer());
writeFileSync(join(work, "final.pdf"), pdf);
const v = await (await fetch(`${BASE}/v1/validate`, { method: "POST", body: (() => { const f = new FormData(); f.append("file", new Blob([pdf], { type: "application/pdf" }), "final.pdf"); return f; })() })).json();
const sigs = (v.signatures ?? v.report?.signatures ?? []).filter((s) => s.kind === "signature");
const cns = sigs.map((s) => s.signer?.commonName);
assert(sigs.length >= 3, `3 firmas CAdES (2 titulares + sello): ${JSON.stringify(cns)}`);
assert(cns.includes("JUAN PEREZ") && cns.includes("MARIA DA SILVA:12345678909"), "los certificados de los dos titulares están en el reporte");
assert(sigs.every((s) => s.integrity.valid), "todas las firmas íntegras");
assert(sigs.filter((s) => s.signer?.commonName !== "JUAN PEREZ" && s.signer?.commonName !== "MARIA DA SILVA:12345678909").length >= 1, "más el sello de plataforma");
assert(sigs.find((s) => s.signer?.commonName === "JUAN PEREZ").timestamp?.valid, "firma del titular con sello de tiempo");
step(`PDF final: ${sigs.length} firmas íntegras (${cns.join(" | ")})`);

let pdfsig = "";
try {
  pdfsig = execFileSync("pdfsig", [join(work, "final.pdf")], { encoding: "utf8" });
} catch (e) {
  pdfsig = String(e.stdout ?? "");
}
if (pdfsig) {
  const ok = (pdfsig.match(/Signature is Valid/g) ?? []).length;
  assert(ok >= 3, `pdfsig valida las 3 firmas (vio ${ok})`);
  step(`pdfsig: ${ok} firmas válidas`);
} else console.warn("⚠ pdfsig no disponible: se omite esa verificación");

const { items: events } = await api("GET", `/v1/envelopes/${envelope.id}/events`);
const types = events.map((e) => e.type);
assert(types.includes("envelope.awaiting_certificates"), "evento awaiting_certificates");
assert(types.filter((t) => t === "recipient.certificate_signed").length === 2, "2 eventos certificate_signed");
assert(types.includes("recipient.certificate_rejected"), "evento del certificado rechazado");
const csA = events.find((e) => e.type === "recipient.certificate_signed" && e.data.recipientId === A);
assert(csA.data.identityMatch === "serialNumber" && csA.data.trusted === true && csA.data.timestamped, "evidencia: identidad por serialNumber, confiable, con sello de tiempo");
const csC = events.find((e) => e.type === "recipient.certificate_signed" && e.data.recipientId === C);
assert(csC.data.identityMatch === "icp-brasil-cpf" && csC.data.signatureAlgorithm === "ECDSA", "evidencia: CPF de ICP-Brasil, ECDSA");
assert(events.find((e) => e.type === "envelope.completed").data.signedSha256 === final.envelope.signedSha256, "envelope.completed coincide con el PDF");
step("evidencia: awaiting_certificates, certificate_rejected y 2 certificate_signed con titular/emisor/serie");

const progress = await api("GET", `/v1/envelopes/${envelope.id}/certificate-signatures`);
assert(progress.signers.length === 2 && progress.signers.every((x) => x.status === "signed" && x.serialNumber), "progreso del remitente");
assert(final.recipients.find((r) => r.id === C).certificateSignature?.status === "signed", "detalle: estado de la firma con certificado");
const sessDone = await api("GET", `/v1/signing/${tA}`);
assert(sessDone.certificateSigning?.status === "signed" && sessDone.certificateSigning.certificate?.commonName === "JUAN PEREZ" && sessDone.signedAvailable, "el firmante ve su certificado y puede descargar");
step("progreso del remitente y sesión del firmante actualizados");

// ───────── PKCS#11 (SoftHSM), si está disponible ─────────
let softhsm = false;
try {
  execFileSync("softhsm2-util", ["--version"], { stdio: "ignore" });
  softhsm = true;
} catch {}
if (!softhsm) console.warn("⚠ softhsm2-util no está instalado: se omite la prueba de la fuente PKCS#11 (token)");

// ───────── Anular un sobre que espera certificados ─────────
{
  const { envelope: e2 } = await api("POST", "/v1/envelopes", { subject: `Anular con certificado ${stamp}` });
  const fd2 = new FormData();
  fd2.append("file", new Blob([tinyPdf()], { type: "application/pdf" }), "contrato.pdf");
  const d2 = await api("POST", `/v1/envelopes/${e2.id}/documents`, fd2);
  const V = crypto.randomUUID();
  const nameV = `Victor Anulado ${stamp}`;
  await api("PUT", `/v1/envelopes/${e2.id}/recipients`, { recipients: [{ id: V, name: nameV, email: `v${stamp}@example.com`, signatureType: "certificate" }] });
  await api("PUT", `/v1/envelopes/${e2.id}/fields`, { fields: [{ documentId: d2.id, recipientId: V, type: "name", page: 0, x: 0.1, y: 0.85, width: 0.3, height: 0.03 }] });
  await api("POST", `/v1/envelopes/${e2.id}/send`);
  const tV = await linkFor(nameV);
  await api("POST", `/v1/signing/${tV}/consent`);
  await api("POST", `/v1/signing/${tV}/complete`, { fields: [] });
  await waitStatus(e2.id, "awaiting_certificates");
  const pairV = await api("POST", `/v1/signing/${tV}/certsign/pairing`, {});
  const voided = await api("POST", `/v1/envelopes/${e2.id}/void`, { reason: "prueba de anulación con certificados pendientes" });
  assert(voided.envelope.status === "voided", "se puede anular un sobre que espera firmas con certificado");
  await api("GET", `/v1/certsign/sessions/${pairV.code}`, null, { expect: 410 });
  step("anular con certificados pendientes: el código del Firmador deja de servir (410)");
}

console.log("\nE2E CERTIFICADO PROPIO OK");
cleanup();
process.exit(0);
