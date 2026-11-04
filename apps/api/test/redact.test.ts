import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { LOG_REDACT_PATHS, maskEmails, redactUrl, safeLoggerOptions, safeRequestSerializer, sanitizeLogValue } from "../src/lib/redact";

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

// SEG-20: los datos personales no llegan al log aunque alguien los loguee.

/** Lo que escribe pino con las opciones de la API y del worker (safeLoggerOptions). */
function logueadoSeguro(log: (l: pino.Logger) => void, level = "info"): string {
  let out = "";
  const dest = new Writable({
    write(chunk, _enc, cb) {
      out += String(chunk);
      cb();
    },
  });
  log(pino(safeLoggerOptions(level), dest));
  return out;
}
const linea = (log: (l: pino.Logger) => void) => JSON.parse(logueadoSeguro(log));

describe("safeLoggerOptions", () => {
  it("lleva las rutas de redact, el serializador del pedido y el nivel pedido", () => {
    const o = safeLoggerOptions("warn");
    expect(o.redact).toEqual({ paths: LOG_REDACT_PATHS, censor: "[redactado]" });
    expect(o.serializers.req).toBe(safeRequestSerializer);
    expect(logueadoSeguro((l) => l.info("no sale"), "warn")).toBe("");
    expect(linea((l) => l.info({ req: { url: `/s/${TOKEN}`, method: "GET" } }, "x")).req.url).toBe("/s/[redactado]");
  });
});

describe("maskEmails", () => {
  it("deja las dos primeras letras y el dominio de cada correo del texto", () => {
    expect(maskEmails("ana.perez@example.com")).toBe("an***@example.com");
    expect(maskEmails("a@example.com")).toBe("a***@example.com");
    expect(maskEmails("550 Ana.Perez+x%y-z_1@Sub-Dom.example.COM y bo@example.org no existen")).toBe(
      "550 An***@Sub-Dom.example.COM y bo***@example.org no existen",
    );
  });
  it("sin una dirección completa no toca nada", () => {
    for (const s of ["sin correo", "@vite/client", "ana@localhost", "ana@example.c", "x@.com"]) expect(maskEmails(s)).toBe(s);
  });
});

describe("redactUrl: datos personales en la query y en la ruta", () => {
  const PARAMS_CON_DATO_PERSONAL = [
    "q",
    "search",
    "login_hint",
    "email",
    "phone",
    "identification",
    "governmentalInformation.id",
    "document",
    "cpf",
    "cnpj",
    "dni",
  ];
  it.each(PARAMS_CON_DATO_PERSONAL)("?%s=<dato> se redacta y los demás parámetros quedan", (param) => {
    expect(redactUrl(`/v1/algo?lang=es&${param}=12345678&page=2`)).toBe(`/v1/algo?lang=es&${param}=[redactado]&page=2`);
  });
  it("un correo en el valor de cualquier parámetro o en la ruta se enmascara (el filtro de SCIM)", () => {
    const scim = redactUrl(`/scim/v2/Users?filter=${encodeURIComponent('userName eq "ana.perez@example.com"')}`);
    expect(decodeURIComponent(scim)).toBe('/scim/v2/Users?filter=userName eq "an***@example.com"');
    expect(redactUrl("/v1/contactos/ana.perez@example.com/ver")).toBe("/v1/contactos/an***@example.com/ver");
  });
});

describe("safeLoggerOptions: datos personales en cualquier objeto logueado", () => {
  const CLAVES_POR_EL_FINAL = [
    "email",
    "phone",
    "phoneNumber",
    "telefono",
    "telefone",
    "celular",
    "cpf",
    "cnpj",
    "cuit",
    "cuil",
    "dni",
    "curp",
    "taxId",
    "nationalId",
    "documentNumber",
    "idNumber",
    "identification",
    "passport",
    "fullName",
    "firstName",
    "lastName",
    "surname",
    "givenName",
    "familyName",
    "displayName",
    "userName",
    "signerName",
    "recipientName",
    "contactName",
    "birthDate",
    "dateOfBirth",
    "password",
    "secret",
    "token",
    "apiKey",
  ];
  it.each(CLAVES_POR_EL_FINAL)("%s se censura sola, con un prefijo y escrita de otra forma", (clave) => {
    const conPrefijo = `signer${clave[0].toUpperCase()}${clave.slice(1)}`;
    const out = linea((l) => l.info({ [clave]: "dato-1", [conPrefijo]: "dato-2", [`OTRO_${clave.toUpperCase()}`]: "dato-3" }, "x"));
    expect(out[clave]).toBe("[redactado]");
    expect(out[conPrefijo]).toBe("[redactado]");
    expect(out[`OTRO_${clave.toUpperCase()}`]).toBe("[redactado]");
  });
  const CLAVES_EXACTAS = [
    "rut",
    "rfc",
    "nit",
    "ssn",
    "otp",
    "authorization",
    "cookie",
    "body",
    "recipient",
    "recipients",
    "signer",
    "signers",
    "contact",
    "contacts",
  ];
  it.each(CLAVES_EXACTAS)("%s se censura entera (también en mayúsculas), pero no como final de otra palabra", (clave) => {
    const out = linea((l) => l.info({ [clave]: { a: "dato-1" }, [clave.toUpperCase()]: ["dato-2"], [`x${clave}`]: "queda" }, "x"));
    expect(out[clave]).toBe("[redactado]");
    expect(out[clave.toUpperCase()]).toBe("[redactado]");
    expect(out[`x${clave}`]).toBe("queda");
  });
  it("la clave se compara sin guiones, guiones bajos, puntos ni espacios", () => {
    const out = linea((l) => l.info({ "e-mail": "a", recipient_phone: "b", "doc.cpf": "c", "Signer Email": "d" }, "x"));
    expect(out).toEqual(
      expect.objectContaining({ "e-mail": "[redactado]", recipient_phone: "[redactado]", "doc.cpf": "[redactado]", "Signer Email": "[redactado]" }),
    );
  });
  it("lo que no es un dato personal queda: ids, nombres de cosas, códigos, la IP y los números o booleanos", () => {
    const datos = {
      recipientId: "r-1",
      userId: "u-1",
      name: "Contrato de alquiler",
      title: "Plantilla",
      code: "pdf_invalid",
      ip: "203.0.113.7",
      emailDomain: "example.com",
    };
    expect(linea((l) => l.info(datos, "x"))).toMatchObject(datos);
    const out = linea((l) => l.info({ signers: 3, hasPhone: true, email: null, phone: undefined }, "x"));
    expect(out).toMatchObject({ signers: 3, hasPhone: true, email: null });
    expect(out).not.toHaveProperty("phone");
  });
  it("recorre objetos y arrays anidados y enmascara los correos en cualquier texto, también en el mensaje", () => {
    const out = linea((l) =>
      l.warn(
        { job: { input: { to: "ana.perez@example.com", recipient: { email: "x" } } }, errors: [{ email: "x" }, "rebote de bo@example.org", 7] },
        "aviso a ana.perez@example.com",
      ),
    );
    expect(out.job.input).toEqual({ to: "an***@example.com", recipient: "[redactado]" });
    expect(out.errors).toEqual([{ email: "[redactado]" }, "rebote de bo***@example.org", 7]);
    expect(out.msg).toBe("aviso a an***@example.com");
    expect(linea((l) => l.info("hola %s", "ana.perez@example.com")).msg).toBe("hola an***@example.com");
  });
  it("hasta seis niveles se recorre; más hondo se censura (y un objeto circular no cuelga)", () => {
    const out = linea((l) => l.info({ a: { b: { c: { d: { e: { ok: "sí", email: "x", f: { ok: "no se ve" } } } } } } }, "x"));
    expect(out.a.b.c.d.e).toEqual({ ok: "sí", email: "[redactado]", f: "[redactado]" });
    const circular: Record<string, unknown> = { ok: "sí" };
    circular.yo = circular;
    expect(linea((l) => l.info({ circular }, "x")).circular.ok).toBe("sí");
    expect(sanitizeLogValue([[[[[["hondo"]]]]]])).toEqual([[[[[["hondo"]]]]]]);
    expect(sanitizeLogValue([[[[[[["hondo"]]]]]]])).toEqual([[[[[["[redactado]"]]]]]]);
    expect(sanitizeLogValue("ana.perez@example.com", 99)).toBe("an***@example.com");
    // Un número o un booleano más hondo que el tope no es un objeto: queda.
    expect(sanitizeLogValue([[[[[[7, true]]]]]])).toEqual([[[[[[7, true]]]]]]);
  });
  it("un error se loguea como error (tipo, mensaje, stack) sin los datos: el `detail` de Postgres, una propiedad con el correo", () => {
    class DatabaseError extends Error {
      detail = "Key (email)=(ana.perez@example.com) already exists.";
      email = "ana.perez@example.com";
      code = "23505";
    }
    const err = new DatabaseError("duplicado: ana.perez@example.com");
    const out = linea((l) => l.error({ err }, "falló"));
    expect(out.err).toMatchObject({
      type: "DatabaseError",
      message: "duplicado: an***@example.com",
      detail: "Key (email)=(an***@example.com) already exists.",
      email: "[redactado]",
      code: "23505",
    });
    expect(out.err.stack).toContain("duplicado: an***@example.com");
    expect(JSON.stringify(out)).not.toContain("ana.perez");
    // Un Error como primer argumento: pino lo pone en `err` y usa su mensaje.
    const solo = linea((l) => l.error(err));
    expect(solo.err.type).toBe("DatabaseError");
    expect(solo.msg).toBe("duplicado: an***@example.com");
    // El original no se toca: quien lo atrapó lo sigue viendo entero.
    expect(err.message).toBe("duplicado: ana.perez@example.com");
    expect(err.email).toBe("ana.perez@example.com");
    expect(sanitizeLogValue(err)).toBeInstanceOf(Error);
    expect(Object.keys(out.err).sort()).toEqual(["code", "detail", "email", "message", "stack", "type"]);
  });
  it("un DOMException (el TimeoutError de AbortSignal.timeout) se loguea sin reventar, y la causa también se limpia", () => {
    const out = linea((l) => l.error({ err: new DOMException("venció ana.perez@example.com", "TimeoutError") }, "x"));
    expect(out.err).toMatchObject({ type: "DOMException", message: "venció an***@example.com" });
    const conCausa = linea((l) => l.error({ err: new Error("falló el aviso", { cause: new Error("550 ana.perez@example.com") }) }, "x"));
    expect(conCausa.err.message).toBe("falló el aviso: 550 an***@example.com");
    expect(JSON.stringify(conCausa)).not.toContain("ana.perez");
    // Un mensaje que no es propio del error (un getter de la clase) también se copia y se enmascara.
    class MensajeCalculado extends Error {
      get message() {
        return "rebote de ana.perez@example.com";
      }
    }
    expect(linea((l) => l.error({ err: new MensajeCalculado() }, "x")).err).toMatchObject({
      type: "MensajeCalculado",
      message: "rebote de an***@example.com",
    });
  });
  it("los objetos de una clase quedan como están (el pedido de Fastify, un Buffer, una fecha) y el original nunca cambia", () => {
    class Pedido {
      email = "ana.perez@example.com";
    }
    const req = new Pedido();
    const buf = Buffer.from("x");
    const fecha = new Date(0);
    expect((sanitizeLogValue({ req }) as { req: unknown }).req).toBe(req);
    expect(sanitizeLogValue(buf)).toBe(buf);
    expect(sanitizeLogValue(fecha)).toBe(fecha);
    // Sin prototipo (como la query que arma Fastify) sí se recorre.
    const query = Object.assign(Object.create(null), { email: "x", lang: "es" });
    expect(sanitizeLogValue(query)).toEqual({ email: "[redactado]", lang: "es" });
    const original = { email: "ana.perez@example.com", lista: ["bo@example.org"] };
    sanitizeLogValue(original);
    expect(original).toEqual({ email: "ana.perez@example.com", lista: ["bo@example.org"] });
    expect(sanitizeLogValue(null)).toBe(null);
    expect(sanitizeLogValue(0)).toBe(0);
  });
});
