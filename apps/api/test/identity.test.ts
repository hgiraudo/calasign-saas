import { createHmac, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matchIdentity, nameScore, normalizeDocumentNumber } from "../src/modules/identity/namematch";
import { getAdapter, mapTruoraProcess, mapVeriffDecision, mockDecide, veriffSignature, verifyHs256Jwt, WebhookSignatureError } from "../src/modules/identity/providers";
import { parseFilter, userPatchToAttrs } from "../src/modules/identity/scim";
import { normalizeCert, validateIdToken } from "../src/modules/identity/sso";

// ───────────── Fixtures escritas a partir de la documentación pública de cada proveedor ─────────────

/** Veriff: decision webhook (POST al callback de decisiones). */
const VERIFF_DECISION = {
  status: "success",
  verification: {
    id: "12df6045-3846-3e45-946a-14fa6136d78b",
    code: 9001,
    person: { firstName: "MARÍA JOSÉ", lastName: "GÓMEZ PÉREZ", idNumber: "00112345678", dateOfBirth: "1990-05-14" },
    reason: null,
    status: "approved",
    comments: [],
    document: { number: "00112345678", type: "ID_CARD", country: "DO", validUntil: "2031-01-01" },
    vendorData: "0192f0e0-0000-7000-8000-00000000abcd",
    decisionTime: "2026-10-17T12:00:00.000Z",
    acceptanceTime: "2026-10-17T11:58:00.000Z",
    riskLabels: [],
  },
  technicalData: { ip: "186.6.1.1" },
};

/** Truora: GET /v1/processes/{process_id}/result de Digital Identity. */
const TRUORA_RESULT = {
  process_id: "IDPe0d6b4f2a8b3c3a1b8b6a5e8b8b8b8b8",
  account_id: "0192f0e0-0000-7000-8000-00000000beef",
  flow_id: "IPFxxxx",
  status: "success",
  validations: [
    {
      validation_id: "VLD1",
      validation_type: "document-validation",
      validation_status: "success",
      details: {
        document_details: {
          name: "Lucia",
          last_name: "Fernandez Rojas",
          document_number: "1020304050",
          document_type: "national-id",
          country: "CO",
          date_of_birth: "1988-02-01",
          expiration_date: null,
        },
      },
    },
    {
      validation_id: "VLD2",
      validation_type: "face-recognition",
      validation_status: "success",
      details: { face_recognition_validations: { confidence_score: 0.97, similarity_status: "success", passive_liveness_status: "success" } },
    },
  ],
};

describe("coincidencia de nombres", () => {
  it("tolera acentos, mayúsculas, nombres extra del documento y partículas", () => {
    expect(nameScore("María José Gómez", "MARIA JOSE GOMEZ PEREZ")).toBe(1);
    expect(nameScore("Ana de la Cruz", "ANA LUCIA CRUZ MORALES")).toBe(1);
    expect(nameScore("João Gonçalves", "JOAO GONCALVES DA SILVA")).toBe(1);
  });
  it("tolera un error menor de tipeo pero no otra persona", () => {
    expect(nameScore("Fernández Rojas Lucía", "LUCIA FERNANDES ROJAS")).toBe(1);
    expect(nameScore("Lucía Fernández", "PEDRO RAMIREZ SOSA")).toBe(0);
  });
  it("translitera letras sin descomposición y compara cirílico y griego en su escritura", () => {
    expect(nameScore("Łukasz Wójcik", "LUKASZ WOJCIK")).toBe(1);
    expect(nameScore("Mehmet Yılmaz", "MEHMET YILMAZ")).toBe(1);
    expect(nameScore("Søren Ødegård", "SOREN ODEGARD")).toBe(1);
    expect(nameScore("Thomas Straße", "THOMAS STRASSE")).toBe(1);
    expect(nameScore("Đorđe Æsir", "DORDE AESIR")).toBe(1);
    expect(nameScore("Иван Петров", "ИВАН ПЕТРОВ")).toBe(1);
    expect(nameScore("Ελένη Παπαδοπούλου", "ΕΛΕΝΗ ΠΑΠΑΔΟΠΟΥΛΟΥ")).toBe(1);
    // Otra persona en cirílico no coincide (antes todo el cirílico se descartaba y el puntaje era 0 siempre).
    expect(nameScore("Иван Петров", "СЕРГЕЙ СМИРНОВ")).toBe(0);
  });
  it("un solo token declarado no alcanza si el documento tiene más", () => {
    expect(nameScore("María", "MARIA JOSE GOMEZ")).toBe(0.5);
  });
  it("compara números de documento sin separadores", () => {
    expect(normalizeDocumentNumber("001-1234567-8")).toBe(normalizeDocumentNumber("00112345678"));
    const r = matchIdentity({ name: "María José Gómez", documentNumber: "001-1234567-8" }, { fullName: "MARIA JOSE GOMEZ PEREZ", firstName: null, lastName: null, documentNumber: "00112345679" }, 0.8);
    expect(r.matched).toBe(true);
    expect(r.documentNumberMatched).toBe(false);
  });
});

describe("proveedor de prueba", () => {
  const settings = { decision: "approve" as const, extractedName: null, extractedDocumentNumber: null };
  const caps = (kinds: string[], same = false) => kinds.map((k, i) => ({ kind: k as any, sha256: same ? "x" : `h${i}` }));
  it("aprueba con todas las capturas y prueba de vida", () => {
    const r = mockDecide("document_selfie_liveness", caps(["document_front", "document_back", "selfie", "selfie_liveness"]), settings, { name: "Ana Pérez", documentNumber: "123" }, "v1");
    expect(r.status).toBe("approved");
    expect(r.liveness).toBe(true);
    expect(r.person.fullName).toBe("Ana Pérez");
    expect(r.document.number).toBe("123");
  });
  it("rechaza capturas faltantes, frente/dorso iguales, rostro y vida", () => {
    expect(mockDecide("document_selfie", caps(["document_front", "document_back"]), settings, { name: "A B", documentNumber: null }, "v").declineReason).toMatch(/missing_captures/);
    expect(mockDecide("document", caps(["document_front", "document_back"], true), settings, { name: "A B", documentNumber: null }, "v").declineReason).toBe("document_front_back_identical");
    expect(mockDecide("document_selfie", caps(["document_front", "document_back", "selfie"]), { ...settings, decision: "reject_face" }, { name: "A B", documentNumber: null }, "v").status).toBe("declined");
    const same = [...caps(["document_front", "document_back"]), { kind: "selfie" as const, sha256: "s" }, { kind: "selfie_liveness" as const, sha256: "s" }];
    expect(mockDecide("document_selfie_liveness", same, settings, { name: "A B", documentNumber: null }, "v").declineReason).toBe("liveness_failed");
  });
});

describe("Veriff", () => {
  it("normaliza la decisión", () => {
    const r = mapVeriffDecision(VERIFF_DECISION.verification);
    expect(r.status).toBe("approved");
    expect(r.person.fullName).toBe("MARÍA JOSÉ GÓMEZ PÉREZ");
    expect(r.document).toEqual({ type: "ID_CARD", number: "00112345678", country: "DO", expiresOn: "2031-01-01" });
    expect(r.reference).toBe(VERIFF_DECISION.verification.id);
    // Veriff pide volver a enviar las fotos en la misma sesión: no es una decisión final (queda en revisión).
    expect(mapVeriffDecision({ ...VERIFF_DECISION.verification, status: "resubmission_requested", reason: "Photo blurry" })).toMatchObject({
      status: "review",
      riskFlags: ["resubmission_requested"],
    });
    expect(mapVeriffDecision({ ...VERIFF_DECISION.verification, status: "declined", reason: "Fraud" })).toMatchObject({ status: "declined", declineReason: "Fraud" });
  });
  it("verifica la firma HMAC del webhook", () => {
    process.env.VERIFF_API_KEY = "k";
    process.env.VERIFF_SHARED_SECRET = "s3cret";
    const raw = Buffer.from(JSON.stringify(VERIFF_DECISION));
    const sig = createHmac("sha256", "s3cret").update(raw).digest("hex");
    expect(veriffSignature(raw, "s3cret")).toBe(sig);
    const [parsed] = getAdapter("veriff").parseWebhook!(raw, { "x-hmac-signature": sig });
    expect(parsed.providerRef).toBe(VERIFF_DECISION.verification.id);
    expect(parsed.result?.status).toBe("approved");
    expect(() => getAdapter("veriff").parseWebhook!(raw, { "x-hmac-signature": "00" + sig.slice(2) })).toThrow(WebhookSignatureError);
  });
});

describe("Truora", () => {
  it("normaliza el resultado del proceso", () => {
    const r = mapTruoraProcess(TRUORA_RESULT);
    expect(r.status).toBe("approved");
    expect(r.person.fullName).toBe("Lucia Fernandez Rojas");
    expect(r.document.number).toBe("1020304050");
    expect(r.faceMatchScore).toBe(0.97);
    expect(r.liveness).toBe(true);
    expect(mapTruoraProcess({ ...TRUORA_RESULT, status: "failure", declined_reason: "face_mismatch" }).declineReason).toBe("face_mismatch");
  });
  it("verifica el JWT HS256 del webhook", () => {
    const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const p = Buffer.from(JSON.stringify({ events: [{ event_type: "digital-identity", event_action: "succeeded", object: { ...TRUORA_RESULT } }] })).toString("base64url");
    const s = createHmac("sha256", "whsec").update(`${h}.${p}`).digest("base64url");
    expect(verifyHs256Jwt(`${h}.${p}.${s}`, "whsec").events[0].object.account_id).toBe(TRUORA_RESULT.account_id);
    expect(() => verifyHs256Jwt(`${h}.${p}.${s}`, "otro")).toThrow(WebhookSignatureError);
    process.env.TRUORA_API_KEY = "k";
    process.env.TRUORA_FLOW_ID = "f";
    process.env.TRUORA_WEBHOOK_SECRET = "whsec";
    const [parsed] = getAdapter("truora").parseWebhook!(Buffer.from(`${h}.${p}.${s}`), {});
    expect(parsed.providerRef).toBe(TRUORA_RESULT.account_id);
    expect(parsed.processId).toBe(TRUORA_RESULT.process_id);
    expect(parsed.result?.status).toBe("approved");
    expect(parsed.result?.faceMatched).toBe(true);
  });
  it("procesa todos los eventos de un webhook en lote", () => {
    process.env.TRUORA_API_KEY = "k";
    process.env.TRUORA_FLOW_ID = "f";
    process.env.TRUORA_WEBHOOK_SECRET = "whsec";
    const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const p = Buffer.from(
      JSON.stringify({
        events: [
          { event_type: "digital-identity", object: { account_id: "acc-1", process_id: "IDP1", status: "pending" } },
          { event_type: "other", object: {} },
          { event_type: "digital-identity", object: { ...TRUORA_RESULT, account_id: "acc-2" } },
        ],
      }),
    ).toString("base64url");
    const s = createHmac("sha256", "whsec").update(`${h}.${p}`).digest("base64url");
    const out = getAdapter("truora").parseWebhook!(Buffer.from(`${h}.${p}.${s}`), {});
    expect(out.map((x) => [x.providerRef, x.processId, x.result?.status ?? null])).toEqual([
      ["acc-1", "IDP1", null],
      ["acc-2", TRUORA_RESULT.process_id, "approved"],
    ]);
  });
  it("usa el flujo del nivel si está configurado", async () => {
    const { truoraFlowId } = await import("../src/modules/identity/providers");
    process.env.TRUORA_FLOW_ID = "IPFgeneral";
    process.env.TRUORA_FLOW_ID_DOCUMENT_SELFIE_LIVENESS = "IPFlive";
    expect(truoraFlowId("document_selfie_liveness")).toBe("IPFlive");
    expect(truoraFlowId("document")).toBe("IPFgeneral");
    delete process.env.TRUORA_FLOW_ID_DOCUMENT_SELFIE_LIVENESS;
  });
});

describe("nivel exigido", () => {
  const base = mapTruoraProcess(TRUORA_RESULT);
  it("exige coincidencia facial para los niveles con selfie y prueba de vida para el de liveness", async () => {
    const { levelSatisfied } = await import("../src/modules/identity/kyc");
    // Aprobado solo con el documento (flujo de Truora sin reconocimiento facial): no cumple document_selfie.
    const docOnly = { ...base, faceMatchScore: null, faceMatched: null, liveness: null };
    expect(levelSatisfied("document", docOnly, 0.8)).toBe(true);
    expect(levelSatisfied("document_selfie", docOnly, 0.8)).toBe(false);
    expect(levelSatisfied("document_selfie", { ...docOnly, faceMatchScore: 0.79 }, 0.8)).toBe(false);
    expect(levelSatisfied("document_selfie", { ...docOnly, faceMatchScore: 0.8 }, 0.8)).toBe(true);
    expect(levelSatisfied("document_selfie", { ...docOnly, faceMatched: true }, 0.8)).toBe(true);
    expect(levelSatisfied("document_selfie", { ...docOnly, faceMatchScore: 0.95, faceMatched: false }, 0.8)).toBe(false);
    // Liveness: además la prueba de vida explícitamente aprobada.
    expect(levelSatisfied("document_selfie_liveness", { ...docOnly, faceMatchScore: 0.95 }, 0.8)).toBe(false);
    expect(levelSatisfied("document_selfie_liveness", { ...docOnly, faceMatchScore: 0.95, liveness: false }, 0.8)).toBe(false);
    expect(levelSatisfied("document_selfie_liveness", { ...docOnly, faceMatchScore: 0.95, liveness: true }, 0.8)).toBe(true);
    // Veriff aprobado sin datos biométricos en la decisión.
    expect(levelSatisfied("document_selfie", mapVeriffDecision(VERIFF_DECISION.verification), 0.8)).toBe(false);
    expect(levelSatisfied("document_selfie", mapVeriffDecision({ ...VERIFF_DECISION.verification, faceMatch: { similarity: 0.91 } }), 0.8)).toBe(true);
  });
  it("distingue el dato contrario explícito (consume un intento) del dato faltante (level_not_met, configuración)", async () => {
    const { levelFailure } = await import("../src/modules/identity/kyc");
    const docOnly = { ...base, faceMatchScore: null, faceMatched: null, liveness: null };
    expect(levelFailure("document_selfie", docOnly, 0.8)).toBe("level_not_met");
    expect(levelFailure("document_selfie", { ...docOnly, faceMatchScore: 0.5 }, 0.8)).toBe("face_mismatch");
    expect(levelFailure("document_selfie", { ...docOnly, faceMatched: false }, 0.8)).toBe("face_mismatch");
    expect(levelFailure("document_selfie_liveness", { ...docOnly, faceMatched: true }, 0.8)).toBe("level_not_met");
    expect(levelFailure("document_selfie_liveness", { ...docOnly, faceMatched: true, liveness: false }, 0.8)).toBe("liveness_failed");
    expect(levelFailure("document_selfie_liveness", { ...docOnly, faceMatched: true, liveness: true }, 0.8)).toBe(null);
  });
  it("completa la aprobación con lo que declara la integración, sin pisar datos contrarios", async () => {
    const { withIntegrationCapabilities } = await import("../src/modules/identity/providers");
    const approved = mapVeriffDecision(VERIFF_DECISION.verification);
    const { config } = await import("../src/config");
    const prevLevel = config.identity.veriffIntegrationLevel;
    // VERIFF_INTEGRATION_LEVEL sin definir: null, no se infiere nada (ni con la configuración actual ni con filas viejas).
    expect(prevLevel).toBe(null);
    expect(withIntegrationCapabilities("veriff", "document_selfie", approved, 0.8).inferred).toEqual([]);
    expect(withIntegrationCapabilities("veriff", "document_selfie_liveness", approved, 0.8).result.liveness ?? null).toBe(null);
    try {
      // Declarada en document: no se infiere la coincidencia facial.
      (config.identity as { veriffIntegrationLevel: string }).veriffIntegrationLevel = "document";
      expect(withIntegrationCapabilities("veriff", "document_selfie", approved, 0.8)).toMatchObject({ inferred: [] });
      expect(withIntegrationCapabilities("veriff", "document_selfie", approved, 0.8).result.faceMatched ?? null).toBe(null);
      // El nivel guardado al iniciar gana sobre la configuración actual (en ambos sentidos); "none" no declara nada.
      expect(withIntegrationCapabilities("veriff", "document_selfie", approved, 0.8, "document_selfie").inferred).toEqual(["faceMatched"]);
      expect(withIntegrationCapabilities("veriff", "document_selfie", approved, 0.8, null).inferred).toEqual([]);
      (config.identity as { veriffIntegrationLevel: string }).veriffIntegrationLevel = "document_selfie_liveness";
      // NULL (filas anteriores a la columna) = "none", no la configuración actual.
      expect(withIntegrationCapabilities("veriff", "document_selfie", approved, 0.8, null).inferred).toEqual([]);
      expect(withIntegrationCapabilities("veriff", "document_selfie", approved, 0.8, "document").inferred).toEqual([]);
      expect(withIntegrationCapabilities("veriff", "document_selfie", approved, 0.8, "none").inferred).toEqual([]);
      (config.identity as { veriffIntegrationLevel: string }).veriffIntegrationLevel = "document_selfie";
      expect(withIntegrationCapabilities("veriff", "document_selfie", approved, 0.8)).toMatchObject({ result: { faceMatched: true, liveness: null }, inferred: ["faceMatched"] });
      expect(withIntegrationCapabilities("veriff", "document_selfie", { ...approved, faceMatchScore: 0.3 }, 0.8).result.faceMatched ?? null).toBe(null);
      expect(withIntegrationCapabilities("veriff", "document_selfie", { ...approved, status: "declined" }, 0.8).inferred).toEqual([]);
    } finally {
      (config.identity as { veriffIntegrationLevel: string | null }).veriffIntegrationLevel = prevLevel;
    }
    // Truora: solo con un flujo propio del nivel; el genérico no declara nada.
    const prev = process.env.TRUORA_FLOW_ID_DOCUMENT_SELFIE;
    try {
      delete process.env.TRUORA_FLOW_ID_DOCUMENT_SELFIE;
      expect(withIntegrationCapabilities("truora", "document_selfie", approved, 0.8).inferred).toEqual([]);
      process.env.TRUORA_FLOW_ID_DOCUMENT_SELFIE = "IPFsel";
      expect(withIntegrationCapabilities("truora", "document_selfie", approved, 0.8).inferred).toEqual(["faceMatched"]);
      expect(withIntegrationCapabilities("truora", "document_selfie", { ...approved, faceMatched: false }, 0.8).result.faceMatched).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.TRUORA_FLOW_ID_DOCUMENT_SELFIE;
      else process.env.TRUORA_FLOW_ID_DOCUMENT_SELFIE = prev;
    }
  });
  it("las variables numéricas vacías usan el valor por defecto", async () => {
    const { numEnv } = await import("../src/config");
    expect(numEnv("", 0.8)).toBe(0.8);
    expect(numEnv("  ", 0.8)).toBe(0.8);
    expect(numEnv(undefined, 0.8)).toBe(0.8);
    expect(numEnv("abc", 0.8)).toBe(0.8);
    expect(numEnv("0", 0.8)).toBe(0);
    expect(numEnv("0.65", 0.8)).toBe(0.65);
  });
  it("la referencia de Truora es el process_id", async () => {
    const { providerReference } = await import("../src/modules/identity/kyc");
    expect(providerReference({ provider: "truora", provider_ref: "verif-id", provider_process_id: "IDP9" })).toBe("IDP9");
    expect(providerReference({ provider: "truora", provider_ref: "verif-id", provider_process_id: null }, base)).toBe(TRUORA_RESULT.process_id);
    expect(providerReference({ provider: "veriff", provider_ref: "sess-1", provider_process_id: null }, base)).toBe("sess-1");
  });
});

describe("SCIM", () => {
  it("parsea filtros eq admitidos", () => {
    expect(parseFilter('userName eq "a@b.com"', ["userName"])).toEqual({ attr: "userName", value: "a@b.com" });
    expect(parseFilter('emails[type eq "work"].value eq "a@b.com"', ["emails.value"])).toEqual({ attr: "emails.value", value: "a@b.com" });
    expect(() => parseFilter('title co "x"', ["userName"])).toThrow();
  });
  it("reduce operaciones PATCH de Azure AD y Okta", () => {
    expect(userPatchToAttrs([{ op: "Replace", path: "active", value: "False" }])).toEqual({ active: "False" });
    expect(userPatchToAttrs([{ op: "replace", value: { active: false, "name.givenName": "Ana" } }])).toEqual({ active: false, "name.givenName": "Ana" });
    expect(userPatchToAttrs([{ op: "replace", path: 'emails[type eq "work"].value', value: "Nuevo@Correo.com" }])).toEqual({ userName: "nuevo@correo.com" });
    expect(() => userPatchToAttrs([{ op: "move", path: "active", value: true }])).toThrow();
  });
});

describe("OIDC: validación del id_token", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let server: Server;
  let jwksUri = "";
  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "a", use: "sig" }] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    jwksUri = `http://127.0.0.1:${(server.address() as any).port}/jwks`;
  });
  afterAll(() => server.close());
  const token = (claims: Record<string, unknown>, alg = "RS256") => {
    const h = Buffer.from(JSON.stringify({ alg, kid: "a" })).toString("base64url");
    const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${h}.${p}.${cryptoSign("sha256", Buffer.from(`${h}.${p}`), privateKey).toString("base64url")}`;
  };
  const now = Math.floor(Date.now() / 1000);
  const good = { iss: "https://idp.example", aud: "cli", exp: now + 60, iat: now, nonce: "n1", email: "a@b.com" };
  const opts = () => ({ issuer: "https://idp.example", clientId: "cli", nonce: "n1", jwksUri });
  it("acepta un token válido", async () => {
    expect((await validateIdToken(token(good), opts())).email).toBe("a@b.com");
  });
  it("rechaza iss, aud, exp, nonce, azp y algoritmos no admitidos", async () => {
    await expect(validateIdToken(token({ ...good, iss: "https://otro" }), opts())).rejects.toThrow(/iss/);
    await expect(validateIdToken(token({ ...good, aud: "otro" }), opts())).rejects.toThrow(/aud/);
    await expect(validateIdToken(token({ ...good, exp: now - 600 }), opts())).rejects.toThrow(/vencido/);
    await expect(validateIdToken(token({ ...good, nonce: "x" }), opts())).rejects.toThrow(/nonce/);
    await expect(validateIdToken(token({ ...good, aud: ["cli", "otro"], azp: "otro" }), opts())).rejects.toThrow(/azp/);
    await expect(validateIdToken(token(good, "none"), opts())).rejects.toThrow(/algoritmo/);
    const t = token(good);
    await expect(validateIdToken(t.slice(0, -6) + "AAAAAA", opts())).rejects.toThrow(/firma/);
  });
  it("normaliza certificados del IdP y rechaza basura", () => {
    expect(() => normalizeCert("no es un certificado ".repeat(10))).toThrow();
  });
});
