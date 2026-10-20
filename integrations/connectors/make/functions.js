// Funciones IML personalizadas de la app de Make (pestaña "Functions"). Cada función se pega como un componente
// aparte; el build las separa (connectors/make/functions/<nombre>.js). JavaScript ES5 sin dependencias.

/** Formulario dinámico de una plantilla (respuesta de GET /v1/templates/{id}/input-schema) → parámetros de Make. */
function calasignTemplateForm(schema) {
  var roles = [];
  var prefill = [];
  var i;
  for (i = 0; i < (schema.roles || []).length; i++) {
    var r = schema.roles[i];
    roles.push({
      name: r.id,
      label: r.name,
      type: "collection",
      required: true,
      spec: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "email", label: "Email", type: "email" },
        { name: "phone", label: "Phone (WhatsApp, E.164)", type: "text" }
      ]
    });
  }
  for (i = 0; i < (schema.fields || []).length; i++) {
    var f = schema.fields[i];
    var p = { name: f.id, label: f.label || "Field " + f.type, type: f.type === "number" ? "number" : "text" };
    if (f.type === "dropdown" && f.options && f.options.length) {
      p.type = "select";
      p.options = [];
      for (var j = 0; j < f.options.length; j++) p.options.push({ label: f.options[j], value: f.options[j] });
    }
    if (f.roleName) p.help = "Shown to " + f.roleName;
    prefill.push(p);
  }
  var out = [{ name: "roles", label: "Recipients", type: "collection", required: true, spec: roles }];
  if (prefill.length) out.push({ name: "prefill", label: "Prefilled fields", type: "collection", spec: prefill });
  return out;
}

/** Firmantes del módulo "Send a document" → destinatarios de PUT /v1/envelopes/{id}/recipients. */
function calasignRecipients(signers, sequential) {
  var out = [];
  for (var i = 0; i < (signers || []).length; i++) {
    var s = signers[i];
    if (!s || !s.name) continue;
    out.push({
      role: "signer",
      routingOrder: sequential ? i + 1 : 1,
      name: s.name,
      email: s.email || null,
      phone: s.phone || null,
      channels: s.email ? ["email"] : ["whatsapp"]
    });
  }
  return out;
}

/** Un campo de firma por firmante: en la última página (dos columnas desde abajo) o en las anclas \firma1\, \firma2\… */
function calasignFields(recipients, documentId, pageCount, placement) {
  var signers = [];
  var i;
  for (i = 0; i < (recipients || []).length; i++) if (recipients[i].role === "signer") signers.push(recipients[i]);
  var out = [];
  var rows = Math.ceil(signers.length / 2);
  for (i = 0; i < signers.length; i++) {
    if (placement === "anchors") {
      out.push({ documentId: documentId, recipientId: signers[i].id, type: "signature", anchor: { text: "\\firma" + (i + 1) + "\\", offsetX: 0, offsetY: 0, width: 150, height: 40 } });
    } else {
      var row = Math.floor(i / 2);
      var y = Math.max(0.02, 0.93 - (rows - row) * (0.06 + 0.025));
      out.push({
        documentId: documentId,
        recipientId: signers[i].id,
        type: "signature",
        page: Math.max(0, (pageCount || 1) - 1),
        x: i % 2 === 0 ? 0.07 : 0.53,
        y: Math.round(y * 10000) / 10000,
        width: 0.4,
        height: 0.06
      });
    }
  }
  return out;
}

/** Evento de webhook → salida plana del trigger (misma forma que en Zapier y n8n). */
function calasignFlattenEvent(ev) {
  var env = (ev && ev.data && ev.data.envelope) || {};
  var rid = ev && ev.data ? ev.data.recipientId : null;
  var r = null;
  for (var i = 0; i < (env.recipients || []).length; i++) if (env.recipients[i].id === rid) r = env.recipients[i];
  return {
    id: ev.id,
    event: ev.type,
    created_at: ev.createdAt,
    envelope_id: env.id || null,
    envelope_subject: env.subject || null,
    envelope_status: env.status || null,
    envelope_completed_at: env.completedAt || null,
    signed_sha256: env.signedSha256 || null,
    metadata: env.metadata || {},
    recipient_id: r ? r.id : null,
    recipient_name: r ? r.name : null,
    recipient_email: r ? r.email : null,
    reason: (ev.data && ev.data.reason) || null,
    recipients: env.recipients || []
  };
}

/**
 * Idempotency-Key de un envío. Make reintenta el módulo (ejecuciones incompletas, errores de red) con los mismos datos
 * y no expone un id de ejecución a las apps: la clave es un hash de los parámetros (sin el PDF) + el día (UTC). El
 * parámetro "Idempotency key" la reemplaza (p. ej. con el id del registro de origen).
 */
function calasignIdempotencyKey(parameters, action) {
  var p = parameters || {};
  if (p.idempotencyKey) return "make-" + String(p.idempotencyKey).slice(0, 150);
  var copy = {};
  for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k) && k !== "data") copy[k] = p[k];
  // Del PDF solo el tamaño (barato): sin él, dos PDF distintos con el mismo nombre, asunto y firmantes el mismo día (un
  // iterador sobre documentos generados) compartían clave y el segundo recibía el sobre del primero sin enviarse.
  if (p.data != null && p.data.length != null) copy.dataLength = p.data.length;
  var text = action + "\n" + JSON.stringify(copy);
  // FNV-1a de 32 bits con dos semillas (64 bits en hex): sin dependencias (el sandbox de Make no tiene crypto).
  var h1 = 0x811c9dc5;
  var h2 = 0x01000193 ^ 0x5bd1e995;
  for (var i = 0; i < text.length; i++) {
    var c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  var hex = ("00000000" + h1.toString(16)).slice(-8) + ("00000000" + h2.toString(16)).slice(-8);
  return "make-" + action + "-" + hex + "-" + new Date().toISOString().slice(0, 10);
}

/** Primer documento del sobre (detalle de GET /v1/envelopes/{id}): en un reintento el PDF ya puede estar subido. */
function calasignDocumentId(documents) {
  return documents && documents.length ? documents[0].id : null;
}

function calasignDocumentPages(documents) {
  return documents && documents.length ? documents[0].pageCount : null;
}

/** ¿Hay que seguir armando el sobre? Solo si sigue en borrador (un reintento puede encontrarlo ya enviado). */
function calasignIsDraft(status) {
  return status === "draft";
}

/** ¿Hay que subir el PDF? En borrador y sin documento (un reintento lo encuentra ya subido). */
function calasignNeedsUpload(status, documentId) {
  return status === "draft" && !documentId;
}

/** ¿Se envía? Si sigue en borrador y el usuario no pidió dejarlo como borrador. */
function calasignShouldSend(status, send) {
  return status === "draft" && send !== false;
}


/**
 * ¿Se acepta la entrega del webhook? Descarta webhook.test y verifica `CalaSign-Signature: t=<unix>,v1=<hex>[,v1=…]`
 * (HMAC-SHA256 del secreto sobre "<t>.<cuerpo>", tolerancia de 300 s; durante una rotación llegan dos v1), igual que
 * Zapier y n8n. Make no expone el cuerpo crudo: se re-serializa con JSON.stringify, que reproduce el cuerpo que firma
 * la API (JSON.stringify compacto del mismo objeto, mismo orden de claves). Sin secreto guardado (webhooks adjuntados
 * antes de esta versión) no se verifica: apagar y prender el escenario crea el webhook nuevo con su secreto.
 */
function calasignAcceptEvent(body, headers, secret) {
  if (!body || body.type === "webhook.test") return false;
  if (!secret) return true;
  var h = headers || {};
  var header = h["calasign-signature"] || h["CalaSign-Signature"];
  if (!header) return false;
  var t = "";
  var v1 = [];
  var parts = String(header).split(",");
  for (var i = 0; i < parts.length; i++) {
    var k = parts[i].indexOf("=");
    if (k < 0) continue;
    var name = parts[i].slice(0, k).trim();
    if (name === "t") t = parts[i].slice(k + 1).trim();
    else if (name === "v1") v1.push(parts[i].slice(k + 1).trim().toLowerCase());
  }
  var ts = Number(t);
  if (!t || !v1.length || !isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  // HMAC-SHA256 en ES5 (el sandbox de Make no tiene crypto).
  function utf8(s) {
    var out = [];
    var str = unescape(encodeURIComponent(s));
    for (var n = 0; n < str.length; n++) out.push(str.charCodeAt(n));
    return out;
  }
  var K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  function sha256(bytes) {
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var m = bytes.slice();
    var bitLen = bytes.length * 8;
    m.push(0x80);
    while (m.length % 64 !== 56) m.push(0);
    for (var s = 7; s >= 0; s--) m.push(s >= 4 ? 0 : (bitLen >>> (s * 8)) & 0xff);
    var w = new Array(64);
    for (var off = 0; off < m.length; off += 64) {
      for (var a = 0; a < 16; a++) w[a] = (m[off + a * 4] << 24) | (m[off + a * 4 + 1] << 16) | (m[off + a * 4 + 2] << 8) | m[off + a * 4 + 3];
      for (a = 16; a < 64; a++) {
        var x = w[a - 15];
        var y = w[a - 2];
        var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
        var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        w[a] = (w[a - 16] + s0 + w[a - 7] + s1) | 0;
      }
      var A = H[0], B = H[1], C = H[2], D = H[3], E = H[4], F = H[5], G = H[6], I = H[7];
      for (a = 0; a < 64; a++) {
        var S1 = ((E >>> 6) | (E << 26)) ^ ((E >>> 11) | (E << 21)) ^ ((E >>> 25) | (E << 7));
        var t1 = (I + S1 + ((E & F) ^ (~E & G)) + K[a] + w[a]) | 0;
        var S0 = ((A >>> 2) | (A << 30)) ^ ((A >>> 13) | (A << 19)) ^ ((A >>> 22) | (A << 10));
        var t2 = (S0 + ((A & B) ^ (A & C) ^ (B & C))) | 0;
        I = G; G = F; F = E; E = (D + t1) | 0; D = C; C = B; B = A; A = (t1 + t2) | 0;
      }
      H[0] = (H[0] + A) | 0; H[1] = (H[1] + B) | 0; H[2] = (H[2] + C) | 0; H[3] = (H[3] + D) | 0;
      H[4] = (H[4] + E) | 0; H[5] = (H[5] + F) | 0; H[6] = (H[6] + G) | 0; H[7] = (H[7] + I) | 0;
    }
    var out = [];
    for (a = 0; a < 8; a++) out.push((H[a] >>> 24) & 0xff, (H[a] >>> 16) & 0xff, (H[a] >>> 8) & 0xff, H[a] & 0xff);
    return out;
  }
  var key = utf8(secret);
  if (key.length > 64) key = sha256(key);
  while (key.length < 64) key.push(0);
  var ipad = [];
  var opad = [];
  for (i = 0; i < 64; i++) {
    ipad.push(key[i] ^ 0x36);
    opad.push(key[i] ^ 0x5c);
  }
  var mac = sha256(opad.concat(sha256(ipad.concat(utf8(t + "." + JSON.stringify(body))))));
  var hex = "";
  for (i = 0; i < mac.length; i++) hex += ("0" + mac[i].toString(16)).slice(-2);
  for (i = 0; i < v1.length; i++) {
    if (v1[i].length !== hex.length) continue;
    var diff = 0;
    for (var c = 0; c < hex.length; c++) diff |= hex.charCodeAt(c) ^ v1[i].charCodeAt(c);
    if (diff === 0) return true;
  }
  return false;
}

/**
 * Tipo de error de Make para una respuesta de la API. Solo el 429 del límite de tasa genérico (con Retry-After o código
 * rate_limited/bad_request) es RateLimitError; los 429 de negocio (reminded_recently, etc.) traen su propio código y no
 * Retry-After, y reintentarlos no sirve. Un 409 idempotency_in_progress (otra ejecución con la misma Idempotency-Key en
 * curso) es ConnectionError: reintentable, se resuelve en segundos.
 */
function calasignErrorType(statusCode, headers, body) {
  var code = body && body.error ? body.error.code : null;
  var h = headers || {};
  if (statusCode === 429 && (h["retry-after"] || h["Retry-After"] || !code || code === "rate_limited" || code === "bad_request")) return "RateLimitError";
  if (statusCode === 409 && code === "idempotency_in_progress") return "ConnectionError";
  if (statusCode === 401) return "InvalidAccessTokenError";
  return "RuntimeError";
}
