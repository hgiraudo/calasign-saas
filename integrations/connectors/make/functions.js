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

