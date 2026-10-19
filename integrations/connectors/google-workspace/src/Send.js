// Envío a firmar (común a Gmail, Docs y Drive) y guardado del PDF firmado de vuelta en Drive.

/**
 * Idempotency-Key: la de la tarjeta + el paso + un hash del pedido. Un doble clic (mismo contenido) no duplica el
 * sobre; si el usuario corrige el formulario después de un error, el pedido cambia y la clave también (la misma
 * clave con otro cuerpo sería un conflicto).
 */
function idemKey_(cardKey, step, obj) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(obj), Utilities.Charset.UTF_8);
  var hex = digest
    .map(function (b) {
      return ('0' + (b & 0xff).toString(16)).slice(-2);
    })
    .join('');
  return 'gws-' + cardKey + '-' + step + '-' + hex.slice(0, 32);
}

function shallowMerge_(a, b) {
  var o = {};
  Object.keys(a).forEach(function (k) {
    o[k] = a[k];
  });
  Object.keys(b).forEach(function (k) {
    o[k] = b[k];
  });
  return o;
}

/**
 * Envía un documento a firmar.
 * @param {{lang: string, cardKey: string, documentName: string, pdfBytes: number[], text?: string, subject: string,
 *          message?: string, signersText: string, sequential?: boolean, placementChoice: string, metadata: Object}} c
 *   text: el texto del documento (Docs y documentos de Google en Drive) para buscar anclas; sin texto (PDF), "auto"
 *   prueba las anclas convencionales y, si no están, la última página.
 * @return {{envelopeId: string, sent: boolean, subject: string, signers: number}}
 */
function sendDocument_(c) {
  var parsed = parseSignerLines_(c.signersText);
  if (parsed.invalid.length) throw new CsInputError('errInvalidSigners', { list: parsed.invalid.join(', ') });
  var signers = parsed.signers;
  var hasText = typeof c.text === 'string';
  var anchors = hasText ? findAnchors_(c.text) : null;
  var placement = resolvePlacement_(c.placementChoice, anchors, signers.length, hasText);
  var base = {
    subject: c.subject,
    message: c.message,
    locale: envelopeLocale_(c.lang),
    documentName: c.documentName,
    pdfBase64: Utilities.base64Encode(c.pdfBytes),
    signers: signers,
    sequential: !!c.sequential,
    metadata: c.metadata || {},
  };
  function result(detail, sent) {
    return { envelopeId: detail.envelope.id, sent: sent, subject: detail.envelope.subject, signers: signers.length };
  }

  if (placement === 'anchors' || placement === 'auto-pdf') {
    var conventional = !hasText;
    var req = buildEnvelopeRequest_(
      shallowMerge_(base, { placement: 'anchors', anchors: conventional ? conventionalAnchors_(signers.length) : anchors, ignoreMissingAnchors: conventional }),
    );
    try {
      // UNA llamada: PDF + firmantes + campos + envío. Es atómica: si falla, no queda nada creado.
      return result(calaRequest_('post', '/v1/envelopes', { json: req, idempotencyKey: idemKey_(c.cardKey, 'a', req) }), true);
    } catch (err) {
      var auto = c.placementChoice !== 'anchors';
      var noAnchors = err instanceof CsApiError && (err.code === 'envelope_incomplete' || err.code === 'anchor_not_found');
      if (!auto || !noAnchors) throw err;
      placement = 'lastPage';
    }
  }

  // Última página o borrador: el borrador en una llamada; para la última página hace falta saber cuántas páginas tiene
  // el PDF (lo dice la respuesta), así que después van los campos y el envío.
  var draft = buildEnvelopeRequest_(shallowMerge_(base, { placement: placement }));
  var created = calaRequest_('post', '/v1/envelopes', { json: draft, idempotencyKey: idemKey_(c.cardKey, 'd', draft) });
  if (placement === 'draft') return result(created, false);
  var id = encodeURIComponent(created.envelope.id);
  calaRequest_('put', '/v1/envelopes/' + id + '/fields', { json: { fields: lastPageFields_(created, signers) } });
  var sent = calaRequest_('post', '/v1/envelopes/' + id + '/send', { idempotencyKey: idemKey_(c.cardKey, 's', { id: created.envelope.id }) });
  return result(sent, true);
}

// ───────── Guardar el firmado de vuelta en Drive ─────────
//
// Al enviar desde Drive o Docs con la opción marcada, se anota { sobre, archivo original, carpeta } en las propiedades
// del usuario. Cada vez que el usuario abre el add-on (Drive, Docs o Gmail), se consultan los pendientes y, si el sobre
// se completó, se baja el PDF firmado y se guarda junto al original. Ver el README para la comparación con la
// exportación automática a Google Drive de la organización (storage-export).

var CS_PENDING_KEY = 'calasign.pendingSaves';
var CS_PENDING_MAX = 25;

function pendingSaves_() {
  var list = parseJson_(PropertiesService.getUserProperties().getProperty(CS_PENDING_KEY));
  return Array.isArray(list) ? list : [];
}

function setPendingSaves_(list) {
  var props = PropertiesService.getUserProperties();
  if (!list.length) props.deleteProperty(CS_PENDING_KEY);
  else props.setProperty(CS_PENDING_KEY, JSON.stringify(list.slice(-CS_PENDING_MAX)));
}

/** Anota un sobre para guardar el firmado junto al archivo original. */
function addPendingSave_(envelopeId, meta) {
  var list = pendingSaves_().filter(function (p) {
    return p.envelopeId !== envelopeId;
  });
  list.push({
    envelopeId: envelopeId,
    fileId: meta.id,
    name: meta.name,
    pdf: meta.mimeType === 'application/pdf',
    parentId: (meta.parents && meta.parents[0]) || null,
    at: new Date().toISOString(),
  });
  setPendingSaves_(list);
}

/**
 * Guarda el PDF firmado junto al original. Con drive.file, crear un archivo en una carpeta que el add-on no abrió
 * puede fallar (404/403); entonces: si el original es un PDF, se copia (la copia queda en la misma carpeta) y se le
 * reemplaza el contenido; si no, va a la carpeta "CalaSign" de Mi unidad.
 * @return {{file: Object, fallback: boolean}}
 */
function saveSignedToDrive_(p, bytes, lang) {
  var name = signedFileName_(p.name, t_(lang, 'signedWord'));
  if (p.parentId) {
    try {
      return { file: driveUpload_(name, bytes, [p.parentId]), fallback: false };
    } catch (err) {
      if (!(err.status === 403 || err.status === 404)) throw err;
    }
  }
  if (p.pdf) {
    try {
      var copy = driveCopy_(p.fileId, name);
      try {
        return { file: driveReplaceContent_(copy.id, bytes), fallback: !(copy.parents && p.parentId && copy.parents.indexOf(p.parentId) >= 0) };
      } catch (err) {
        // Sin reemplazar, la copia es el original SIN firmar con el nombre "(firmado)": se borra (y cada reintento de
        // un error pasajero dejaba otra).
        try {
          driveFetch_('delete', CS_DRIVE_API + '/' + encodeURIComponent(copy.id) + '?supportsAllDrives=true');
        } catch (ignored) {
          /* se informa el error del reemplazo */
        }
        throw err;
      }
    } catch (err) {
      if (!(err.status === 403 || err.status === 404)) throw err;
    }
  }
  return { file: driveUpload_(name, bytes, [driveAppFolder_()]), fallback: true };
}

/**
 * Revisa los pendientes (como mucho cada 2 minutos y 5 por vez) y guarda los firmados de los sobres completados.
 * @return {{name: string, url: string, fallback: boolean}[]} lo que se guardó ahora
 */
function syncPendingSaves_(lang) {
  var list = pendingSaves_();
  if (!list.length) return [];
  var cache = CacheService.getUserCache();
  if (cache.get('calasign.syncedAt')) return [];
  cache.put('calasign.syncedAt', '1', 120);
  var saved = [];
  var unchecked = [];
  var keep = [];
  var checked = 0;
  var authErr = null;
  list.forEach(function (p) {
    if (checked >= 5 || authErr) {
      unchecked.push(p);
      return;
    }
    checked++;
    try {
      var detail = calaRequest_('get', '/v1/envelopes/' + encodeURIComponent(p.envelopeId));
      var status = detail.envelope.status;
      if (status === 'completed') {
        var bytes = calaRequest_('get', '/v1/envelopes/' + encodeURIComponent(p.envelopeId) + '/signed.pdf', { raw: true }).getContent();
        var r = saveSignedToDrive_(p, bytes, lang);
        saved.push({ name: r.file.name, url: r.file.webViewLink || '', fallback: r.fallback });
        return;
      }
      if (status === 'declined' || status === 'voided' || status === 'expired') return; // ya no se va a firmar
      keep.push(p);
    } catch (err) {
      // Sin sesión a mitad de la vuelta: antes se cortaba sin actualizar la lista y los que ya se habían guardado en
      // Drive se volvían a guardar (duplicados) al iniciar sesión de nuevo. Se guarda la lista y después se avisa.
      if (err instanceof CsAuthRequired) {
        authErr = err;
        unchecked.push(p);
        return;
      }
      if (err instanceof CsApiError && err.status === 404) return; // sobre borrado o de otra organización
      keep.push(p);
    }
  });
  // Los que no se revisaron van primero: la próxima vez les toca a ellos.
  setPendingSaves_(unchecked.concat(keep));
  if (authErr) throw authErr;
  return saved;
}
