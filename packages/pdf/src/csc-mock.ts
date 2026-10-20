// Servidor CSC v2 mínimo para tests y desarrollo (auth/login, credentials/list|info|authorize,
// signatures/signHash). NO usar en producción.
import { createServer, type Server } from "node:http";
import { constants, createPrivateKey, privateEncrypt, randomUUID } from "node:crypto";
import type { LabIdentity, LabServer } from "./lab";
import { ecdsaSignDigestForTests } from "./sigalg";

export interface MockCscOptions {
  username: string;
  password: string;
  pin: string;
  credentials: Record<string, { identity: LabIdentity; chainDer: Uint8Array[] }>;
}

const DIGEST_INFO_SHA256 = Buffer.from("3031300d060960864801650304020105000420", "hex");

export async function startMockCsc(o: MockCscOptions, port = 0, host = "127.0.0.1"): Promise<LabServer & { calls: string[] }> {
  const tokens = new Set<string>();
  const sads = new Map<string, { credentialID: string; hashes: string[] }>();
  const calls: string[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: any = {};
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") : {};
    } catch {
      body = {};
    }
    const path = (req.url ?? "").replace(/^\/csc\/v2\//, "");
    calls.push(path);
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (path === "auth/login") {
      const [u, p] = Buffer.from(String(req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString().split(":");
      if (u !== o.username || p !== o.password) return json(401, { error: "invalid_request", error_description: "credenciales inválidas" });
      const t = randomUUID();
      tokens.add(t);
      return json(200, { access_token: t, expires_in: 3600 });
    }
    if (path === "info") {
      return json(200, { specs: "2.0.0.0", name: "CalaSign Mock CSC", methods: ["auth/login", "credentials/list", "credentials/info", "credentials/authorize", "signatures/signHash"] });
    }
    const tok = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!tokens.has(tok)) return json(401, { error: "invalid_token" });
    if (path === "credentials/list") return json(200, { credentialIDs: Object.keys(o.credentials) });
    const cred = o.credentials[body.credentialID];
    if (!cred) return json(400, { error: "invalid_request", error_description: "credentialID desconocido" });
    if (path === "credentials/info") {
      const ec = createPrivateKey(cred.identity.keyPem).asymmetricKeyType === "ec";
      return json(200, {
        key: { status: "enabled", algo: [ec ? "1.2.840.10045.4.3.2" : "1.2.840.113549.1.1.11"], len: ec ? 256 : 2048 },
        cert: { status: "valid", certificates: cred.chainDer.map((d) => Buffer.from(d).toString("base64")) },
        authMode: "explicit",
      });
    }
    if (path === "credentials/authorize") {
      if (body.PIN !== o.pin) return json(400, { error: "invalid_pin", error_description: "PIN incorrecto" });
      const sad = randomUUID();
      sads.set(sad, { credentialID: body.credentialID, hashes: body.hashes ?? [] });
      return json(200, { SAD: sad, expiresIn: 300 });
    }
    if (path === "signatures/signHash") {
      const s = sads.get(body.SAD);
      if (!s || s.credentialID !== body.credentialID || JSON.stringify(s.hashes) !== JSON.stringify(body.hashes)) {
        return json(400, { error: "invalid_request", error_description: "SAD inválido" });
      }
      sads.delete(body.SAD);
      const key = createPrivateKey(cred.identity.keyPem);
      const ec = key.asymmetricKeyType === "ec";
      // Como un prestador real: el signAlgo pedido tiene que corresponder a la clave de la credencial.
      if (body.signAlgo !== (ec ? "1.2.840.10045.4.3.2" : "1.2.840.113549.1.1.11")) {
        return json(400, { error: "invalid_request", error_description: "signAlgo no corresponde a la clave" });
      }
      const signatures = (body.hashes as string[]).map((h) =>
        ec
          ? Buffer.from(ecdsaSignDigestForTests(cred.identity.keyPem, new Uint8Array(Buffer.from(h, "base64")))).toString("base64")
          : privateEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.concat([DIGEST_INFO_SHA256, Buffer.from(h, "base64")])).toString("base64"),
      );
      return json(200, { signatures });
    }
    return json(404, { error: "not_found" });
  });
  await new Promise<void>((r) => server.listen(port, host, r));
  const addr = server.address();
  const actual = typeof addr === "object" && addr ? addr.port : port;
  return { url: `http://${host}:${actual}/csc/v2`, calls, close: () => new Promise((r) => server.close(() => r())) };
}
