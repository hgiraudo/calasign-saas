#!/usr/bin/env node
// E2E de evidencia fuerte (Fase 5): nivel PAdES B-LT/B-LTA, validación de PDF, certificados de la
// organización (.p12), firma XML (DGII e-CF, DIAN, XAdES-BES/EPES), sello de empresa y conector CSC.
//
// Uso: node scripts/e2e-evidence.mjs [baseUrl] [--pki-dir var/dev-pki]
// Con --pki-dir (salida de `tsx scripts/dev-pki.mts`, con la API arrancada con su api.env) se verifica todo:
// B-LTA, cadena de confianza, revocación y CSC. Sin PKI de laboratorio se genera un .p12 autofirmado y se
// verifican integridad y mecánica (contra dev.calasign.com, por ejemplo).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const BASE = (args.find((a) => /^https?:/.test(a)) ?? "http://localhost:4000").replace(/\/$/, "");
const pkiIdx = args.indexOf("--pki-dir");
const PKI_DIR = pkiIdx >= 0 ? args[pkiIdx + 1] : "var/dev-pki";
const LAB = existsSync(join(PKI_DIR, "company.p12"));
let cookie = "";

async function api(method, path, body, { raw = false, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  let payload = body;
  if (body && !(body instanceof FormData)) {
    h["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers: h, body: payload });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  if (raw) return res;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 400)}`);
  return data;
}
const step = (m) => console.log(`✓ ${m}`);
const assert = (c, m) => {
  if (!c) throw new Error(`falló: ${m}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function tinyPdf() {
  const objs = [];
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  const content = "BT /F1 18 Tf 72 760 Td (Contrato con sello de empresa) Tj ET";
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

/** .p12 de prueba: el de la PKI de laboratorio o uno autofirmado generado con openssl. */
function companyP12() {
  if (LAB) {
    return {
      modern: readFileSync(join(PKI_DIR, "company.p12")),
      legacy: existsSync(join(PKI_DIR, "company-legacy.p12")) ? readFileSync(join(PKI_DIR, "company-legacy.p12")) : null,
      password: readFileSync(join(PKI_DIR, "company.p12.password"), "utf8").trim(),
    };
  }
  const dir = mkdtempSync(join(tmpdir(), "p12-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "30", "-subj", "/CN=Empresa E2E Autofirmada/O=CalaSign E2E", "-addext", "extendedKeyUsage=emailProtection,1.3.6.1.5.5.7.3.36"], { stdio: "ignore" });
  execFileSync("openssl", ["pkcs12", "-export", "-inkey", join(dir, "k.pem"), "-in", join(dir, "c.pem"), "-passout", "pass:e2e-pass", "-out", join(dir, "c.p12")]);
  return { modern: readFileSync(join(dir, "c.p12")), legacy: null, password: "e2e-pass" };
}

async function linkFor(name) {
  for (let i = 0; i < 60; i++) {
    const { items } = await api("GET", "/dev/mailbox");
    const m = items.find((x) => x.text.includes(name) && x.link?.includes("/s/"));
    if (m) return m.link.split("/s/")[1];
    await sleep(500);
  }
  throw new Error(`no llegó la invitación de ${name}`);
}

const ECF = `<?xml version="1.0" encoding="utf-8"?><ECF><Encabezado><Version>1.0</Version><IdDoc><TipoeCF>31</TipoeCF><eNCF>E310000000099</eNCF></IdDoc><Emisor><RNCEmisor>101000000</RNCEmisor></Emisor><Totales><MontoTotal>2360.00</MontoTotal></Totales></Encabezado></ECF>`;
const UBL = `<?xml version="1.0" encoding="UTF-8"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"><ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions><cbc:ID>SETP990000099</cbc:ID><cbc:PayableAmount>119000.00</cbc:PayableAmount></Invoice>`;

// ─────────────────────────────────────────────────────────────────────────────

const stamp = Date.now();
await api("POST", "/v1/auth/signup", { name: "Eva Evidencia", email: `eva+${stamp}@example.com`, password: "una-clave-segura-123", organization: `Evidencia ${stamp}`, locale: "es" });
step(`alta de cuenta (${LAB ? "con PKI de laboratorio" : "sin PKI de laboratorio: .p12 autofirmado"})`);

// Nivel PAdES
const ev0 = await api("GET", "/v1/settings/evidence");
assert(ev0.sealLevel === "auto", "nivel por defecto auto");
const ev1 = await api("PATCH", "/v1/settings/evidence", { sealLevel: "B-LTA" });
assert(ev1.sealLevel === "B-LTA", "nivel guardado");
step(`nivel PAdES: auto → B-LTA (efectivo ${ev1.effectiveLevel}, TSA ${ev1.tsaConfigured ? "sí" : "no"})`);

// Certificados
const p12 = companyP12();
const bad = await api("POST", "/v1/certificates", { name: "mal", p12Base64: p12.modern.toString("base64"), password: "incorrecta" }, { raw: true });
assert(bad.status === 400, `contraseña incorrecta → 400 (fue ${bad.status})`);
const { certificate: cert } = await api("POST", "/v1/certificates", { name: "Sello ACME", p12Base64: p12.modern.toString("base64"), password: p12.password });
assert(!JSON.stringify(cert).match(/PRIVATE|key_ciphertext|wrapped/i), "la API no devuelve material de clave");
assert(cert.chainLength >= (LAB ? 3 : 1) && cert.keyAlgorithm.startsWith("RSA"), `metadatos del certificado (cadena ${cert.chainLength})`);
let legacyId = null;
if (p12.legacy) {
  const { certificate } = await api("POST", "/v1/certificates", { name: "Legado 3DES", p12Base64: p12.legacy.toString("base64"), password: p12.password, usages: ["xml"] });
  legacyId = certificate.id;
}
const list = await api("GET", "/v1/certificates");
assert(list.items.some((c) => c.id === cert.id), "listado");
step(`certificado de la organización en custodia: ${cert.commonName} (${cert.keyAlgorithm}, cadena ${cert.chainLength})${legacyId ? " + .p12 legado" : ""}; contraseña incorrecta → 400`);

// Firma XML
const SUNAT = `<?xml version="1.0" encoding="UTF-8"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"><ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions><cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:ID>F001-00000123</cbc:ID><cac:Signature><cbc:ID>SignSUNAT</cbc:ID></cac:Signature><cac:LegalMonetaryTotal><cbc:PayableAmount currencyID="PEN">1180.00</cbc:PayableAmount></cac:LegalMonetaryTotal></Invoice>`;
for (const [profile, xml] of [["dgii-ecf", ECF], ["dian-fe", UBL], ["sunat-cpe", SUNAT], ["xades-bes", ECF], ["xades-epes", UBL]]) {
  const body = { xml, profile, certificateId: legacyId && profile === "dgii-ecf" ? legacyId : cert.id };
  if (profile === "xades-epes") body.policy = { identifier: "https://example.com/politica.pdf", hashBase64: "dMoMvtcG5aIzgYo0tIsSQeVJBDnUnfSOfBpxXrmor0Y=" };
  const r = await api("POST", "/v1/xml/sign", body);
  assert(r.verification.valid, `${profile}: verificación ${JSON.stringify(r.verification.errors)}`);
  const v = await api("POST", "/v1/xml/verify", { xml: r.signedXml });
  assert(v.valid, `${profile}: /v1/xml/verify`);
  const t = await api("POST", "/v1/xml/verify", { xml: r.signedXml.replace(/2360\.00|119000\.00|1180\.00/, "1.00") });
  assert(!t.valid, `${profile}: alteración detectada`);
  if (profile === "dian-fe") assert(v.xades?.policyIdentifier?.includes("dian.gov.co") && v.xades?.signerRole === "supplier", "política y rol DIAN");
  if (profile === "dgii-ecf") assert(v.xades === null, "DGII: XMLDSig sin XAdES");
}
const noPolicy = await api("POST", "/v1/xml/sign", { xml: ECF, profile: "xades-epes", certificateId: cert.id }, { raw: true });
assert(noPolicy.status === 400, "XAdES-EPES sin política → 400");
step("firma XML: DGII e-CF, DIAN (EPES con política v2), XAdES-BES y XAdES-EPES válidas; alteraciones detectadas");

// Sobre con sello de empresa
const { envelope } = await api("POST", "/v1/envelopes", { subject: `Sello de empresa ${stamp}` });
const fd = new FormData();
fd.append("file", new Blob([tinyPdf()], { type: "application/pdf" }), "contrato.pdf");
const doc = await api("POST", `/v1/envelopes/${envelope.id}/documents`, fd);
const s1 = randomUUID();
const signerName = `Firmante Evidencia ${stamp}`;
await api("PUT", `/v1/envelopes/${envelope.id}/recipients`, { recipients: [{ id: s1, name: signerName, email: `f+${stamp}@example.com`, channels: ["email"] }] });
await api("PUT", `/v1/envelopes/${envelope.id}/fields`, { fields: [{ documentId: doc.id, recipientId: s1, type: "signature", page: 0, x: 0.1, y: 0.7, width: 0.3, height: 0.08 }] });
const so = await api("PUT", `/v1/envelopes/${envelope.id}/seal-options`, { companySealCertificateId: cert.id, signatureLevel: "advanced" });
assert(so.companySealCertificateId === cert.id && so.signatureLevel === "advanced", "opciones de sello");
await api("POST", `/v1/envelopes/${envelope.id}/send`);
const tk = await linkFor(signerName);
await api("POST", `/v1/signing/${tk}/consent`);
await api("POST", `/v1/signing/${tk}/complete`, { fields: [], signature: { kind: "drawn", imagePng: PNG } });
let detail;
for (let i = 0; i < 90; i++) {
  detail = await api("GET", `/v1/envelopes/${envelope.id}`);
  if (detail.envelope.status === "completed") break;
  await sleep(1000);
}
assert(detail.envelope.status === "completed", `sobre completado (${detail.envelope.status})`);
const pdf = Buffer.from(await (await api("GET", `/v1/envelopes/${envelope.id}/signed.pdf`, null, { raw: true })).arrayBuffer());
const { items: events } = await api("GET", `/v1/envelopes/${envelope.id}/events`);
const seal = events.find((e) => e.type === "envelope.completed").data.seal;
assert(seal.companySeal?.certificateId === cert.id, "evidencia del sello de empresa");
assert(seal.signatureLevel === "advanced", "nivel de firma en la evidencia");
if (LAB) assert(seal.format === "PAdES-B-LTA", `formato B-LTA (fue ${seal.format})`);
step(`sobre completado con sello de empresa: ${seal.format}${seal.ltv ? ` (DSS: ${seal.ltv.ocsps} OCSP, ${seal.ltv.crls} CRL)` : ""}`);

// Validación pública
const vf = new FormData();
vf.append("file", new Blob([pdf], { type: "application/pdf" }), "firmado.pdf");
const report = await api("POST", "/v1/validate", vf);
const sigs = report.signatures.filter((s) => s.kind === "signature");
assert(sigs.length === 2, `dos firmas CAdES (plataforma + empresa), hubo ${sigs.length}`);
assert(report.summary.allValid, `integridad de todas las firmas: ${JSON.stringify(report.signatures.map((s) => s.integrity))}`);
assert(sigs[1].signer?.commonName === cert.commonName, "la segunda firma es el sello de empresa");
if (LAB) {
  assert(report.signatures.some((s) => s.kind === "document_timestamp" && s.coversWholeDocument), "sello de documento que cubre todo");
  assert(report.summary.allTrusted, "cadenas de confianza hasta la raíz del laboratorio");
  assert(sigs.every((s) => s.level === "B-LTA"), `nivel detectado B-LTA: ${sigs.map((s) => s.level)}`);
  assert(sigs.every((s) => s.chain.entries[0].revocation.status === "good"), "revocación good desde el DSS");
}
const tampered = Buffer.from(pdf);
const idx = tampered.indexOf("(CalaSign)");
if (idx > 0) {
  tampered[idx + 1] = "K".charCodeAt(0);
  const tf = new FormData();
  tf.append("file", new Blob([tampered], { type: "application/pdf" }), "alterado.pdf");
  const tr = await api("POST", "/v1/validate", tf);
  assert(!tr.signatures[0].integrity.valid, "alteración detectada por /v1/validate");
}
const vv = new FormData();
vv.append("file", new Blob([pdf], { type: "application/pdf" }), "firmado.pdf");
const verify = await api("POST", "/v1/verify", vv);
assert(verify.match && verify.seal.timestamped === Boolean(ev1.tsaConfigured), "verificación por hash y sello de tiempo");
step(`/v1/validate: ${report.signatures.length} firmas, válidas${LAB ? ", de confianza, B-LTA, revocación good" : ""}; alteración detectada; /v1/verify encuentra el sobre`);

// pdfsig y certificado de finalización
try {
  const dir = mkdtempSync(join(tmpdir(), "ev-"));
  writeFileSync(join(dir, "f.pdf"), pdf);
  let out;
  try {
    out = execFileSync("pdfsig", ["-no-ocsp", join(dir, "f.pdf")], { encoding: "utf8" });
  } catch (e) {
    // pdfsig sale con código ≠ 0 si la raíz no está en su base de confianza; la salida igual sirve.
    if (!e.stdout) throw e;
    out = String(e.stdout);
  }
  assert((out.match(/Signature is Valid/g) ?? []).length >= 2, "pdfsig: dos firmas válidas");
  const txt = execFileSync("pdftotext", [join(dir, "f.pdf"), "-"], { encoding: "utf8" });
  assert(/Sello de empresa/.test(txt) && /Firma electrónica avanzada/.test(txt), "certificado de finalización con sello de empresa y nivel");
  step("pdfsig: firmas íntegras; certificado de finalización muestra sello de empresa y nivel de firma");
} catch (e) {
  if (String(e).includes("falló")) throw e;
  console.warn(`(pdfsig/pdftotext no disponibles: ${String(e).slice(0, 80)})`);
}

// Conectores de firma
const { items: providers } = await api("GET", "/v1/signature-providers");
assert(providers.some((p) => p.type === "platform"), "conector de plataforma");
assert(providers.some((p) => p.id === "calasign-ca"), "placeholder de la CA de Calasign");
if (LAB) {
  const csc = providers.find((p) => p.type === "csc" && p.configured && p.id !== "calasign-ca");
  assert(csc, "conector CSC configurado");
  const t = await api("POST", `/v1/signature-providers/${csc.id}/test`, {});
  assert(t.ok && t.signatureVerified && t.credentials.length > 0, `prueba CSC: ${t.error}`);
  step(`conectores: plataforma, ${csc.id} (firma de prueba por CSC v2 verificada) y calasign-ca (sin configurar)`);
} else step("conectores: plataforma y calasign-ca (sin configurar)");

// Borrado del certificado
await api("DELETE", `/v1/certificates/${cert.id}`, undefined, { raw: true });
const after = await api("GET", "/v1/certificates");
assert(!after.items.some((c) => c.id === cert.id), "certificado borrado");
const gone = await api("POST", "/v1/xml/sign", { xml: ECF, profile: "dgii-ecf", certificateId: cert.id }, { raw: true });
assert(gone.status === 404, "no se puede firmar con un certificado borrado");
step("certificado borrado: material de clave eliminado, ya no firma");

console.log("\nE2E EVIDENCIA OK");
