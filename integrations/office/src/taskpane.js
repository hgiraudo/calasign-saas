// Panel del complemento de CalaSign para Word y Outlook.
// Word: toma el documento abierto como PDF (o un PDF elegido) y lo envía a firmar.
// Outlook (lectura): envía a firmar un PDF adjunto del correo, con el remitente precargado como firmante.
// Pasos contra la API v1: crear sobre (Idempotency-Key) → subir PDF → destinatarios → campos → confirmar → enviar.
import { ApiError, api, appUrl, uuid } from "./api.js";
import { currentTokens, signIn, signOut, useApiKey } from "./auth.js";
import { applyTranslations, envelopeLocale, setLanguage, t } from "./i18n.js";
import { appendSignaturePage } from "./signature-page.js";

const $ = (id) => document.getElementById(id);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLICE = 4 * 1024 * 1024; // máximo de getFileAsync en escritorio (4 MB)

let host = "word"; // word | outlook
let busy = false;
let pending = null; // lo que se va a enviar (después de "Revisar")

// ───────── Mensajes y vistas ─────────

function show(...ids) {
  for (const v of ["view-login", "view-send", "view-confirm", "view-done", "view-recent"]) $(v).classList.toggle("hidden", !ids.includes(v));
  $("signout").classList.toggle("hidden", ids.includes("view-login"));
}

function message(text, kind = "info", link) {
  const el = $("msg");
  el.textContent = text || "";
  el.classList.toggle("hidden", !text);
  el.classList.toggle("error", kind === "error");
  if (link) {
    const a = document.createElement("a");
    a.href = link.href;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = ` ${link.text}`;
    el.appendChild(a);
  }
}

function setBusy(b, text) {
  busy = b;
  for (const id of ["review", "send", "back", "login", "apikey-save"]) $(id).disabled = b;
  if (text) message(text);
}

function errorText(e) {
  if (e instanceof ApiError) {
    if (e.status === 0) return t("errNetwork");
    if (e.code === "anchor_not_found") return t("errAnchorNotFound", { anchor: e.details?.anchor ?? "" });
    if (e.status === 401) return t("errSession");
    if (e.code === "envelope_incomplete" && Array.isArray(e.details?.problems)) return e.details.problems.map((p) => (p && typeof p === "object" ? p.message : String(p))).join(". ");
    return e.message;
  }
  return String(e?.message ?? e);
}

// ───────── Sesión ─────────

async function afterLogin() {
  try {
    const me = await api("/v1/me");
    const who = [me.user?.name || me.user?.email, me.tenant?.name].filter(Boolean).join(" · ");
    $("whoami").textContent = t("signedInAs", { who });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      signOut();
      show("view-login");
      message(t("errSession"), "error");
      return;
    }
  }
  show("view-send", "view-recent");
  loadRecent();
}

async function onLogin() {
  setBusy(true);
  message("");
  try {
    await signIn();
    await afterLogin();
  } catch (e) {
    if (e.closed) message("");
    else if (e.dialogCode) message(t("errDialog", { code: e.dialogCode }), "error");
    else message(t("errLogin", { error: e.message }), "error");
  } finally {
    setBusy(false);
  }
}

// ───────── Firmantes ─────────

function addSigner(name = "", email = "") {
  const tpl = $("signer-row").content.cloneNode(true);
  applyTranslations(tpl);
  const row = tpl.querySelector(".signer");
  const n = $("signers").children.length + 1;
  row.querySelector(".s-name").placeholder = t("name");
  row.querySelector(".s-name").value = name;
  row.querySelector(".s-email").placeholder = t("email");
  row.querySelector(".s-email").value = email;
  row.querySelector(".s-order").value = String(n === 1 ? 1 : Math.max(...[...$("signers").querySelectorAll(".s-order")].map((i) => Number(i.value) || 1)) + 1);
  // Primer ancla libre: con la cantidad de filas, quitar una del medio y agregar otra repetía el ancla de la última
  // (y los dos campos de firma caían en el mismo lugar).
  const used = new Set([...$("signers").querySelectorAll(".s-anchor")].map((i) => i.value.trim()));
  let k = 1;
  while (used.has(`[[firma_${k}]]`)) k++;
  row.querySelector(".s-anchor").value = `[[firma_${k}]]`;
  row.querySelector(".s-remove").addEventListener("click", () => {
    row.remove();
    if (!$("signers").children.length) addSigner();
  });
  row.querySelector(".s-insert").addEventListener("click", () => insertAnchor(row.querySelector(".s-anchor").value));
  $("signers").appendChild(row);
  syncPlacement();
}

function readSigners() {
  return [...$("signers").querySelectorAll(".signer")]
    .map((r) => ({
      name: r.querySelector(".s-name").value.trim(),
      email: r.querySelector(".s-email").value.trim(),
      order: Math.min(100, Math.max(1, Math.trunc(Number(r.querySelector(".s-order").value) || 1))),
      anchor: r.querySelector(".s-anchor").value.trim(),
    }))
    .filter((s) => s.name || s.email);
}

function placement() {
  return document.querySelector('input[name="place"]:checked')?.value ?? "page";
}

function syncPlacement() {
  const anchor = placement() === "anchor";
  $("anchor-help").classList.toggle("hidden", !anchor);
  for (const w of document.querySelectorAll(".anchor-wrap")) w.classList.toggle("hidden", !anchor);
  for (const b of document.querySelectorAll(".s-insert")) b.classList.toggle("hidden", host !== "word");
}

/** Word: escribe el texto ancla en el cursor (reemplaza la selección). */
async function insertAnchor(text) {
  if (!text) return;
  try {
    await Word.run(async (ctx) => {
      ctx.document.getSelection().insertText(text, "Replace");
      await ctx.sync();
    });
  } catch {
    message(t("errInsert"), "error");
  }
}

// ───────── Documento ─────────

function source() {
  if (host === "word") return document.querySelector('input[name="src"]:checked')?.value ?? "current";
  return $("use-file").checked || !$("attachment").options.length ? "file" : "attachment";
}

function syncSource() {
  $("file").classList.toggle("hidden", source() !== "file");
}

/** Word: el documento abierto exportado a PDF, en partes de hasta 4 MB. */
function currentDocumentPdf() {
  return new Promise((resolve, reject) => {
    Office.context.document.getFileAsync(Office.FileType.Pdf, { sliceSize: SLICE }, (r) => {
      if (r.status !== Office.AsyncResultStatus.Succeeded) return reject(new Error(t("errPdfExport")));
      const file = r.value;
      const parts = [];
      let i = 0;
      const next = () =>
        file.getSliceAsync(i, (s) => {
          if (s.status !== Office.AsyncResultStatus.Succeeded) {
            file.closeAsync();
            return reject(new Error(t("errPdfExport")));
          }
          parts.push(new Uint8Array(s.value.data));
          i++;
          if (i < file.sliceCount) next();
          else {
            file.closeAsync();
            const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
            let o = 0;
            for (const p of parts) {
              out.set(p, o);
              o += p.length;
            }
            resolve(out);
          }
        });
      next();
    });
  });
}

function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Outlook: contenido de un adjunto (Mailbox 1.8). */
function attachmentPdf(id) {
  return new Promise((resolve, reject) => {
    Office.context.mailbox.item.getAttachmentContentAsync(id, (r) => {
      if (r.status !== Office.AsyncResultStatus.Succeeded) return reject(new Error(r.error?.message || "attachment"));
      if (r.value.format !== Office.MailboxEnums.AttachmentContentFormat.Base64) return reject(new Error(t("attachmentNotFile")));
      resolve(fromBase64(r.value.content));
    });
  });
}

function pdfAttachments() {
  const item = Office.context.mailbox?.item;
  return (item?.attachments ?? []).filter(
    (a) => a.attachmentType === Office.MailboxEnums.AttachmentType.File && (/pdf/i.test(a.contentType || "") || /\.pdf$/i.test(a.name || "")),
  );
}

async function documentBytes() {
  const src = source();
  if (src === "current") {
    const bytes = await currentDocumentPdf();
    return { bytes, name: `${documentTitle() || "documento"}.pdf` };
  }
  if (src === "attachment") {
    const opt = $("attachment").selectedOptions[0];
    return { bytes: await attachmentPdf(opt.value), name: opt.textContent };
  }
  const f = $("file").files?.[0];
  if (!f) throw new Error(t("errNoFile"));
  return { bytes: new Uint8Array(await f.arrayBuffer()), name: f.name };
}

function documentTitle() {
  try {
    const url = globalThis.Office?.context?.document?.url || "";
    const last = decodeURIComponent(url.split(/[\\/]/).pop() || "");
    return last.replace(/\.(docx?|dotx?|rtf|odt)$/i, "");
  } catch {
    return "";
  }
}

// ───────── Revisar y enviar ─────────

function validate() {
  const signers = readSigners();
  if (!signers.length) throw new Error(t("errNoSigners"));
  for (const s of signers) {
    if (!s.name || !EMAIL_RE.test(s.email)) throw new Error(s.name ? t("errEmail", { name: s.name }) : t("errNoSigners"));
    if (placement() === "anchor" && !s.anchor) throw new Error(t("errAnchor", { name: s.name }));
  }
  const subject = $("subject").value.trim();
  if (!subject) throw new Error(t("errSubject"));
  if (source() === "file" && !$("file").files?.[0]) throw new Error(t("errNoFile"));
  return { signers, subject, message: $("message").value.trim(), placement: placement() };
}

function renderSummary(p) {
  const box = $("summary");
  box.replaceChildren();
  const dl = document.createElement("dl");
  const add = (k, v) => {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    dl.append(dt, dd);
  };
  add(t("subject"), p.subject);
  add(t("docLegend"), p.docName);
  add(
    t("signers"),
    p.signers
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((s) => `${s.order}. ${s.name} <${s.email}>${p.placement === "anchor" ? ` — ${s.anchor}` : ""}`)
      .join("\n"),
  );
  dl.lastChild.style.whiteSpace = "pre-line";
  if (p.message) add(t("message"), p.message);
  add(t("placement"), p.placement === "anchor" ? t("placeAnchor") : t("placePage"));
  box.appendChild(dl);
}

async function onReview() {
  if (busy) return;
  message("");
  try {
    const p = validate();
    setBusy(true, t("stepPdf"));
    const doc = await documentBytes();
    let bytes = doc.bytes;
    let placements = null;
    if (p.placement === "page") {
      try {
        ({ bytes, placements } = await appendSignaturePage(bytes, p.signers, { title: t("sigPageTitle"), date: t("sigDate") }));
      } catch (e) {
        if (/encrypt/i.test(e?.name || e?.message || "")) throw new Error(t("errPdfEncrypted"));
        throw e;
      }
    }
    // La Idempotency-Key del sobre es de este envío, no de cada clic: si la creación se cortó por red después de que
    // el servidor la hizo, "Enviar" de nuevo devuelve el mismo borrador en vez de crear otro.
    pending = { ...p, bytes, placements, docName: doc.name, createKey: uuid() };
    renderSummary(pending);
    message("");
    show("view-confirm");
  } catch (e) {
    message(errorText(e), "error");
  } finally {
    setBusy(false);
  }
}

async function onSend() {
  if (busy || !pending) return;
  const p = pending;
  setBusy(true, t("stepSend"));
  try {
    // UNA sola llamada (POST /v1/envelopes con el PDF, los firmantes, los campos y send): atómica, así que si algo
    // falla no queda un borrador a medias. Va como multipart (el JSON en `payload` y el PDF en su parte) para no
    // inflarlo en base64. La Idempotency-Key es de este envío: reintentar después de un corte de red no duplica nada.
    const name = (/\.pdf$/i.test(p.docName) ? p.docName : `${p.docName}.pdf`).slice(0, 200);
    const fields =
      p.placement === "anchor"
        ? p.signers.map((s, i) => ({
            // La firma queda justo encima del texto ancla (que ocupa ~10–12 pt de alto).
            recipient: i,
            type: "signature",
            anchor: { text: s.anchor, width: 150, height: 40, offsetY: -36 },
          }))
        : p.placements.flatMap((pl) => [
            { recipient: pl.signer, type: "signature", page: pl.page, ...pl.signature },
            { recipient: pl.signer, type: "date_signed", page: pl.page, ...pl.date },
          ]);
    const payload = {
      subject: p.subject,
      message: p.message || null,
      locale: envelopeLocale(),
      metadata: { source: `office-${host}` },
      documents: [{ file: "document", name }],
      recipients: p.signers.map((s) => ({ role: "signer", routingOrder: s.order, name: s.name, email: s.email, channels: ["email"], locale: envelopeLocale() })),
      fields,
      send: true,
    };
    const form = new FormData();
    form.append("payload", JSON.stringify(payload));
    form.append("document", new Blob([p.bytes], { type: "application/pdf" }), name);
    const created = await api("/v1/envelopes", { form, idempotencyKey: p.createKey });
    const envelopeId = created.envelope.id;

    pending = null;
    message("");
    $("done-text").textContent = t("doneText", { subject: p.subject, n: p.signers.length });
    $("done-link").href = appUrl(envelopeId);
    show("view-done", "view-recent");
    loadRecent();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      show("view-login");
      message(t("errSession"), "error");
    } else {
      show("view-confirm");
      message(errorText(e), "error");
    }
  } finally {
    setBusy(false);
  }
}

// ───────── Recientes ─────────

async function loadRecent() {
  const ul = $("recent");
  try {
    const r = await api("/v1/envelopes?limit=8");
    ul.replaceChildren();
    if (!r.items.length) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = t("noRecent");
      ul.appendChild(li);
    }
    for (const e of r.items) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = appUrl(e.id);
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = e.subject;
      const badge = document.createElement("span");
      badge.className = `badge ${e.status}`;
      badge.textContent = t(`status.${e.status}`);
      const when = document.createElement("span");
      when.className = "muted small";
      when.textContent = ` ${new Date(e.createdAt).toLocaleDateString(envelopeLocale())}`;
      li.append(a, badge, when);
      ul.appendChild(li);
    }
  } catch {
    /* la lista es secundaria: sin ruido si falla */
  }
}

// ───────── Arranque ─────────

function init(info) {
  host = (info?.host && info.host === globalThis.Office?.HostType?.Outlook) || new URLSearchParams(location.search).get("host") === "outlook" ? "outlook" : "word";
  setLanguage(globalThis.Office?.context?.displayLanguage || navigator.language);
  applyTranslations();

  $("src-word").classList.toggle("hidden", host !== "word");
  $("src-outlook").classList.toggle("hidden", host !== "outlook");
  if (host === "outlook" && globalThis.Office?.context?.mailbox?.item) {
    const item = Office.context.mailbox.item;
    for (const a of pdfAttachments()) {
      const o = document.createElement("option");
      o.value = a.id;
      o.textContent = a.name;
      $("attachment").appendChild(o);
    }
    $("attachment").classList.toggle("hidden", !$("attachment").options.length);
    $("no-attachments").classList.toggle("hidden", !!$("attachment").options.length);
    $("subject").value = (item.subject || "").slice(0, 300);
    // El remitente del correo, precargado como primer firmante (se puede cambiar o quitar).
    addSigner(item.from?.displayName || "", item.from?.emailAddress || "");
  } else {
    $("subject").value = documentTitle();
    addSigner();
  }
  syncSource();

  for (const r of document.querySelectorAll('input[name="src"]')) r.addEventListener("change", syncSource);
  $("use-file").addEventListener("change", syncSource);
  for (const r of document.querySelectorAll('input[name="place"]')) r.addEventListener("change", syncPlacement);
  $("add-signer").addEventListener("click", () => addSigner());
  $("login").addEventListener("click", onLogin);
  $("apikey-save").addEventListener("click", async () => {
    const k = $("apikey").value.trim();
    if (!k) return;
    useApiKey(k);
    $("apikey").value = "";
    message("");
    await afterLogin();
  });
  $("signout").addEventListener("click", () => {
    signOut();
    message("");
    show("view-login");
  });
  $("review").addEventListener("click", onReview);
  $("back").addEventListener("click", () => {
    message("");
    show("view-send", "view-recent");
  });
  $("send").addEventListener("click", onSend);
  $("again").addEventListener("click", () => {
    message("");
    show("view-send", "view-recent");
  });
  $("refresh").addEventListener("click", loadRecent);

  if (currentTokens()) afterLogin();
  else show("view-login");
}

if (globalThis.Office?.onReady) Office.onReady(init);
else document.addEventListener("DOMContentLoaded", () => init(null));
