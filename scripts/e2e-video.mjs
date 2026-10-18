#!/usr/bin/env node
// Prueba de punta a punta de la sala de firma por video (señalización por WebSocket, co-navegación,
// consentimiento, grabación en fragmentos, identidad en cámara, evidencia y certificado).
// Uso: node scripts/e2e-video.mjs [baseUrl]   (entorno local: lee el buzón de desarrollo sin sesión)
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const BASE = (process.argv[2] ?? "http://localhost:4000").replace(/\/$/, "");
const WS_BASE = BASE.replace(/^http/, "ws");
let cookie = "";

async function api(method, path, body, { raw = false, headers = {}, useCookie = true } = {}) {
  const h = { ...headers };
  if (cookie && useCookie) h.cookie = cookie;
  let payload = body;
  if (body && !(body instanceof FormData) && !Buffer.isBuffer(body)) {
    h["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers: h, body: payload });
  const set = res.headers.get("set-cookie");
  if (set && useCookie) cookie = set.split(";")[0];
  if (raw) return res;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw Object.assign(new Error(`${method} ${path} → ${res.status} ${text}`), { status: res.status, data });
  return data;
}

async function expectStatus(status, fn, what) {
  try {
    await fn();
  } catch (e) {
    if (e.status === status) return e.data;
    throw new Error(`${what}: se esperaba ${status} y vino ${e.status ?? e.message}`);
  }
  throw new Error(`${what}: se esperaba ${status} y salió bien`);
}

const step = (m) => console.log(`✓ ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(c, m) {
  if (!c) throw new Error(`falló: ${m}`);
}

function tinyPdf() {
  const objs = [];
  const add = (s) => objs.push(s);
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>");
  for (let i = 0; i < 2; i++) {
    const content = `BT /F1 18 Tf 72 760 Td (Contrato video E2E - pagina ${i + 1}) Tj ET`;
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${objs.length + 2} 0 R /Resources << /Font << /F1 7 0 R >> >> >>`);
    add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
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
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function mailboxFind(pred) {
  for (let i = 0; i < 40; i++) {
    const { items } = await api("GET", "/dev/mailbox");
    const m = items.find(pred);
    if (m) return m;
    await sleep(500);
  }
  throw new Error("no llegó el mensaje esperado al buzón");
}

/** Cliente WebSocket con cola de mensajes. */
function connect(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_BASE + path, { headers });
    const queue = [];
    const waiters = [];
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      const i = waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
      else queue.push(msg);
    });
    ws.on("unexpected-response", (_req, res) => reject(Object.assign(new Error(`ws HTTP ${res.statusCode}`), { status: res.statusCode })));
    ws.on("error", (e) => reject(e));
    ws.on("open", () =>
      resolve({
        ws,
        send: (m) => ws.send(JSON.stringify(m)),
        next(pred, ms = 5000) {
          const p = typeof pred === "string" ? (m) => m.type === pred : pred;
          const i = queue.findIndex(p);
          if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
          return new Promise((res, rej) => {
            const w = { pred: p, resolve: res };
            waiters.push(w);
            setTimeout(() => {
              const k = waiters.indexOf(w);
              if (k >= 0) {
                waiters.splice(k, 1);
                rej(new Error(`timeout esperando mensaje (${typeof pred === "string" ? pred : "predicado"})`));
              }
            }, ms);
          });
        },
        drain: () => queue.splice(0),
        close: () => ws.close(),
      }),
    );
  });
}

async function wsStatus(path, headers = {}) {
  try {
    const c = await connect(path, headers);
    const first = await c.next(() => true, 3000).catch(() => null);
    c.close();
    return { status: 101, first };
  } catch (e) {
    return { status: e.status ?? 0 };
  }
}

// ───────────────────────────── Preparación ─────────────────────────────

const stamp = Date.now();
await api("POST", "/v1/auth/signup", { name: "Ana Anfitriona", email: `ana+video${stamp}@example.com`, password: "una-clave-segura-123", organization: `Video ${stamp}` });
const hostCookie = cookie;
const { envelope } = await api("POST", "/v1/envelopes", { subject: `Contrato por video ${stamp}` });
const fd = new FormData();
fd.append("file", new Blob([tinyPdf()], { type: "application/pdf" }), "contrato.pdf");
const doc = await api("POST", `/v1/envelopes/${envelope.id}/documents`, fd);
const s1 = randomUUID();
const s2 = randomUUID();
const n1 = `Lucía Video ${stamp}`;
const n2 = `Pedro Video ${stamp}`;
await api("PUT", `/v1/envelopes/${envelope.id}/recipients`, {
  recipients: [
    { id: s1, name: n1, email: `lucia+${stamp}@example.com`, routingOrder: 1, idDocumentType: "dni", idDocumentNumber: "45.123.456" },
    { id: s2, name: n2, email: `pedro+${stamp}@example.com`, routingOrder: 1 },
  ],
});
await api("PUT", `/v1/envelopes/${envelope.id}/fields`, {
  fields: [
    { documentId: doc.id, recipientId: s1, type: "signature", page: 1, x: 0.1, y: 0.7, width: 0.3, height: 0.08 },
    { documentId: doc.id, recipientId: s2, type: "signature", page: 1, x: 0.55, y: 0.7, width: 0.3, height: 0.08 },
  ],
});
// Sala antes de enviar: no se puede.
await expectStatus(409, () => api("POST", `/v1/envelopes/${envelope.id}/video-sessions`, {}), "sala con el sobre en borrador");
await api("POST", `/v1/envelopes/${envelope.id}/send`);
const t1 = (await mailboxFind((x) => x.text.includes(n1) && x.link?.includes("/s/") && !x.link.includes("video=1"))).link.split("/s/")[1];
const t2 = (await mailboxFind((x) => x.text.includes(n2) && x.link?.includes("/s/") && !x.link.includes("video=1"))).link.split("/s/")[1];
step("sobre enviado a dos firmantes en paralelo");

// ───────────────────────────── Sala ─────────────────────────────

const session = await api("POST", `/v1/envelopes/${envelope.id}/video-sessions`, {
  recipientIds: [s1, s2],
  requireIdentityConfirmation: true,
  scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
});
assert(session.status === "scheduled" && session.invitedRecipientIds.length === 2, "sala programada");
await expectStatus(409, () => api("POST", `/v1/envelopes/${envelope.id}/video-sessions`, {}), "segunda sala abierta");
const invite = await mailboxFind((x) => x.to === `lucia+${stamp}@example.com` && x.link?.includes("video=1"));
assert(invite.subject.includes("Videollamada"), "invitación por video");
const info = await api("GET", `/v1/signing/${t1}/video`, null, { useCookie: false });
assert(info.session?.id === session.id && info.session.requireIdentityConfirmation, "el firmante ve la sala");
step("sala programada, invitaciones enviadas, una sola sala abierta por sobre");

// Autenticación del WebSocket.
assert((await wsStatus(`/v1/envelopes/${envelope.id}/video-sessions/${session.id}/ws`)).status === 401, "anfitrión sin sesión → 401");
assert((await wsStatus(`/v1/signing/${"x".repeat(43)}/video/ws`)).status === 404, "token inválido → 404");
step("WebSocket rechaza conexiones sin autenticación (401) y links inválidos (404)");

const host = await connect(`/v1/envelopes/${envelope.id}/video-sessions/${session.id}/ws`, { cookie: hostCookie });
const hw = await host.next("welcome");
assert(hw.you.kind === "host" && hw.peers.length === 0 && hw.iceServers.length >= 1 && hw.controller === hw.you.id, "bienvenida del anfitrión");
const active = await api("GET", `/v1/envelopes/${envelope.id}/video-sessions/${session.id}`);
assert(active.status === "active" && active.startedAt, "la sala pasa a activa cuando entra el anfitrión");

const a = await connect(`/v1/signing/${t1}/video/ws`);
const aw = await a.next("welcome");
assert(aw.you.kind === "recipient" && aw.peers.length === 1 && aw.peers[0].id === hw.you.id, "bienvenida del firmante con el anfitrión como par");
const pj = await host.next("peer_joined");
assert(pj.peer.id === aw.you.id && pj.peer.name === n1, "el anfitrión ve entrar al firmante");
step("anfitrión y firmante conectados por WebSocket");

// Señalización: oferta, respuesta y candidatos se reenvían al par indicado.
a.send({ type: "signal", to: hw.you.id, data: { sdp: { type: "offer", sdp: "v=0 fake-offer" } } });
const off = await host.next("signal");
assert(off.from === aw.you.id && off.data.sdp.type === "offer", "oferta reenviada");
host.send({ type: "signal", to: aw.you.id, data: { sdp: { type: "answer", sdp: "v=0 fake-answer" } } });
const ans = await a.next("signal");
assert(ans.from === hw.you.id && ans.data.sdp.type === "answer", "respuesta reenviada");
host.send({ type: "signal", to: aw.you.id, data: { candidate: { candidate: "candidate:1 1 udp 1 127.0.0.1 9 typ host", sdpMid: "0" } } });
assert((await a.next("signal")).data.candidate, "candidato reenviado");
host.send({ type: "signal", to: "nadie", data: {} });
assert((await host.next("error")).code === "unknown_peer", "par desconocido");
step("señalización WebRTC: oferta, respuesta y candidatos reenviados entre pares");

// Co-navegación.
a.send({ type: "cobrowse", state: { documentId: doc.id, page: 1, scroll: 0.5, zoom: 1, fieldId: null } });
assert((await a.next("error")).code === "not_controller", "solo guía quien tiene el control");
host.send({ type: "cobrowse", state: { documentId: doc.id, page: 1, scroll: 0.42, zoom: 1.25, fieldId: null } });
const cb = await a.next("cobrowse");
assert(cb.from === hw.you.id && cb.state.page === 1 && cb.state.scroll === 0.42 && cb.state.zoom === 1.25, "el firmante sigue al anfitrión");
host.send({ type: "control", to: aw.you.id });
await a.next((m) => m.type === "control" && m.controller === aw.you.id);
await host.next((m) => m.type === "control" && m.controller === aw.you.id);
a.send({ type: "cobrowse", state: { documentId: doc.id, page: 0, scroll: 0.1, zoom: 1, fieldId: "x" } });
assert((await host.next("cobrowse")).state.fieldId === "x", "el anfitrión sigue al firmante con el control");
a.send({ type: "control", to: hw.you.id });
await host.next((m) => m.type === "control" && m.controller === hw.you.id);
step("co-navegación: guía quien tiene el control; el anfitrión lo cede y el firmante lo devuelve");

// ───────────────────────────── Grabación ─────────────────────────────

const base = `/v1/envelopes/${envelope.id}/video-sessions/${session.id}`;
const missing = await expectStatus(409, () => api("POST", `${base}/recording/start`, {}), "grabar sin consentimiento");
assert(missing.error.code === "consent_required", "consent_required");
host.send({ type: "consent", granted: true });
a.send({ type: "consent", granted: true });
await host.next((m) => m.type === "recording" && m.consentRequired === false, 5000);
const { recordingId } = await api("POST", `${base}/recording/start`, { mimeType: "video/webm;codecs=vp8,opus" });
await host.next((m) => m.type === "recording" && m.status === "recording");
const chunks = [randomBytes(70_000), randomBytes(50_000), randomBytes(30_000)];
const put = (seq, buf) => api("PUT", `${base}/recording/chunks/${seq}`, buf, { headers: { "content-type": "video/webm" } });
await put(0, chunks[0]);
await put(1, chunks[1]);
assert((await put(1, chunks[1])).duplicate === true, "reintento idempotente");
await expectStatus(409, () => put(3, chunks[2]), "fragmento fuera de orden");
await expectStatus(409, () => put(1, chunks[2]), "fragmento repetido con otro contenido");
step("grabación: exige consentimiento de todos, fragmentos en orden, reintentos idempotentes");

// Entra un segundo firmante sin consentir: se frenan los fragmentos hasta que consienta.
const b = await connect(`/v1/signing/${t2}/video/ws`);
const bw = await b.next("welcome");
assert(bw.peers.length === 2 && bw.recording.status === "recording" && bw.recording.consentRequired, "el nuevo ve que se graba y que falta su consentimiento");
await expectStatus(409, () => put(2, chunks[2]), "fragmento con un participante sin consentimiento");
b.send({ type: "consent", granted: true });
await host.next((m) => m.type === "recording" && m.consentRequired === false, 5000);
await put(2, chunks[2]);
const stop = await api("POST", `${base}/recording/stop`, {});
const whole = Buffer.concat(chunks);
const expected = createHash("sha256").update(whole).digest("hex");
assert(stop.sha256 === expected && stop.bytes === whole.length && stop.chunks === 3, "SHA-256 de la grabación completa");
const dl = await api("GET", `${base}/recordings/${recordingId}`, null, { raw: true });
const got = Buffer.from(await dl.arrayBuffer());
assert(dl.status === 200 && got.equals(whole) && dl.headers.get("x-content-sha256") === expected, "descarga descifrada idéntica");
step(`grabación cerrada: 3 fragmentos cifrados, SHA-256 ${expected.slice(0, 12)}…, descarga idéntica`);

// ───────────────────────────── Identidad y firma ─────────────────────────────

await api("POST", `/v1/signing/${t1}/consent`, null, { useCookie: false });
const blocked = await expectStatus(
  403,
  () => api("POST", `/v1/signing/${t1}/complete`, { fields: [], signature: { kind: "drawn", imagePng: PNG } }, { useCookie: false }),
  "firmar sin identidad confirmada",
);
assert(blocked.error.code === "identity_confirmation_required", "identity_confirmation_required");
const det = await api("GET", base);
const p1 = det.participants.find((p) => p.recipientId === s1);
const p2 = det.participants.find((p) => p.recipientId === s2);
assert(p1?.online && p2?.online && p1.consentedAt, "participantes conectados con consentimiento");
await api("POST", `${base}/participants/${p1.id}/identity`, { confirmed: true, note: "DNI exhibido en cámara", idDocumentNumber: "45123456" });
const upd = await host.next((m) => m.type === "peer_updated" && m.peer.id === p1.id && m.peer.identityConfirmed);
assert(upd.peer.identityConfirmed, "aviso de identidad confirmada");
await api("POST", `/v1/signing/${t1}/complete`, { fields: [], signature: { kind: "drawn", imagePng: PNG } }, { useCookie: false });
await api("POST", `${base}/participants/${p2.id}/identity`, { confirmed: true, note: "Cédula exhibida" });
await api("POST", `/v1/signing/${t2}/consent`, null, { useCookie: false });
await api("POST", `/v1/signing/${t2}/complete`, { fields: [], signature: { kind: "typed", imagePng: PNG, text: "Pedro" } }, { useCookie: false });
step("identidad confirmada en cámara por el anfitrión; recién entonces cada firmante pudo firmar");

// Fin de la sala: todos reciben "ended".
const ended = await api("POST", `${base}/end`, {});
assert(ended.status === "ended", "sala terminada");
await a.next("ended");
await b.next("ended");
step("el anfitrión cierra la sala y los participantes reciben el aviso");
host.close();

// ───────────────────────────── Evidencia y certificado ─────────────────────────────

let detail;
for (let i = 0; i < 60; i++) {
  detail = await api("GET", `/v1/envelopes/${envelope.id}`);
  if (detail.envelope.status === "completed") break;
  await sleep(1000);
}
assert(detail.envelope.status === "completed", `sobre completado (${detail.envelope.status})`);
const { items: events } = await api("GET", `/v1/envelopes/${envelope.id}/events`);
const types = events.map((e) => e.type);
for (const t of [
  "video.session_scheduled",
  "video.session_started",
  "video.participant_joined",
  "video.recording_consented",
  "video.recording_started",
  "video.recording_stored",
  "recipient.identity_confirmed",
  "video.session_ended",
])
  assert(types.includes(t), `evento ${t}`);
const stored = events.find((e) => e.type === "video.recording_stored");
assert(stored.data.sha256 === expected, "hash de la grabación en la evidencia");
const idc = events.find((e) => e.type === "recipient.identity_confirmed" && e.data.method === "video" && e.data.recipientId === s1);
assert(idc && idc.data.idDocumentMatches === true, "documento coincide con el declarado");
const pdf = Buffer.from(await (await api("GET", `/v1/envelopes/${envelope.id}/signed.pdf`, null, { raw: true })).arrayBuffer());
const dir = mkdtempSync(join(tmpdir(), "e2e-video-"));
writeFileSync(join(dir, "signed.pdf"), pdf);
const txt = execFileSync("pdftotext", [join(dir, "signed.pdf"), "-"], { encoding: "utf8" });
assert(/Sesiones por video/.test(txt), "sección de video en el certificado");
assert(txt.replace(/\s+/g, "").includes(expected), "hash de la grabación en el certificado");
step("evidencia encadenada y certificado con la sesión por video y el SHA-256 de la grabación");

console.log("\nE2E VIDEO OK");
