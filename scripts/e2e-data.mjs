#!/usr/bin/env node
// E2E del bloque Datos: celdas (residencia de datos), BYOK (con KMS simulado), links con el dominio propio,
// verificación de dominios SSO, cupo de usuarios en SCIM y renovación de sellos de archivo (B-LTA).
//
// Uso: node scripts/e2e-data.mjs [baseUrl] [--data-dir <DATA_DIR del servidor>] [--pki-dir var/dev-pki]
// Pensado para el entorno local, con la API arrancada así:
//   KMS_MOCK=1 CELLS='{"us":{"default":true},"br":{"label":"Brasil","region":"sa-east-1"}}' DATA_DIR=… \
//   (+ las variables de var/dev-pki/api.env para la parte de archivo) tsx apps/api/src/server.ts
// Las partes que el servidor no soporta (sin CELLS, sin KMS simulado, sin PKI de laboratorio) se informan y se saltean.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const BASE = (args.find((a) => /^https?:/.test(a)) ?? "http://localhost:4000").replace(/\/$/, "");
const argv = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const DATA_DIR = argv("data-dir");
const stamp = Date.now();

class Client {
  constructor() {
    this.cookie = "";
  }
  async api(method, path, body, { expect, raw = false, headers = {} } = {}) {
    const h = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    let payload = body;
    if (body !== undefined && body !== null && !(body instanceof FormData)) {
      h["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(BASE + path, { method, headers: h, body: payload ?? undefined, redirect: "manual" });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0];
    if (raw) return res;
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    const exp = expect === undefined ? null : [].concat(expect);
    if (exp ? !exp.includes(res.status) : !res.ok) throw new Error(`${method} ${path} → ${res.status} (esperaba ${exp ?? "2xx"}) ${text.slice(0, 400)}`);
    return data;
  }
}
const ok = (m) => console.log(`✓ ${m}`);
const skip = (m) => console.log(`– ${m}`);
const assert = (c, m) => {
  if (!c) throw new Error(`falló: ${m}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tinyPdf(text = "Documento E2E datos") {
  const content = `BT /F1 14 Tf 60 760 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
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

async function signup(c, org, cell) {
  return c.api("POST", "/v1/auth/signup", {
    name: `Admin ${org}`,
    email: `admin+${org.replace(/\W+/g, "")}-${stamp}@example.com`,
    password: "una-clave-segura-123",
    organization: `${org} ${stamp}`,
    ...(cell ? { cell } : {}),
  });
}

async function draftWithDoc(c, subject, pdf = tinyPdf()) {
  const { envelope } = await c.api("POST", "/v1/envelopes", { subject });
  const fd = new FormData();
  fd.append("file", new Blob([pdf], { type: "application/pdf" }), "doc.pdf");
  const doc = await c.api("POST", `/v1/envelopes/${envelope.id}/documents`, fd, { expect: [201, 503] });
  return { envelope, doc };
}

function findFile(dir, name) {
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      const r = findFile(p, name);
      if (r) return r;
    } else if (f.startsWith(name)) return p;
  }
  return null;
}

// ───────────────────────────── Celdas ─────────────────────────────

const anon = new Client();
const cells = (await anon.api("GET", "/v1/public/cells")).items;
assert(cells.some((c) => c.default && c.available), "hay una celda por defecto disponible");
await new Client().api("POST", "/v1/auth/signup", { name: "X", email: `x-${stamp}@example.com`, password: "una-clave-segura-123", organization: "X", cell: "marte" }, { expect: 400 });
const br = cells.find((c) => c.id === "br");
assert(br, "Brasil figura en la lista");
const usCell = cells.find((c) => c.default).id;
const A = new Client();
await signup(A, "Organizacion A", usCell);
if (br.available) {
  const B = new Client();
  await signup(B, "Organizacion B", "br");
  const a = await draftWithDoc(A, "Doc celda US");
  const b = await draftWithDoc(B, "Doc celda BR");
  if (DATA_DIR) {
    const inBr = (id) => existsSync(join(DATA_DIR, "blobs-br", "tenants", id));
    const meA = await A.api("GET", "/v1/me");
    const meB = await B.api("GET", "/v1/me");
    assert(a.doc.id && inBr(meB.tenant.id) && !inBr(meA.tenant.id), "los archivos de la organización de Brasil quedan en la celda de Brasil");
    assert(existsSync(join(DATA_DIR, "blobs", "tenants", meA.tenant.id)) && !existsSync(join(DATA_DIR, "blobs", "tenants", meB.tenant.id)), "y los de la otra organización no");
  }
  const back = Buffer.from(await (await B.api("GET", `/v1/envelopes/${b.envelope.id}/documents/${b.doc.id}/file`, null, { raw: true })).arrayBuffer());
  assert(back.equals(tinyPdf()), "el documento de Brasil se lee desde su celda");
  ok(`celdas: alta en ${usCell} y en br; cada organización guarda en su celda${DATA_DIR ? " (verificado en disco)" : ""}; región inexistente → 400`);
} else {
  await new Client().api("POST", "/v1/auth/signup", { name: "Y", email: `y-${stamp}@example.com`, password: "una-clave-segura-123", organization: "Y", cell: "br" }, { expect: 400 });
  ok("celdas: Brasil figura como «Próximamente» y no se puede elegir; región inexistente → 400");
}

// ───────────────────────────── BYOK ─────────────────────────────

const meA = await A.api("GET", "/v1/me");
const mockOn = (await A.api("POST", "/dev/kms-mock", { keyArn: "arn:aws:kms:us-east-1:111122223333:key/probe", disabled: false }, { raw: true })).status === 200;
if (!mockOn) {
  skip("BYOK: el servidor no tiene KMS_MOCK=1 (entorno local); se saltea");
} else {
  const OK_ARN = `arn:aws:kms:us-east-1:111122223333:key/e2e-${stamp}`;
  let s = await A.api("GET", "/v1/settings/byok");
  assert(s.status === "none" && JSON.stringify(s.keyPolicy).includes(meA.tenant.id) && JSON.stringify(s.keyPolicy).includes("calasign-tenant-certificate"), "política sugerida atada a la organización");
  const bad = await A.api("PUT", "/v1/settings/byok", { keyArn: "arn:aws:kms:us-east-1:111122223333:key/mock-failing" }, { expect: 422 });
  assert(bad.error.code === "byok_key_test_failed" && bad.error.details.checks.some((c) => !c.ok), "una clave inutilizable no se activa");
  await A.api("PUT", "/v1/settings/byok", { keyArn: "no-es-un-arn" }, { expect: 400 });
  s = await A.api("PUT", "/v1/settings/byok", { keyArn: OK_ARN });
  assert(s.status === "active" && s.keyArn === OK_ARN, "clave activada");
  ok("BYOK: política sugerida, clave inválida rechazada, clave probada y activada");

  const pdf = tinyPdf("Contrato cifrado con BYOK");
  const d1 = await draftWithDoc(A, "BYOK 1", pdf);
  const got = Buffer.from(await (await A.api("GET", `/v1/envelopes/${d1.envelope.id}/documents/${d1.doc.id}/file`, null, { raw: true })).arrayBuffer());
  assert(got.equals(pdf), "el documento se lee descifrado");
  if (DATA_DIR) {
    const f = findFile(join(DATA_DIR, "blobs", "tenants", meA.tenant.id, "envelopes", d1.envelope.id), "");
    const raw = readFileSync(f);
    assert(raw.subarray(0, 8).toString() === "CSBYOK1\n" && !raw.includes(Buffer.from("cifrado con BYOK")), "en disco queda cifrado con la clave del cliente");
  }
  // Certificado en custodia envuelto con la clave del cliente y usado para firmar XML.
  const dir = mkdtempSync(join(tmpdir(), "p12-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "30", "-subj", "/CN=Empresa BYOK E2E"], { stdio: "ignore" });
  execFileSync("openssl", ["pkcs12", "-export", "-inkey", join(dir, "k.pem"), "-in", join(dir, "c.pem"), "-passout", "pass:e2e-pass", "-out", join(dir, "c.p12")]);
  const { certificate } = await A.api("POST", "/v1/certificates", { name: "BYOK", p12Base64: readFileSync(join(dir, "c.p12")).toString("base64"), password: "e2e-pass" }, { expect: 201 });
  const xml = `<?xml version="1.0" encoding="utf-8"?><ECF><Encabezado><Totales><MontoTotal>10.00</MontoTotal></Totales></Encabezado></ECF>`;
  const signedXml = await A.api("POST", "/v1/xml/sign", { xml, profile: "dgii-ecf", certificateId: certificate.id });
  assert(signedXml.verification.valid, "firma XML con la clave del certificado envuelta por BYOK");
  ok(`BYOK: documento cifrado${DATA_DIR ? " (en disco con la clave del cliente)" : ""} y leído; certificado en custodia envuelto con la clave del cliente`);

  // La clave deja de funcionar: falla cerrado y avisa.
  await A.api("POST", "/dev/kms-mock", { keyArn: OK_ARN, disabled: true });
  const blocked = await draftWithDoc(A, "BYOK caída");
  assert(blocked.doc.error?.code === "byok_key_unavailable", `subida bloqueada: ${JSON.stringify(blocked.doc)}`);
  const read = await A.api("GET", `/v1/envelopes/${d1.envelope.id}/documents/${d1.doc.id}/file`, null, { raw: true });
  assert(read.status === 503, "lectura bloqueada");
  await A.api("POST", "/v1/xml/sign", { xml, profile: "dgii-ecf", certificateId: certificate.id }, { expect: 503 });
  s = await A.api("GET", "/v1/settings/byok");
  assert(s.status === "failing" && s.error, "estado: con problemas");
  const mail = (await A.api("GET", "/dev/mailbox")).items.find((m) => m.to === meA.user.email && /BYOK/.test(m.subject));
  assert(mail, "aviso a los administradores");
  const audit = await A.api("GET", "/v1/audit-log?action=byok.*");
  assert(audit.items.some((x) => x.action === "byok.key_failing"), "auditoría de la falla");
  ok("BYOK: con la clave deshabilitada, subir, leer y firmar fallan cerrados (503); estado «con problemas», aviso por correo y auditoría");

  await A.api("POST", "/dev/kms-mock", { keyArn: OK_ARN, disabled: false });
  const t = await A.api("POST", "/v1/settings/byok/test", {});
  assert(t.ok && t.status === "active", "la prueba la vuelve a activar");
  const d2 = await draftWithDoc(A, "BYOK 2");
  assert(d2.doc.id, "vuelve a guardar");
  await A.api("DELETE", "/v1/settings/byok", null, { expect: 204 });
  assert((await A.api("GET", "/v1/settings/byok")).status === "none", "desactivada");
  const plain = await draftWithDoc(A, "Sin BYOK", tinyPdf("Sin BYOK"));
  if (DATA_DIR) {
    const raw = readFileSync(findFile(join(DATA_DIR, "blobs", "tenants", meA.tenant.id, "envelopes", plain.envelope.id), ""));
    assert(raw.subarray(0, 5).toString() === "%PDF-", "sin BYOK se guarda con la clave de la plataforma");
  }
  // Lo cifrado antes con la clave del cliente se sigue leyendo mientras la clave exista.
  const again = Buffer.from(await (await A.api("GET", `/v1/envelopes/${d1.envelope.id}/documents/${d1.doc.id}/file`, null, { raw: true })).arrayBuffer());
  assert(again.equals(pdf), "lo anterior se sigue leyendo");
  ok("BYOK: clave restablecida y probada → activa; desactivar vuelve a la clave de la plataforma sin perder lo anterior");
}

// ───────────────────────────── Dominio propio en todos los links ─────────────────────────────

const DOMAIN = `firmas-${stamp}.cliente-e2e.test`;
let dom = (await A.api("PUT", "/v1/domains", { domain: DOMAIN })).domain;
await A.api("POST", "/dev/dns-stub", { name: dom.txtName, values: [dom.txtValue] });
dom = (await A.api("POST", "/v1/domains/verify")).domain;
assert(dom.status === "verified", "dominio propio verificado");
// Firma embebida
const emb = await draftWithDoc(A, "Embebido con dominio");
const signer = randomUUID();
await A.api("PUT", `/v1/envelopes/${emb.envelope.id}/recipients`, { recipients: [{ id: signer, name: "Cliente embebido", embedded: true, routingOrder: 1 }] });
await A.api("PUT", `/v1/envelopes/${emb.envelope.id}/fields`, { fields: [{ documentId: emb.doc.id, recipientId: signer, type: "signature", page: 0, x: 0.1, y: 0.8, width: 0.3, height: 0.08 }] });
await A.api("POST", `/v1/envelopes/${emb.envelope.id}/send`);
const su = await A.api("POST", `/v1/envelopes/${emb.envelope.id}/recipients/${signer}/signing-url`, {}, { expect: 201 });
assert(su.url.startsWith(`https://${DOMAIN}/embed/`), `URL embebida con el dominio propio: ${su.url}`);
// Formulario web
const { template } = await A.api("POST", "/v1/templates", { name: `Alta ${stamp}`, subject: "Alta" });
const tfd = new FormData();
tfd.append("file", new Blob([tinyPdf("Alta")], { type: "application/pdf" }), "alta.pdf");
const tdoc = await A.api("POST", `/v1/templates/${template.id}/documents`, tfd);
const role = randomUUID();
await A.api("PUT", `/v1/templates/${template.id}/roles`, { roles: [{ id: role, name: "Cliente", role: "signer", routingOrder: 1 }] });
await A.api("PUT", `/v1/templates/${template.id}/fields`, { fields: [{ documentId: tdoc.id, roleId: role, type: "signature", page: 0, x: 0.1, y: 0.8, width: 0.3, height: 0.08 }] });
const form = await A.api("POST", "/v1/web-forms", { templateId: template.id, name: `Form ${stamp}`, signerRoleId: role, fixedRecipients: [] }, { expect: 201 });
assert(form.url === `https://${DOMAIN}/f/${form.slug}`, `link del formulario con el dominio propio: ${form.url}`);
ok("dominio propio: la URL de firma embebida y el link del formulario web usan el dominio de la organización");

// ───────────────────────────── Dominios SSO ─────────────────────────────

const SSO_DOMAIN = `sso-${stamp}.empresa-e2e.test`;
const ssoBase = { enabled: false, protocol: "oidc", jitEnabled: true, jitRole: "member", enforce: false, oidc: null, saml: null };
await A.api("PUT", "/v1/settings/sso", { ...ssoBase, domains: [SSO_DOMAIN] });
let items = (await A.api("GET", "/v1/settings/sso/domains")).items;
let d = items.find((x) => x.domain === SSO_DOMAIN);
assert(d && !d.verified && d.txtName === `_calasign-sso.${SSO_DOMAIN}`, "dominio SSO pendiente");
d = await A.api("POST", `/v1/settings/sso/domains/${SSO_DOMAIN}/verify`, {});
assert(!d.verified && d.lastError, "sin TXT no se verifica");
// Otra organización puede reclamarlo mientras nadie lo verificó.
const C = new Client();
await signup(C, "Organizacion C", usCell);
await C.api("PUT", "/v1/settings/sso", { ...ssoBase, domains: [SSO_DOMAIN] });
await A.api("POST", "/dev/dns-stub", { name: d.txtName, values: [d.txtValue] });
d = await A.api("POST", `/v1/settings/sso/domains/${SSO_DOMAIN}/verify`, {});
assert(d.verified, "verificado por DNS");
// Ahora es de A: C no lo puede verificar ni volver a reclamarlo.
const cd = (await C.api("GET", "/v1/settings/sso/domains")).items.find((x) => x.domain === SSO_DOMAIN);
await C.api("POST", "/dev/dns-stub", { name: cd.txtName, values: [d.txtValue, cd.txtValue] });
await C.api("POST", `/v1/settings/sso/domains/${SSO_DOMAIN}/verify`, {}, { expect: 409 });
const D = new Client();
await signup(D, "Organizacion D", usCell);
const taken = await D.api("PUT", "/v1/settings/sso", { ...ssoBase, domains: [SSO_DOMAIN] }, { expect: 409 });
assert(taken.error.code === "domain_taken", "dominio verificado por otra organización");
// Guardar de nuevo la configuración conserva la verificación.
await A.api("PUT", "/v1/settings/sso", { ...ssoBase, domains: [SSO_DOMAIN, `otro-${stamp}.test`] });
items = (await A.api("GET", "/v1/settings/sso/domains")).items;
assert(items.find((x) => x.domain === SSO_DOMAIN).verified && !items.find((x) => x.domain !== SSO_DOMAIN).verified, "guardar conserva la verificación");
ok("dominios SSO: pendiente hasta el TXT; verificado queda de una sola organización (409 para otras); guardar no pierde la verificación");

// ───────────────────────────── SCIM: cupo de usuarios del plan ─────────────────────────────

// SCIM solo da de alta correos de dominios verificados por la organización.
const SCIM_DOMAIN = `scim-${stamp}.empresa-e2e.test`;
await D.api("PUT", "/v1/settings/sso", { ...ssoBase, domains: [SCIM_DOMAIN] });
const sd = (await D.api("GET", "/v1/settings/sso/domains")).items.find((x) => x.domain === SCIM_DOMAIN);
await D.api("POST", "/dev/dns-stub", { name: sd.txtName, values: [sd.txtValue] });
assert((await D.api("POST", `/v1/settings/sso/domains/${SCIM_DOMAIN}/verify`, {})).verified, "dominio SCIM verificado");
const tok = (await D.api("POST", "/v1/settings/scim/tokens", { name: "IdP" }, { expect: 201 })).secret;
const scim = (method, path, body) =>
  fetch(`${BASE}/scim/v2${path}`, { method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/scim+json" }, body: body ? JSON.stringify(body) : undefined });
const u1 = await scim("POST", "/Users", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: `scim1-${stamp}@${SCIM_DOMAIN}`, active: true });
assert(u1.status === 201, `alta SCIM con cupo: ${u1.status}`);
await D.api("POST", "/v1/billing/cancel", {}); // baja a Free (1 usuario)
const u2 = await scim("POST", "/Users", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: `scim2-${stamp}@${SCIM_DOMAIN}`, active: true });
const e2 = await u2.json();
assert(u2.status === 402 && e2.schemas?.[0]?.includes("Error") && e2.scimType === "plan_limit" && /plan_limit/.test(e2.detail), `SCIM sin cupo: ${u2.status} ${JSON.stringify(e2)}`);
ok("SCIM: alta con cupo (201); sin cupo en el plan → 402 plan_limit con el esquema de error de SCIM");

// ───────────────────────────── Archivo a largo plazo (B-LTA) ─────────────────────────────

const ev = await A.api("GET", "/v1/settings/evidence");
await A.api("PATCH", "/v1/settings/evidence", { sealLevel: "B-LTA" });
const ev2 = await A.api("GET", "/v1/settings/evidence");
if (ev2.effectiveLevel !== "B-LTA") {
  skip(`archivo: el servidor no llega a B-LTA (nivel efectivo ${ev2.effectiveLevel}; arrancar con var/dev-pki/api.env); se saltea`);
} else {
  const ar = await draftWithDoc(A, "Archivo B-LTA");
  const sid = randomUUID();
  await A.api("PUT", `/v1/envelopes/${ar.envelope.id}/recipients`, { recipients: [{ id: sid, name: "Firmante archivo", email: `archivo-${stamp}@example.com`, routingOrder: 1 }] });
  await A.api("PUT", `/v1/envelopes/${ar.envelope.id}/fields`, { fields: [{ documentId: ar.doc.id, recipientId: sid, type: "signature", page: 0, x: 0.1, y: 0.8, width: 0.3, height: 0.08 }] });
  await A.api("POST", `/v1/envelopes/${ar.envelope.id}/send`);
  let link = null;
  for (let i = 0; i < 40 && !link; i++) {
    const m = (await A.api("GET", "/dev/mailbox")).items.find((x) => x.to === `archivo-${stamp}@example.com` && x.link?.includes("/s/"));
    link = m?.link?.split("/s/")[1];
    if (!link) await sleep(500);
  }
  assert(link, "invitación al firmante");
  await A.api("POST", `/v1/signing/${link}/consent`);
  await A.api("POST", `/v1/signing/${link}/complete`, { fields: [], signature: { kind: "drawn", imagePng: PNG } });
  let st = null;
  for (let i = 0; i < 60; i++) {
    st = (await A.api("GET", `/v1/envelopes/${ar.envelope.id}`)).envelope.status;
    if (st === "completed") break;
    await sleep(1000);
  }
  assert(st === "completed", "sobre completado");
  // PDF tal como se descargó antes de renovar: /v1/verify lo tiene que seguir reconociendo.
  const pdfV1 = Buffer.from(await (await A.api("GET", `/v1/envelopes/${ar.envelope.id}/signed.pdf`, null, { raw: true })).arrayBuffer());
  let info = await A.api("GET", `/v1/envelopes/${ar.envelope.id}/archive`);
  assert(info.validUntil && info.versions.length === 1 && info.renewals === 0, `vigencia del archivo: ${JSON.stringify(info)}`);
  const run = await A.api("POST", "/dev/archive/sweep", { days: 5000, envelopeId: ar.envelope.id });
  assert(run.renewed === 1 && run.failed === 0, `barrido de renovación: ${JSON.stringify(run)}`);
  info = await A.api("GET", `/v1/envelopes/${ar.envelope.id}/archive`);
  assert(info.renewals === 1 && info.versions.length === 2 && info.versions[1].reason === "archive_renewal", "nueva versión registrada");
  const pdf = Buffer.from(await (await A.api("GET", `/v1/envelopes/${ar.envelope.id}/signed.pdf`, null, { raw: true })).arrayBuffer());
  const fd = new FormData();
  fd.append("file", new Blob([pdf], { type: "application/pdf" }), "s.pdf");
  const val = await anon.api("POST", "/v1/validate", fd);
  const docTs = val.signatures.filter((x) => x.kind === "document_timestamp");
  assert(docTs.length === 2 && val.signatures.every((x) => x.integrity.valid), `PDF renovado: ${docTs.length} sellos de documento, todos íntegros`);
  const events = (await A.api("GET", `/v1/envelopes/${ar.envelope.id}/events`)).items;
  assert(events.some((e) => e.type === "envelope.archive_renewed"), "evento de renovación en la evidencia");
  const manual = await A.api("POST", `/v1/envelopes/${ar.envelope.id}/archive/renew`, {});
  assert(manual.renewals === 2 && manual.versions.length === 3, "renovación manual");
  const verifyBytes = async (bytes) => {
    const f = new FormData();
    f.append("file", new Blob([bytes], { type: "application/pdf" }), "v.pdf");
    return anon.api("POST", "/v1/verify", f);
  };
  const oldV = await verifyBytes(pdfV1);
  assert(oldV.match && oldV.envelope.id === ar.envelope.id && oldV.version?.number === 1 && oldV.version.latest === 3 && oldV.version.isLatest === false,
    `verify reconoce la versión anterior a la renovación: ${JSON.stringify(oldV.version)}`);
  const latestPdf = Buffer.from(await (await A.api("GET", `/v1/envelopes/${ar.envelope.id}/signed.pdf`, null, { raw: true })).arrayBuffer());
  const newV = await verifyBytes(latestPdf);
  assert(newV.match && newV.version?.isLatest === true && newV.version.number === 3 && newV.version.reason === "archive_renewal", `verify de la versión vigente: ${JSON.stringify(newV.version)}`);
  ok("archivo: vigencia calculada, barrido renueva con DSS + sello de documento nuevo (2 sellos válidos), historial de versiones, evento, renovación manual y verify de versiones anteriores");
}
await A.api("PATCH", "/v1/settings/evidence", { sealLevel: ev.sealLevel });

console.log("\nE2E DATOS OK");
