"use strict";
// CalaSign para Zapier (Zapier Platform CLI). Fuente: integrations/connectors/zapier/ del repo de CalaSign.
const authentication = require("./authentication");
const { BASE_URL } = require("./lib/api");
const hydrators = require("./hydrators");
const eventTriggers = require("./triggers/envelopeEvents");
const templateList = require("./triggers/templateList");
const creates = require("./creates");
const findEnvelope = require("./searches/findEnvelope");

const isOurs = (u) => typeof u === "string" && (u === BASE_URL || u.startsWith(`${BASE_URL}/`));

const addAuth = (request, z, bundle) => {
  // Solo a la API de CalaSign: los archivos de otros pasos (URLs de terceros) se descargan sin la API key.
  if (isOurs(request.url) && bundle.authData && bundle.authData.apiKey) request.headers.Authorization = `Bearer ${bundle.authData.apiKey}`;
  request.headers["User-Agent"] = "CalaSign-Zapier/{{VERSION}}";
  return request;
};

/** Errores de la API ({ error: { code, message } }) como mensajes legibles en Zapier. */
const handleErrors = (response, z) => {
  // Las respuestas de terceros (el PDF de otro paso) no son de CalaSign: un 401/404 del host del archivo se mostraba
  // como "CalaSign rejected the API key" o "CalaSign error 404". Esas las maneja la acción.
  if (!isOurs(response.request && response.request.url)) return response;
  // Las llamadas con skipThrowForStatus (p. ej. el DELETE de performUnsubscribe con una key ya revocada) manejan el
  // estado ellas mismas: ni siquiera un 401 debe tirar acá, o Zapier no puede apagar el Zap.
  if (response.status < 400 || response.skipThrowForStatus || (response.request && response.request.skipThrowForStatus)) return response;
  if (response.status === 401) throw new z.errors.Error("CalaSign rejected the API key. Reconnect your account.", "unauthorized", 401);
  let message = `CalaSign error ${response.status}`;
  let code = String(response.status);
  try {
    const body = typeof response.json === "object" && response.json ? response.json : JSON.parse(response.content);
    if (body && body.error) {
      message = body.error.message || message;
      code = body.error.code || code;
    }
  } catch (_) {
    /* cuerpo no JSON */
  }
  if (response.status === 429) {
    // Solo el límite de tasa genérico (con Retry-After, código bad_request/rate_limited) es reintentable. Los 429 de
    // negocio (reminded_recently, etc.) traen su propio código y no Retry-After: reintentarlos no sirve.
    const getHeader = (n) => (response.headers && typeof response.headers.get === "function" ? response.headers.get(n) : response.headers && response.headers[n]);
    const retryAfter = Number(getHeader("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) throw new z.errors.ThrottledError(message, Math.ceil(retryAfter));
    if (code === "429" || code === "bad_request" || code === "rate_limited") throw new z.errors.ThrottledError(message, 60);
  }
  // Otra ejecución con la misma Idempotency-Key sigue en curso: reintentar en unos segundos.
  if (response.status === 409 && code === "idempotency_in_progress") throw new z.errors.ThrottledError(message, 5);
  throw new z.errors.Error(message, code, response.status);
};

const byKey = (list) => Object.fromEntries(list.map((x) => [x.key, x]));

module.exports = {
  version: require("./package.json").version,
  platformVersion: require("zapier-platform-core").version,
  authentication,
  beforeRequest: [addAuth],
  afterResponse: [handleErrors],
  hydrators,
  triggers: byKey([...eventTriggers, templateList]),
  creates: byKey(creates),
  searches: byKey([findEnvelope]),
};
