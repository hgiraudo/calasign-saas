#!/usr/bin/env node
// Prueba de punta a punta de la marca blanca: con "Powered by" oculto y nombre de producto propio, NADA de lo que ve
// un firmante (correos, código OTP, respuestas de /v1/signing, página HTML, PDF firmado, verificación) menciona a la
// plataforma. También: plantillas por evento, remitente con dominio de correo verificado (DKIM), sub-marca por sobre
// (brandId), textos propios, vista previa, tema público y validación del CSS propio.
// Uso: node scripts/e2e-white-label.mjs [baseUrl]   (solo entorno local: usa /dev/dns-stub y el buzón sin sesión)
import { inflateSync } from "node:zlib";
import { randomUUID } from "node:crypto";

const BASE = (process.argv[2] ?? "http://localhost:4000").replace(/\/$/, "");
const stamp = Date.now();
const ok = (m) => console.log(`✓ ${m}`);
const fail = (m) => {
  throw new Error(m);
};
const assert = (c, m) => c || fail(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** La marca de la plataforma, en cualquier forma (nombre, dominio, correo). */
const PLATFORM = /calasign/i;
const noPlatform = (label, s) => {
  const m = PLATFORM.exec(String(s));
  if (m) fail(`${label} menciona a la plataforma: …${String(s).slice(Math.max(0, m.index - 80), m.index + 40)}…`);
};

function client() {
  // Varias cookies (la sesión de la organización y la del firmante tras validar el código).
  const jar = new Map();
  return async function api(method, path, body, { raw = false, headers = {} } = {}) {
    const h = { ...headers };
    if (jar.size) h.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    let payload = body;
    if (body && !(body instanceof FormData)) {
      h["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(BASE + path, { method, headers: h, body: payload, redirect: "manual" });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    if (raw) return res;
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
    return data;
  };
}

function tinyPdf() {
  const objs = [];
  const add = (s) => objs.push(s);
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  const content = "BT /F1 18 Tf 72 760 Td (Contrato marca blanca) Tj ET";
  add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`);
  add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
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
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAAAAADhZOFXAAAADElEQVR4nGNgoA4AAABIAAEuuDx+AAAAAElFTkSuQmCC";

/**
 * Texto de un PDF: bytes crudos + streams descomprimidos (+ cadenas hexadecimales). Se excluyen los certificados X.509
 * y firmas CMS (DER: empiezan con 0x30): el certificado del sello de la plataforma lo elige el operador (en local es
 * "CalaSign Local Dev Root CA"); ver docs/MARCA-BLANCA.md, "Certificado del sello".
 */
function pdfStrings(buf) {
  const raw = buf.toString("latin1");
  const parts = [raw];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    try {
      const inflated = inflateSync(buf.subarray(start, end));
      if (inflated[0] !== 0x30) parts.push(inflated.toString("latin1"));
    } catch {
      /* no comprimido o no es Flate */
    }
  }
  const all = parts.join("\n");
  const hex = [...all.matchAll(/<([0-9A-Fa-f\s]{8,})>/g)]
    .map((x) => Buffer.from(x[1].replace(/\s/g, ""), "hex"))
    .filter((b) => b[0] !== 0x30)
    .map((b) => b.toString("latin1"))
    .join("\n");
  return `${all}\n${hex}`;
}

const mailbox = async (api, pred, what) => {
  for (let i = 0; i < 120; i++) {
    const { items } = await api("GET", "/dev/mailbox");
    const m = items.find(pred);
    if (m) return m;
    await sleep(500);
  }
  fail(`no llegó: ${what}`);
};

const api = client();
const org = `Seguros Andinos ${stamp}`;
const me = await api("POST", "/v1/auth/signup", {
  name: "Ana Admin",
  email: `ana+wl${stamp}@example.com`,
  password: "una-clave-segura-123",
  organization: org,
  locale: "es",
});
ok("alta de la organización");

// ───────── Validaciones ─────────
const badCss = await api(
  "PUT",
  "/v1/settings/brands/default",
  { config: { customCss: "body{background:url(https://evil.example/x.png)}" } },
  { raw: true },
);
assert(badCss.status === 400, `CSS con url() debería rechazarse (HTTP ${badCss.status})`);
const badFrom = await api("PUT", "/v1/settings/brands/default", { config: { email: { fromEmail: "firmas@no-verificado.test" } } }, { raw: true });
assert(badFrom.status === 400, `un remitente de un dominio no registrado debería rechazarse (HTTP ${badFrom.status})`);
ok("CSS con url() y remitente sin dominio rechazados");

// ───────── Dominio de correo propio (SPF/DKIM) con DNS de prueba ─────────
const mailDomain = `andinos${stamp}.test`;
const ed = await api("POST", "/v1/settings/email-domains", { domain: mailDomain });
assert(ed.status === "pending" && ed.records.some((r) => r.purpose === "dkim" && r.required), "registros del dominio de correo");
for (const r of ed.records.filter((x) => x.required)) await api("POST", "/dev/dns-stub", { name: r.name, values: [r.value] });
const edv = await api("POST", `/v1/settings/email-domains/${mailDomain}/verify`);
assert(edv.status === "verified", `dominio de correo no verificado: ${edv.lastError}`);
noPlatform("registros DNS del dominio de correo", JSON.stringify(edv.records.map((r) => r.name)));
ok("dominio de correo verificado (TXT de propiedad + DKIM)");

// ───────── Marca de la organización: marca blanca total ─────────
const config = {
  productName: "FirmaAndina",
  hidePoweredBy: true,
  theme: {
    primaryColor: "#123456",
    secondaryColor: "#aa5500",
    buttonColor: "#00aa55",
    backgroundColor: "#fafafa",
    textColor: "#111111",
    borderRadius: 4,
    fontFamily: "Montserrat",
    fontSource: "google",
  },
  links: { supportUrl: "https://ayuda.andinos.test", privacyUrl: "https://andinos.test/privacidad", termsUrl: "https://andinos.test/terminos" },
  email: {
    fromName: "Firmas Andinos",
    fromEmail: `firmas@${mailDomain}`,
    replyTo: "ayuda@andinos.test",
    footer: "Seguros Andinos S.A. · Av. Siempre Viva 123",
  },
  templates: {
    invite: {
      es: {
        subject: "{{organizationName}} necesita tu firma: {{subject}}",
        body: "Hola {{recipientName}}:\n\n{{senderName}} te pidió firmar «{{subject}}» con {{productName}}.",
        cta: "Firmar ahora",
      },
    },
    otp_code: { es: { subject: "Código {{code}} para {{subject}}", body: "Tu código de {{productName}} es {{code}}." } },
  },
  texts: { es: { "sign.doneTitle": "¡Listo, gracias por firmar!" } },
  customCss: ".signer-bar{letter-spacing:.02em}",
};
let brand = await api("PUT", "/v1/settings/brands/default", { config });
assert(brand.effective.whiteLabel && brand.effective.productName === "FirmaAndina", "marca blanca guardada");
assert(brand.emailSender.customDomain && brand.emailSender.from.includes(`firmas@${mailDomain}`), `remitente propio: ${brand.emailSender.from}`);
assert(brand.effective.css.includes("#123456") && brand.effective.css.includes("letter-spacing"), "CSS del tema + CSS propio");
const fd = new FormData();
fd.append("file", new Blob([Buffer.from(PNG_B64, "base64")], { type: "image/png" }), "logo.png");
brand = await api("POST", "/v1/settings/brands/default/assets/logo", fd);
assert(brand.assets.logoUrl, "logo subido");
const fav = new FormData();
fav.append("file", new Blob([Buffer.from(PNG_B64, "base64")], { type: "image/png" }), "favicon.png");
brand = await api("POST", "/v1/settings/brands/default/assets/favicon", fav);
assert(brand.assets.faviconUrl, "favicon subido");
const logoRes = await fetch(BASE + brand.assets.logoUrl);
assert(logoRes.ok && logoRes.headers.get("content-type") === "image/png", "logo público");
ok("marca blanca total configurada (tema, textos, plantillas, remitente, logo, favicon)");

// Vista previa (sin guardar) y tema público.
const prev = await api("POST", "/v1/settings/brands/default/preview", {
  kind: "email",
  event: "invite",
  locale: "es",
  config: { ...config, templates: { invite: { es: { subject: "Vista previa {{subject}}" } } } },
});
assert(prev.subject.startsWith("Vista previa"), `vista previa: ${prev.subject}`);
noPlatform("vista previa del correo", prev.html + prev.subject + prev.from);
const pub = await api("GET", `/v1/public/brand-theme?b=${encodeURIComponent(brand.slug)}`);
assert(pub.productName === "FirmaAndina" && pub.faviconUrl, "tema público por ?b=");
ok("vista previa de correo y tema público");

// ───────── Sobre con OTP por correo ─────────
const { envelope } = await api("POST", "/v1/envelopes", { subject: `Póliza ${stamp}`, message: "Gracias por confiar en nosotros" });
const docFd = new FormData();
docFd.append("file", new Blob([tinyPdf()], { type: "application/pdf" }), "poliza.pdf");
const doc = await api("POST", `/v1/envelopes/${envelope.id}/documents`, docFd);
const sid = randomUUID();
const signer = `Carla Firmante ${stamp}`;
await api("PUT", `/v1/envelopes/${envelope.id}/recipients`, {
  recipients: [{ id: sid, name: signer, email: `carla+${stamp}@example.com`, routingOrder: 1, channels: ["email"], authMethod: "otp_email" }],
});
await api("PUT", `/v1/envelopes/${envelope.id}/fields`, {
  fields: [{ documentId: doc.id, recipientId: sid, type: "signature", page: 0, x: 0.1, y: 0.7, width: 0.3, height: 0.08 }],
});
await api("POST", `/v1/envelopes/${envelope.id}/send`);

const invite = await mailbox(api, (m) => m.channel === "email" && m.text.includes(signer) && m.link?.includes("/s/"), "invitación");
assert(invite.subject === `${org} necesita tu firma: Póliza ${stamp}`, `asunto de la plantilla: ${invite.subject}`);
assert(invite.from.includes("Firmas Andinos") && invite.from.includes(`firmas@${mailDomain}`), `remitente: ${invite.from}`);
assert(invite.html.includes("#00aa55") && invite.html.includes("Firmar ahora") && invite.html.includes("Montserrat"), "HTML con el tema de la marca");
assert(invite.html.includes("Av. Siempre Viva"), "pie propio");
noPlatform("correo de invitación", [invite.from, invite.subject, invite.text, invite.html, invite.link].join("\n"));
ok("invitación con plantilla, tema, remitente propio y sin la plataforma");

const token = invite.link.split("/s/")[1];
let sess = await api("GET", `/v1/signing/${token}`);
noPlatform("sesión de firma (antes del código)", JSON.stringify(sess));
assert(sess.theme?.whiteLabel && sess.theme.texts?.es?.["sign.doneTitle"], "la sesión trae el tema y los textos");
await api("POST", `/v1/signing/${token}/otp/send`);
const otpMail = await mailbox(
  api,
  (m) => m.channel === "email" && m.to === `carla+${stamp}@example.com` && /^Código \d{6}/.test(m.subject),
  "código OTP",
);
noPlatform("correo del código", [otpMail.from, otpMail.subject, otpMail.text].join("\n"));
const code = /(\d{6})/.exec(otpMail.text)[1];
await api("POST", `/v1/signing/${token}/otp/verify`, { code });
sess = await api("GET", `/v1/signing/${token}`);
noPlatform("sesión de firma", JSON.stringify(sess));
ok("código OTP con la plantilla de la marca");

// Página HTML del firmante: título, favicon, CSS y datos de la marca inyectados por el servidor.
const page = await fetch(`${BASE}/s/${token}`);
const html = await page.text();
if (page.headers.get("content-type")?.includes("text/html")) {
  assert(html.includes("<title>FirmaAndina</title>") && html.includes('id="brand-data"') && html.includes("#123456"), "index.html con la marca");
  noPlatform("index.html del firmante", html.replace(/\/assets\/[^"]+/g, ""));
  ok("página del firmante con la marca inyectada (sin la plataforma)");
} else console.log("· (sin la web compilada: no se revisa el HTML)");

sess = await api("POST", `/v1/signing/${token}/consent`);
sess = await api("POST", `/v1/signing/${token}/complete`, { fields: [], signature: { kind: "drawn", imagePng: PNG_B64 } });
noPlatform("respuesta de firma", JSON.stringify(sess));
let detail;
for (let i = 0; i < 90; i++) {
  detail = await api("GET", `/v1/envelopes/${envelope.id}`);
  if (detail.envelope.status === "completed") break;
  await sleep(1000);
}
assert(detail.envelope.status === "completed", `no se completó: ${detail.envelope.status}`);
sess = await api("GET", `/v1/signing/${token}`);
noPlatform("sesión final", JSON.stringify(sess));

const completedMail = await mailbox(
  api,
  (m) => m.channel === "email" && m.to === `carla+${stamp}@example.com` && m.subject.startsWith("Completado"),
  "aviso de completado",
);
noPlatform("correo de completado", [completedMail.from, completedMail.subject, completedMail.text, completedMail.html].join("\n"));

const pdfRes = await fetch(`${BASE}/v1/signing/${token}/signed.pdf`, { headers: { cookie: "" } });
let pdf = pdfRes.ok ? Buffer.from(await pdfRes.arrayBuffer()) : null;
if (!pdf) pdf = Buffer.from(await (await api("GET", `/v1/envelopes/${envelope.id}/signed.pdf`, null, { raw: true })).arrayBuffer());
const pdfText = pdfStrings(pdf);
assert(pdfText.includes("FirmaAndina"), "el PDF nombra al producto de la marca");
noPlatform("PDF firmado (metadatos, sello, certificado)", pdfText.replace(/\/BaseFont\s*\/[A-Z]+\+?[^\s/]*/g, ""));
ok("correo de completado y PDF firmado sin la plataforma (Producer, Reason, certificado)");

const vfd = new FormData();
vfd.append("file", new Blob([pdf], { type: "application/pdf" }), "firmado.pdf");
const ver = await api("POST", "/v1/verify", vfd);
assert(ver.match, "verificación");
noPlatform("verificación", JSON.stringify(ver));
const vpage = await fetch(`${BASE}/verify?b=${encodeURIComponent(brand.slug)}`);
if (vpage.headers.get("content-type")?.includes("text/html"))
  noPlatform("página de verificación", (await vpage.text()).replace(/\/assets\/[^"]+/g, ""));
ok("verificación sin la plataforma");

// ───────── Sub-marca por sobre ─────────
const sub = await api("POST", "/v1/settings/brands", {
  name: `Cliente Uno ${stamp}`,
  config: { productName: "UnoFirma", theme: { primaryColor: "#990000", buttonColor: "#990000" } },
});
assert(sub.id !== "default" && sub.effective.productName === "UnoFirma" && sub.effective.whiteLabel, "sub-marca hereda la marca blanca");
const badBrand = await api("POST", "/v1/envelopes", { subject: "x", brandId: randomUUID() }, { raw: true });
assert(badBrand.status === 400, `brandId de otra organización debería rechazarse (HTTP ${badBrand.status})`);
const { envelope: e2 } = await api("POST", "/v1/envelopes", { subject: `Contrato Uno ${stamp}`, brandId: sub.id });
assert(e2.brandId === sub.id, "el sobre guarda su marca");
const d2 = new FormData();
d2.append("file", new Blob([tinyPdf()], { type: "application/pdf" }), "c.pdf");
const doc2 = await api("POST", `/v1/envelopes/${e2.id}/documents`, d2);
const s2 = randomUUID();
await api("PUT", `/v1/envelopes/${e2.id}/recipients`, {
  recipients: [{ id: s2, name: `Pedro ${stamp}`, email: `pedro+${stamp}@example.com`, routingOrder: 1, channels: ["email"] }],
});
await api("PUT", `/v1/envelopes/${e2.id}/fields`, {
  fields: [{ documentId: doc2.id, recipientId: s2, type: "signature", page: 0, x: 0.1, y: 0.7, width: 0.3, height: 0.08 }],
});
await api("POST", `/v1/envelopes/${e2.id}/send`);
const inv2 = await mailbox(api, (m) => m.channel === "email" && m.text.includes(`Pedro ${stamp}`), "invitación de la sub-marca");
assert(inv2.html.includes("#990000") && inv2.text.includes("UnoFirma"), "correo con la sub-marca");
assert(inv2.subject.startsWith(`Cliente Uno ${stamp} necesita tu firma`), `la sub-marca hereda la plantilla con su nombre: ${inv2.subject}`);
noPlatform("correo de la sub-marca", [inv2.from, inv2.subject, inv2.text, inv2.html].join("\n"));
const t2 = inv2.link.split("/s/")[1];
const sess2 = await api("GET", `/v1/signing/${t2}`);
assert(sess2.theme.productName === "UnoFirma" && sess2.envelope.organizationName === `Cliente Uno ${stamp}`, "la sesión usa la sub-marca");
noPlatform("sesión de la sub-marca", JSON.stringify(sess2));
ok("sub-marca por sobre (brandId): correos y sesión con su marca");

// ───────── Control: una organización sin marca blanca sí ve la plataforma ─────────
const api2 = client();
await api2("POST", "/v1/auth/signup", {
  name: "Otro",
  email: `otro+wl${stamp}@example.com`,
  password: "una-clave-segura-123",
  organization: `Control ${stamp}`,
  locale: "es",
});
const prevCtl = await api2("POST", "/v1/settings/brands/default/preview", { kind: "email", event: "invite", locale: "es" });
assert(PLATFORM.test(prevCtl.html), "control: sin marca blanca el correo menciona la plataforma (la prueba detecta la marca)");
ok("control: la detección funciona (organización sin marca blanca)");

const list = await api("GET", "/v1/settings/brands");
assert(list.items.length === 2, "dos marcas");
await api("DELETE", `/v1/settings/brands/${sub.id}`, null, { raw: true });
ok(`fin (${me.user?.email ?? "ok"})`);
