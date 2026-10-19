// Llamadas a la API de CalaSign y a la API REST de Google Drive (UrlFetchApp).
// Drive se usa por REST con el token del add-on (ScriptApp.getOAuthToken) y el scope drive.file: así el add-on solo
// toca los archivos que el usuario eligió (o que el propio add-on creó), sin pedir acceso a todo el Drive.

var CS_BASE_URL = '{{BASE_URL}}';
var CS_DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
var CS_DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
var CS_GDOC_MIME = 'application/vnd.google-apps.document';
var CS_FOLDER_MIME = 'application/vnd.google-apps.folder';

function parseJson_(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch (err) {
    return null;
  }
}

/** Error de la API de CalaSign ({ error: { code, message, details } }). */
function CsApiError(status, body) {
  var e = (body && body.error) || {};
  this.name = 'CsApiError';
  this.status = status;
  this.code = e.code || 'http_' + status;
  this.message = e.message || 'HTTP ' + status;
  this.details = e.details || null;
}
CsApiError.prototype = Object.create(Error.prototype);
CsApiError.prototype.constructor = CsApiError;

/** Sin sesión (o la sesión venció): hay que mostrar la tarjeta de inicio de sesión. */
function CsAuthRequired() {
  this.name = 'CsAuthRequired';
  this.message = 'auth_required';
}
CsAuthRequired.prototype = Object.create(Error.prototype);
CsAuthRequired.prototype.constructor = CsAuthRequired;

/**
 * Pedido a CalaSign con el token del usuario (OAuth o API key).
 * @param {string} method
 * @param {string} path  p. ej. "/v1/envelopes"
 * @param {{json?: Object, idempotencyKey?: string, raw?: boolean}=} opts  raw: devuelve la respuesta (p. ej. un PDF)
 */
function calaRequest_(method, path, opts) {
  opts = opts || {};
  var token = currentAccessToken_();
  if (!token) throw new CsAuthRequired();
  var headers = { Authorization: 'Bearer ' + token, Accept: opts.raw ? '*/*' : 'application/json' };
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  var params = { method: method, headers: headers, muteHttpExceptions: true, followRedirects: false };
  if (opts.json !== undefined) {
    params.contentType = 'application/json';
    params.payload = JSON.stringify(opts.json);
  }
  var res = UrlFetchApp.fetch(CS_BASE_URL + path, params);
  var status = res.getResponseCode();
  if (status === 401) {
    forgetCredentials_();
    throw new CsAuthRequired();
  }
  if (status < 200 || status >= 300) throw new CsApiError(status, parseJson_(res.getContentText()));
  if (opts.raw) return res;
  return parseJson_(res.getContentText());
}

function envelopeUrl_(id) {
  return CS_BASE_URL + '/app/envelopes/' + encodeURIComponent(id);
}

/** Sobres recientes del usuario (GET /v1/envelopes). */
function listRecentEnvelopes_(limit) {
  return calaRequest_('get', '/v1/envelopes?limit=' + (limit || 8)).items || [];
}

// ───────── Google Drive (REST) ─────────

function driveFetch_(method, url, params) {
  params = params || {};
  params.method = method;
  params.muteHttpExceptions = true;
  params.headers = params.headers || {};
  params.headers.Authorization = 'Bearer ' + ScriptApp.getOAuthToken();
  return UrlFetchApp.fetch(url, params);
}

function driveOk_(res, what) {
  var status = res.getResponseCode();
  if (status < 200 || status >= 300) {
    var err = new Error('Drive ' + what + ': HTTP ' + status);
    err.status = status;
    throw err;
  }
  return res;
}

/** Metadatos de un archivo (nombre, tipo y carpetas). */
function driveMeta_(id) {
  var res = driveOk_(driveFetch_('get', CS_DRIVE_API + '/' + encodeURIComponent(id) + '?fields=id,name,mimeType,parents,size&supportsAllDrives=true'), 'metadatos');
  return JSON.parse(res.getContentText());
}

/** Bytes de un archivo (PDF). */
function driveDownload_(id) {
  return driveOk_(driveFetch_('get', CS_DRIVE_API + '/' + encodeURIComponent(id) + '?alt=media&supportsAllDrives=true'), 'descarga').getContent();
}

/** Exporta un documento de Google (PDF o texto plano). */
function driveExport_(id, mimeType) {
  var res = driveOk_(driveFetch_('get', CS_DRIVE_API + '/' + encodeURIComponent(id) + '/export?mimeType=' + encodeURIComponent(mimeType)), 'exportación');
  return mimeType === 'text/plain' ? res.getContentText() : res.getContent();
}

/** Bytes de un archivo de Drive como PDF: un PDF tal cual, un documento de Google exportado. */
function drivePdfBytes_(meta) {
  if (meta.mimeType === 'application/pdf') return driveDownload_(meta.id);
  if (meta.mimeType === CS_GDOC_MIME) return driveExport_(meta.id, 'application/pdf');
  throw new CsInputError('driveUnsupported', { name: meta.name });
}

/** Sube un PDF nuevo (multipart: metadatos + contenido). */
function driveUpload_(name, bytes, parents) {
  var boundary = 'calasign' + Utilities.getUuid().replace(/-/g, '');
  var meta = { name: name, mimeType: 'application/pdf' };
  if (parents && parents.length) meta.parents = parents;
  var head = Utilities.newBlob(
    '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n--' + boundary + '\r\nContent-Type: application/pdf\r\n\r\n',
  ).getBytes();
  var tail = Utilities.newBlob('\r\n--' + boundary + '--\r\n').getBytes();
  var res = driveFetch_('post', CS_DRIVE_UPLOAD + '?uploadType=multipart&supportsAllDrives=true&fields=id,name,parents,webViewLink', {
    contentType: 'multipart/related; boundary=' + boundary,
    payload: head.concat(bytes, tail),
  });
  return JSON.parse(driveOk_(res, 'subida').getContentText());
}

/** Copia un archivo (sin carpeta: hereda las del original) y le cambia el nombre. */
function driveCopy_(id, name) {
  var res = driveFetch_('post', CS_DRIVE_API + '/' + encodeURIComponent(id) + '/copy?supportsAllDrives=true&fields=id,name,parents,webViewLink', {
    contentType: 'application/json',
    payload: JSON.stringify({ name: name }),
  });
  return JSON.parse(driveOk_(res, 'copia').getContentText());
}

/** Reemplaza el contenido de un archivo creado por el add-on. */
function driveReplaceContent_(id, bytes) {
  var res = driveFetch_('patch', CS_DRIVE_UPLOAD + '/' + encodeURIComponent(id) + '?uploadType=media&supportsAllDrives=true&fields=id,name,parents,webViewLink', {
    contentType: 'application/pdf',
    payload: bytes,
  });
  return JSON.parse(driveOk_(res, 'actualización').getContentText());
}

/** Carpeta "CalaSign" creada por el add-on en Mi unidad (accesible con drive.file). */
function driveAppFolder_() {
  var props = PropertiesService.getUserProperties();
  var id = props.getProperty('calasign.folderId');
  if (id) {
    try {
      var m = driveMeta_(id);
      if (m && m.mimeType === CS_FOLDER_MIME) return id;
    } catch (err) {
      /* la borraron: se crea otra */
    }
  }
  var res = driveFetch_('post', CS_DRIVE_API + '?fields=id', { contentType: 'application/json', payload: JSON.stringify({ name: 'CalaSign', mimeType: CS_FOLDER_MIME }) });
  id = JSON.parse(driveOk_(res, 'carpeta').getContentText()).id;
  props.setProperty('calasign.folderId', id);
  return id;
}
