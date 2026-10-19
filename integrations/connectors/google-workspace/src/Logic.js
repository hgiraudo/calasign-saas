// Lógica pura del add-on (sin servicios de Apps Script): destinatarios, anclas, ubicación de firmas y armado del
// pedido de una sola llamada (POST /v1/envelopes). Se prueba en Node con integrations/test/connectors.mjs.

var CS_MAX_SIGNERS = 50;
var CS_EMAIL_RE = /^[^\s@<>,;"()]+@[^\s@<>,;"()]+\.[^\s@<>,;"()]+$/;
/** Remitentes automáticos: no se precargan como firmantes. */
var CS_NOREPLY_RE = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?|bounces?)([+.@-]|$)/i;
/** Anclas: [[firma]], [[firma_1]], [[firma 2]], [[signature_1]], [[assinatura_1]] (sin número = firmante 1). */
var CS_ANCHOR_RE = /\[\[\s*(?:firma|signature|assinatura)(?:[\s_-]*(\d{1,2}))?\s*\]\]/gi;

/**
 * Separa una lista de direcciones ("A <a@x>, \"Pérez, Juan\" <j@x>; c@x") respetando comillas y <…>.
 * @param {string} raw
 * @return {string[]}
 */
function splitAddressList_(raw) {
  var out = [];
  var cur = '';
  var quoted = false;
  var angle = false;
  var s = String(raw || '');
  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i);
    if (ch === '"') quoted = !quoted;
    else if (ch === '<' && !quoted) angle = true;
    else if (ch === '>' && !quoted) angle = false;
    if ((ch === ',' || ch === ';' || ch === '\n' || ch === '\r') && !quoted && !angle) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** "juan.perez@x.com" → "Juan Perez". */
function nameFromEmail_(email) {
  var local = String(email).split('@')[0].split('+')[0];
  var words = local.split(/[._-]+/).filter(function (w) { return w; });
  if (!words.length) return email;
  return words.map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
}

/**
 * "Nombre <correo>" | "<correo>" | "correo" | "mailto:correo" → { name, email }, o null si no hay un correo válido.
 * @param {string} raw
 */
function parseAddress_(raw) {
  var s = String(raw || '').trim();
  if (!s) return null;
  var m = /^([\s\S]*?)<\s*([^<>\s]+)\s*>\s*$/.exec(s);
  var name = m ? m[1] : '';
  var email = (m ? m[2] : s).replace(/^mailto:/i, '').trim().toLowerCase();
  if (!CS_EMAIL_RE.test(email) || email.length > 320) return null;
  name = name.trim().replace(/^"([\s\S]*)"$/, '$1').replace(/\\"/g, '"').replace(/\s+/g, ' ').trim();
  if (!name || name.toLowerCase() === email) name = nameFromEmail_(email);
  return { name: name.slice(0, 200), email: email };
}

/** "Nombre <correo>" para mostrar en el cuadro de firmantes (comillas si el nombre tiene , ; < > "). */
function formatAddress_(r) {
  var name = String(r.name || '');
  if (/[,;<>"]/.test(name)) name = '"' + name.replace(/"/g, '\\"') + '"';
  return name ? name + ' <' + r.email + '>' : r.email;
}

/**
 * Firmantes escritos en el cuadro de texto: uno por línea ("Nombre <correo>" o "correo"); una línea con varios
 * correos se separa por comas o punto y coma. Sin duplicados (por correo), en orden.
 * @param {string} text
 * @return {{ signers: {name: string, email: string}[], invalid: string[] }}
 */
function parseSignerLines_(text) {
  var signers = [];
  var invalid = [];
  var seen = {};
  String(text || '').split(/\r?\n/).forEach(function (line) {
    line = line.trim();
    if (!line) return;
    var parts = (line.match(/@/g) || []).length > 1 ? splitAddressList_(line) : [line];
    parts.forEach(function (p) {
      var r = parseAddress_(p);
      if (!r) {
        invalid.push(p);
        return;
      }
      if (seen[r.email]) return;
      seen[r.email] = true;
      signers.push(r);
    });
  });
  return { signers: signers, invalid: invalid };
}

/**
 * Firmantes sugeridos para un correo: el remitente y después Para y CC, sin el usuario actual, sin remitentes
 * automáticos (no-reply…) y sin duplicados. Si el correo lo mandó el usuario, quedan los de Para y CC.
 * @param {{from?: string, to?: string, cc?: string}} msg  encabezados tal como los da GmailApp
 * @param {string=} selfEmail
 * @return {{name: string, email: string}[]}
 */
function suggestSigners_(msg, selfEmail) {
  var self = String(selfEmail || '').toLowerCase();
  var out = [];
  var seen = {};
  function add(r) {
    if (!r || seen[r.email] || r.email === self || CS_NOREPLY_RE.test(r.email)) return;
    seen[r.email] = true;
    out.push(r);
  }
  [msg.from, msg.to, msg.cc].forEach(function (l) {
    splitAddressList_(l).forEach(function (a) {
      add(parseAddress_(a));
    });
  });
  return out.slice(0, CS_MAX_SIGNERS);
}

/**
 * Anclas de firma en el texto del documento, por número de firmante (1 = primero).
 * @param {string} text
 * @return {Object<string, string[]>}  { "1": ["[[firma]]", "[[firma_1]]"], "2": ["[[firma_2]]"] }
 */
function findAnchors_(text) {
  var out = {};
  var s = String(text || '');
  CS_ANCHOR_RE.lastIndex = 0;
  var m;
  while ((m = CS_ANCHOR_RE.exec(s))) {
    var n = String(m[1] ? Number(m[1]) : 1);
    if (n === '0') continue;
    if (!out[n]) out[n] = [];
    if (out[n].indexOf(m[0]) < 0) out[n].push(m[0]);
  }
  return out;
}

/** Cantidad de firmantes con al menos un ancla (de 1 a total). */
function anchorsCovered_(anchors, total) {
  var n = 0;
  for (var i = 1; i <= total; i++) if (anchors && anchors[String(i)] && anchors[String(i)].length) n++;
  return n;
}

/**
 * Ubicación de las firmas:
 *  - "anchors": en las anclas (las encontradas en el texto; si no hay texto, las convencionales [[firma]]/[[firma_N]]);
 *  - "lastPage": en la última página, en dos columnas desde abajo (dos pasos: borrador → campos → envío);
 *  - "draft": borrador sin campos, para terminarlo en CalaSign;
 *  - "auto": anclas si el texto del documento las tiene para todos los firmantes; sin texto (PDF), intenta las
 *    anclas convencionales y si no están, la última página; si no, la última página.
 * @return {string} "anchors" | "lastPage" | "draft" | "auto-pdf"
 */
function resolvePlacement_(choice, anchors, signerCount, hasText) {
  if (choice === 'draft' || choice === 'lastPage' || choice === 'anchors') return choice;
  if (!hasText) return 'auto-pdf';
  return anchorsCovered_(anchors, signerCount) === signerCount ? 'anchors' : 'lastPage';
}

/** Anclas convencionales cuando no se conoce el texto (PDF): se ignoran las que no estén. */
function conventionalAnchors_(signerCount) {
  var out = {};
  for (var i = 1; i <= signerCount; i++) out[String(i)] = i === 1 ? ['[[firma]]', '[[firma_1]]'] : ['[[firma_' + i + ']]'];
  return out;
}

/** Caja de firma automática en la última página (misma geometría que los conectores low-code). Coordenadas 0..1. */
function autoBox_(i, total) {
  var rows = Math.ceil(total / 2);
  var row = Math.floor(i / 2);
  var col = i % 2;
  var height = 0.06;
  var gap = 0.025;
  var bottom = 0.93;
  var y = Math.max(0.02, bottom - (rows - row) * (height + gap));
  return { x: col === 0 ? 0.07 : 0.53, y: Number(y.toFixed(4)), width: 0.4, height: height };
}

/** Idioma del sobre (es, pt-BR, en) a partir del de Google ("es-419", "pt-BR", "en-US"…). */
function envelopeLocale_(userLocale) {
  var l = String(userLocale || '').toLowerCase();
  if (l.indexOf('pt') === 0) return 'pt-BR';
  if (l.indexOf('en') === 0) return 'en';
  return 'es';
}

/** Error de validación del formulario: `code` es una clave de i18n y `vars` sus variables. */
function CsInputError(code, vars) {
  this.name = 'CsInputError';
  this.code = code;
  this.vars = vars || {};
  this.message = code;
}
CsInputError.prototype = Object.create(Error.prototype);
CsInputError.prototype.constructor = CsInputError;

/**
 * Cuerpo de POST /v1/envelopes (una sola llamada: documento en base64, firmantes, campos y envío).
 * @param {{subject: string, message?: string, locale: string, documentName: string, pdfBase64: string,
 *          signers: {name: string, email: string}[], sequential?: boolean, placement: string,
 *          anchors?: Object<string, string[]>, ignoreMissingAnchors?: boolean, metadata?: Object}} p
 *   placement ya resuelto: "anchors" (envía en la misma llamada), "lastPage" o "draft" (queda en borrador).
 */
function buildEnvelopeRequest_(p) {
  var subject = String(p.subject || '').trim().slice(0, 300);
  if (!subject) throw new CsInputError('errSubject');
  var signers = p.signers || [];
  if (!signers.length) throw new CsInputError('errNoSigners');
  if (signers.length > CS_MAX_SIGNERS) throw new CsInputError('errTooMany', { max: CS_MAX_SIGNERS });
  if (!p.pdfBase64) throw new CsInputError('errNoDocument');
  var name = String(p.documentName || 'documento').trim() || 'documento';
  if (!/\.pdf$/i.test(name)) name += '.pdf';
  if (name.length > 200) name = name.slice(0, 196) + '.pdf';
  var fields = [];
  if (p.placement === 'anchors') {
    var missing = [];
    signers.forEach(function (s, i) {
      var texts = (p.anchors && p.anchors[String(i + 1)]) || [];
      if (!texts.length) missing.push(s.name);
      texts.forEach(function (text) {
        // La firma queda justo encima del texto ancla (que ocupa ~10–12 pt de alto), como en el complemento de Word.
        var anchor = { text: text, width: 150, height: 40, offsetY: -36 };
        if (p.ignoreMissingAnchors) anchor.ignoreIfNotPresent = true;
        fields.push({ recipient: i, type: 'signature', anchor: anchor });
      });
    });
    if (missing.length) throw new CsInputError('errAnchorMissing', { names: missing.join(', ') });
  }
  var message = p.message ? String(p.message).trim().slice(0, 5000) : '';
  return {
    subject: subject,
    message: message || null,
    locale: p.locale,
    metadata: p.metadata || {},
    documents: [{ name: name, base64: p.pdfBase64 }],
    recipients: signers.map(function (s, i) {
      return { role: 'signer', routingOrder: p.sequential ? i + 1 : 1, name: s.name, email: s.email, channels: ['email'], locale: p.locale };
    }),
    fields: fields,
    send: p.placement === 'anchors',
  };
}

/**
 * Campos de firma en la última página del primer documento, para PUT /v1/envelopes/{id}/fields, a partir del detalle
 * del borrador (los ids de documento y destinatarios los asigna CalaSign).
 */
function lastPageFields_(detail, signers) {
  var doc = detail.documents && detail.documents[0];
  if (!doc) throw new Error('El sobre no tiene documentos');
  var page = Math.max(0, (doc.pageCount || 1) - 1);
  var recips = (detail.recipients || []).filter(function (r) { return r.role === 'signer'; });
  return signers.map(function (s, i) {
    var r = recips.filter(function (x) { return String(x.email || '').toLowerCase() === s.email; })[0] || recips[i];
    if (!r) throw new Error('Falta el destinatario ' + s.email);
    var box = autoBox_(i, signers.length);
    return { documentId: doc.id, recipientId: r.id, type: 'signature', page: page, x: box.x, y: box.y, width: box.width, height: box.height };
  });
}

/** Nombre del PDF firmado: "Contrato.pdf" → "Contrato (firmado).pdf". */
function signedFileName_(name, word) {
  var base = String(name || 'documento').replace(/\.pdf$/i, '');
  return base + ' (' + (word || 'firmado') + ').pdf';
}

/** Escapa texto para los widgets de Card Service que aceptan HTML básico. */
function escapeHtml_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
