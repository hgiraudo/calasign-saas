import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { LOG_REDACT_PATHS, redactUrl, safeRequestSerializer } from "../src/lib/redact";

const TOKEN = "Ab3dEfGhIjKlMnOpQrStUvWxYz0123456789_-abc";

describe("redactUrl", () => {
  it("redacta los secretos en rutas conocidas", () => {
    expect(redactUrl(`/v1/signing/${TOKEN}/complete`)).toBe("/v1/signing/[redactado]/complete");
    expect(redactUrl(`/s/${TOKEN}`)).toBe("/s/[redactado]");
    expect(redactUrl("/v1/certsign/sessions/ABCDE-FGH23/signature")).toBe("/v1/certsign/sessions/[redactado]/signature");
    expect(redactUrl("/embed/short1")).toBe("/embed/[redactado]");
    expect(redactUrl(`/v1/downloads/${TOKEN}`)).toBe("/v1/downloads/[redactado]");
    expect(redactUrl(`/v1/invite/${TOKEN}/accept`)).toBe("/v1/invite/[redactado]/accept");
    expect(redactUrl(`/reset/${TOKEN}`)).toBe("/reset/[redactado]");
    expect(redactUrl(`/v1/public/negotiations/${TOKEN}/pdf`)).toBe("/v1/public/negotiations/[redactado]/pdf");
  });
  it("redacta el pase de firma del celular (página /h/<token> y su endpoint público), también con un token corto", () => {
    expect(redactUrl(`/h/${TOKEN}`)).toBe("/h/[redactado]");
    expect(redactUrl("/h/corto")).toBe("/h/[redactado]");
    expect(redactUrl(`/v1/public/signature-handoffs/${TOKEN}`)).toBe("/v1/public/signature-handoffs/[redactado]");
    expect(redactUrl("/v1/public/signature-handoffs/corto?x=1")).toBe("/v1/public/signature-handoffs/[redactado]?x=1");
    // El id del pase (UUID) que consulta la computadora no es un secreto; el token de firma sí.
    expect(redactUrl(`/v1/signing/${TOKEN}/signature-handoffs/0192f0e0-0000-7000-8000-000000000001`)).toBe(
      "/v1/signing/[redactado]/signature-handoffs/0192f0e0-0000-7000-8000-000000000001",
    );
  });
  it("redacta segmentos con forma de token aunque la ruta no esté listada, pero no los UUID", () => {
    expect(redactUrl(`/v1/algo/${TOKEN}`)).toBe("/v1/algo/[redactado]");
    expect(redactUrl("/v1/envelopes/0192f0e0-0000-7000-8000-000000000001/send")).toBe("/v1/envelopes/0192f0e0-0000-7000-8000-000000000001/send");
  });
  it("redacta parámetros sensibles de la query y conserva el resto", () => {
    const out = redactUrl("/v1/auth/sso/oidc/callback?code=abc123&state=xyz&lang=es");
    expect(out).toContain("code=[redactado]");
    expect(out).toContain("state=[redactado]");
    expect(out).toContain("lang=es");
    expect(out).not.toContain("abc123");
  });
  it("redacta `k` de los retornos de pago/identidad, el nonce `n` y tokens en el primer segmento de un valor", () => {
    const pay = redactUrl(`/v1/payments/return/abc?payment=success&k=${TOKEN}`);
    expect(pay).toContain("k=[redactado]");
    expect(pay).toContain("payment=success");
    expect(pay).not.toContain(TOKEN);
    expect(redactUrl(`/v1/identity/return/abc?k=short`)).toBe("/v1/identity/return/abc?k=[redactado]");
    expect(redactUrl(`/v1/payments/mock/checkout/abc?n=xyz`)).toBe("/v1/payments/mock/checkout/abc?n=[redactado]");
    // Un parámetro no listado cuyo valor es directamente un token (sin "/") también se redacta.
    const ref = redactUrl(`/v1/algo?ref=${TOKEN}`);
    expect(ref).not.toContain(TOKEN);
    expect(decodeURIComponent(ref)).toBe("/v1/algo?ref=[redactado]");
    expect(redactUrl(`/v1/algo?next=${encodeURIComponent(`/s/${TOKEN}`)}`)).not.toContain(TOKEN);
    expect(redactUrl("/v1/algo?lang=es")).toBe("/v1/algo?lang=es");
  });
  it("el serializador no incluye headers", () => {
    const s = safeRequestSerializer({ method: "GET", url: `/s/${TOKEN}`, hostname: "x", ip: "1.2.3.4" });
    expect(s.url).toBe("/s/[redactado]");
    expect(Object.keys(s)).not.toContain("headers");
  });
});

// Casos de mutation testing (tests-automatizados.md §8): cada entrada de las listas con su propio caso, con un secreto
// corto que no tiene forma de token (si no, lo redacta TOKEN_LIKE y la entrada de la lista no se prueba).
describe("redactUrl: cada entrada de las listas", () => {
  const CORTO = "corto1";
  const RUTAS_CON_SECRETO = [
    "/s",
    "/v1/signing",
    "/embed",
    "/v1/certsign/sessions",
    "/v1/downloads",
    "/v1/invite",
    "/invite",
    "/v1/public/negotiations",
    "/v1/public/workflow-runs",
    "/v1/public/signature-handoffs",
    "/h",
    "/n",
    "/w",
    "/reset",
  ];
  it.each(RUTAS_CON_SECRETO)("%s/<secreto> redacta el segmento del secreto y deja el resto", (prefijo) => {
    expect(redactUrl(`${prefijo}/${CORTO}`)).toBe(`${prefijo}/[redactado]`);
    expect(redactUrl(`${prefijo}/${CORTO}/pdf`)).toBe(`${prefijo}/[redactado]/pdf`);
  });
  it("el prefijo tiene que coincidir entero y desde la raíz", () => {
    // Un segmento corto sin forma de token, fuera de las rutas listadas, queda: los ids y nombres siguen legibles.
    expect(redactUrl(`/v1/envelopes/${CORTO}`)).toBe(`/v1/envelopes/${CORTO}`);
    expect(redactUrl(`/x/s/${CORTO}`)).toBe(`/x/s/${CORTO}`);
    expect(redactUrl(`/v1/signing/${CORTO}/fields/${CORTO}`)).toBe(`/v1/signing/[redactado]/fields/${CORTO}`);
    expect(redactUrl("/v1/signing")).toBe("/v1/signing");
    expect(redactUrl("/v1/public")).toBe("/v1/public");
  });
  it("no inventa un secreto en un segmento vacío", () => {
    expect(redactUrl("/s/")).toBe("/s/");
    expect(redactUrl("/v1/signing//complete")).toBe("/v1/signing//complete");
  });

  const PARAMS_CON_SECRETO = [
    "code",
    "token",
    "state",
    "access_token",
    "refresh_token",
    "id_token",
    "client_secret",
    "api_key",
    "apikey",
    "key",
    "secret",
    "password",
    "signature",
    "samlresponse",
    "relaystate",
    "code_verifier",
    "k",
    "n",
    "nonce",
    "ticket",
    "otp",
  ];
  it.each(PARAMS_CON_SECRETO)("?%s=<secreto> se redacta y los demás parámetros quedan", (param) => {
    expect(redactUrl(`/v1/algo?lang=es&${param}=${CORTO}&page=2`)).toBe(`/v1/algo?lang=es&${param}=[redactado]&page=2`);
  });
  it("los nombres de parámetro se comparan sin mayúsculas (SAML manda SAMLResponse y RelayState)", () => {
    expect(redactUrl(`/v1/auth/sso/saml/acs?SAMLResponse=${CORTO}&RelayState=${CORTO}`)).toBe(
      "/v1/auth/sso/saml/acs?SAMLResponse=[redactado]&RelayState=[redactado]",
    );
  });
  it("sin URL devuelve vacío", () => {
    expect(redactUrl(undefined)).toBe("");
    expect(redactUrl(null)).toBe("");
    expect(redactUrl("")).toBe("");
  });
  it("con query conserva el `?` y el orden", () => {
    expect(redactUrl("/v1/algo?a=1&b=2")).toBe("/v1/algo?a=1&b=2");
    expect(redactUrl("/v1/algo?")).toBe("/v1/algo?");
  });
});

describe("redactUrl: forma de token y de UUID", () => {
  const UUID = "0192f0e0-0000-7000-8000-000000000001";
  it("un UUID entero no se redacta, pero un token que sólo contiene un UUID sí", () => {
    expect(redactUrl(`/v1/envelopes/${UUID}`)).toBe(`/v1/envelopes/${UUID}`);
    expect(redactUrl(`/v1/envelopes/${UUID.toUpperCase()}`)).toBe(`/v1/envelopes/${UUID.toUpperCase()}`);
    expect(redactUrl(`/v1/algo/abc${UUID}`)).toBe("/v1/algo/[redactado]");
    expect(redactUrl(`/v1/algo/${UUID}abc`)).toBe("/v1/algo/[redactado]");
  });
  it("con forma de token es todo el segmento: con otros caracteres antes o después queda legible", () => {
    const largo = "Ab3dEfGhIjKlMnOpQrStUvWx"; // 24 caracteres: el mínimo
    expect(redactUrl(`/v1/algo/${largo}`)).toBe("/v1/algo/[redactado]");
    expect(redactUrl(`/v1/algo/${largo.slice(1)}`)).toBe(`/v1/algo/${largo.slice(1)}`);
    // Los archivos con hash de Vite (`index-<hash>.js`) no son secretos.
    expect(redactUrl(`/assets/${largo}.js`)).toBe(`/assets/${largo}.js`);
    expect(redactUrl(`/assets/x.${largo}`)).toBe(`/assets/x.${largo}`);
  });
  it("en un valor de query, el primer segmento con forma de token se redacta salvo que sea un UUID", () => {
    const largo = "Ab3dEfGhIjKlMnOpQrStUvWx";
    expect(redactUrl(`/v1/algo?ref=${largo}`)).toBe("/v1/algo?ref=%5Bredactado%5D");
    expect(redactUrl(`/v1/algo?ref=${UUID}`)).toBe(`/v1/algo?ref=${UUID}`);
    expect(redactUrl("/v1/algo?ref=corto")).toBe("/v1/algo?ref=corto");
  });
});

describe("LOG_REDACT_PATHS", () => {
  function logueado(obj: object): string {
    let out = "";
    const dest = new Writable({
      write(chunk, _enc, cb) {
        out += String(chunk);
        cb();
      },
    });
    pino({ redact: { paths: LOG_REDACT_PATHS, censor: "[redactado]" } }, dest).info(obj, "x");
    return out;
  }
  it("censura Authorization, Cookie y X-Api-Key si un log incluye los headers (con o sin `req.`)", () => {
    const headers = { authorization: "Bearer secreto-a", cookie: "sid=secreto-b", "x-api-key": "secreto-c", accept: "text/html" };
    const conReq = logueado({ req: { headers } });
    const sinReq = logueado({ headers });
    for (const linea of [conReq, sinReq]) expect(linea).toContain("text/html");
    expect(conReq).not.toMatch(/secreto-[abc]/);
    expect(sinReq).not.toMatch(/secreto-[ab]/);
    expect(JSON.parse(conReq).req.headers).toMatchObject({ authorization: "[redactado]", cookie: "[redactado]", "x-api-key": "[redactado]" });
    expect(JSON.parse(sinReq).headers).toMatchObject({ authorization: "[redactado]", cookie: "[redactado]" });
  });
});
