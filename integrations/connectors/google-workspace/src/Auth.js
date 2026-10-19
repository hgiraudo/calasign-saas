// Autenticación contra CalaSign:
//  1. OAuth 2.0 authorization code + PKCE S256 con la librería OAuth2 de Apps Script (apps-script-oauth2 ≥ v1.42, que
//     trae generateCodeVerifier/setCodeChallengeMethod). Cliente PÚBLICO (sin secreto): el código del add-on lo puede
//     leer cualquiera que lo instale, así que un secreto no protegería nada; PKCE es lo que protege el canje.
//     El client_id se obtiene una vez con registro dinámico (RFC 7591, POST /oauth/register) usando la redirect URI
//     de este script (https://script.google.com/macros/d/<scriptId>/usercallback) y queda en las propiedades del
//     script (compartidas por todos los usuarios). El operador puede fijarlo a mano en CALASIGN_CLIENT_ID.
//  2. Alternativa: una API key de CalaSign pegada por el usuario (propiedades del usuario).
// Tokens y API key quedan en PropertiesService.getUserProperties(): solo los lee este script para ese usuario.

var CS_OAUTH_SCOPES = 'envelopes:read envelopes:write offline_access';
var CS_PROP_CLIENT_ID = 'CALASIGN_CLIENT_ID';
var CS_PROP_CLIENT_BASE = 'CALASIGN_CLIENT_BASE_URL';
var CS_PROP_API_KEY = 'calasign.apiKey';

/** client_id de CalaSign para este script: el configurado o uno nuevo por registro dinámico. */
function ensureClientId_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(CS_PROP_CLIENT_ID);
  var base = props.getProperty(CS_PROP_CLIENT_BASE);
  // Fijado a mano (sin URL base guardada) o registrado contra esta misma instalación de CalaSign.
  if (id && (!base || base === CS_BASE_URL)) return id;
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    id = props.getProperty(CS_PROP_CLIENT_ID);
    base = props.getProperty(CS_PROP_CLIENT_BASE);
    if (id && (!base || base === CS_BASE_URL)) return id;
    var res = UrlFetchApp.fetch(CS_BASE_URL + '/oauth/register', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        client_name: 'CalaSign para Google Workspace',
        client_uri: CS_BASE_URL,
        redirect_uris: [OAuth2.getRedirectUri(ScriptApp.getScriptId())],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: CS_OAUTH_SCOPES,
      }),
      muteHttpExceptions: true,
      followRedirects: false,
    });
    var code = res.getResponseCode();
    var body = parseJson_(res.getContentText());
    if (code < 200 || code >= 300 || !body || !body.client_id) {
      throw new Error('registro OAuth ' + code + (body && body.error_description ? ': ' + body.error_description : ''));
    }
    props.setProperties({ CALASIGN_CLIENT_ID: body.client_id, CALASIGN_CLIENT_BASE_URL: CS_BASE_URL });
    return body.client_id;
  } finally {
    lock.releaseLock();
  }
}

/** Servicio OAuth2 de CalaSign (PKCE S256, refresh automático, tokens por usuario). */
function getOAuthService_() {
  return OAuth2.createService('calasign')
    .setAuthorizationBaseUrl(CS_BASE_URL + '/oauth/authorize')
    .setTokenUrl(CS_BASE_URL + '/oauth/token')
    .setClientId(ensureClientId_())
    .setCallbackFunction('authCallback')
    .setPropertyStore(PropertiesService.getUserProperties())
    .setCache(CacheService.getUserCache())
    .setLock(LockService.getUserLock())
    .setScope(CS_OAUTH_SCOPES)
    .generateCodeVerifier()
    .setCodeChallengeMethod('S256')
    // Cliente público: la librería manda client_secret aunque no haya; se quita para no enviar "undefined".
    .setTokenPayloadHandler(stripEmptySecret_);
}

function stripEmptySecret_(payload) {
  if (payload && (payload.client_secret === undefined || payload.client_secret === null || payload.client_secret === '')) delete payload.client_secret;
  return payload;
}

/** Vuelta del consentimiento de CalaSign (https://script.google.com/macros/d/<scriptId>/usercallback). */
function authCallback(request) {
  var lang = langOf_(Session.getActiveUserLocale());
  var ok = false;
  try {
    ok = getOAuthService_().handleCallback(request);
  } catch (err) {
    ok = false;
  }
  return HtmlService.createHtmlOutput(
    '<p style="font-family:sans-serif">' + escapeHtml_(t_(lang, ok ? 'authDone' : 'authDenied')) + '</p>' + (ok ? '<script>setTimeout(function(){top.window.close()},800)</script>' : ''),
  );
}

function getApiKey_() {
  return PropertiesService.getUserProperties().getProperty(CS_PROP_API_KEY);
}

/** ¿Hay credenciales? (API key guardada o token OAuth vigente/renovable). */
function isSignedIn_() {
  if (getApiKey_()) return true;
  try {
    return getOAuthService_().hasAccess();
  } catch (err) {
    return false;
  }
}

/** Token para la API de CalaSign; null si no hay sesión. */
function currentAccessToken_() {
  var key = getApiKey_();
  if (key) return key;
  var svc = getOAuthService_();
  return svc.hasAccess() ? svc.getAccessToken() : null;
}

/** Cierra la sesión: borra la API key y los tokens, y revoca el refresh token (y con él toda su familia). */
function signOut_() {
  PropertiesService.getUserProperties().deleteProperty(CS_PROP_API_KEY);
  var clientId = PropertiesService.getScriptProperties().getProperty(CS_PROP_CLIENT_ID);
  if (!clientId) return;
  var svc;
  try {
    svc = getOAuthService_();
  } catch (err) {
    return;
  }
  var tok = svc.getToken();
  if (tok && tok.refresh_token) {
    try {
      UrlFetchApp.fetch(CS_BASE_URL + '/oauth/revoke', {
        method: 'post',
        payload: { token: tok.refresh_token, client_id: clientId },
        muteHttpExceptions: true,
      });
    } catch (err) {
      /* sin red: igual se borra localmente */
    }
  }
  svc.reset();
}

/** La sesión dejó de valer (401): se olvidan las credenciales para volver a pedirlas. */
function forgetCredentials_() {
  PropertiesService.getUserProperties().deleteProperty(CS_PROP_API_KEY);
  try {
    getOAuthService_().reset();
  } catch (err) {
    /* sin client_id: no hay tokens */
  }
}

/** Guarda una API key si CalaSign la acepta. */
function saveApiKey_(key) {
  key = String(key || '').trim();
  if (!/^cs_(live|test)_[A-Za-z0-9_-]{8,}$/.test(key)) return false;
  var res = UrlFetchApp.fetch(CS_BASE_URL + '/v1/envelopes?limit=1', {
    method: 'get',
    headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
    muteHttpExceptions: true,
    followRedirects: false,
  });
  if (res.getResponseCode() !== 200) return false;
  PropertiesService.getUserProperties().setProperty(CS_PROP_API_KEY, key);
  return true;
}
