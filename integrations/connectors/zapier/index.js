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
  if (response.status === 401) throw new z.errors.Error("CalaSign rejected the API key. Reconnect your account.", "unauthorized", 401);
  if (response.status >= 400 && !response.skipThrowForStatus && !(response.request && response.request.skipThrowForStatus)) {
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
    if (response.status === 429) throw new z.errors.ThrottledError(message, 60);
    throw new z.errors.Error(message, code, response.status);
  }
  return response;
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
