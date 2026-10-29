// PKI de laboratorio: raíz, CA intermedia, sello, TSA y certificados de prueba, con un servidor HTTP
// que responde OCSP, publica CRL y hace de TSA RFC 3161. Sirve para tests y para desarrollo local de
// B-LT/B-LTA sin depender de servicios externos. NO usar en producción.
import "reflect-metadata";
import { createServer, type Server } from "node:http";
import { randomBytes, webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";
import { derToPem } from "./provider";
import { OIDS, asn1js, hash, parseCert, pkijs, toAB } from "./pki";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const ALG = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 2048 } as const;

export interface LabIdentity {
  certDer: Uint8Array;
  certPem: string;
  key: CryptoKey;
  keyPem: string;
}

export interface LabPki {
  baseUrl: string;
  root: LabIdentity;
  intermediate: LabIdentity;
  seal: LabIdentity;
  tsa: LabIdentity;
  /** Cadena del sello en PEM: hoja + intermedia + raíz. */
  sealChainPem: string;
  /** Números de serie (hex) revocados por la CA intermedia. */
  revoked: Set<string>;
  issue(cn: string, opts?: LabIssueOptions): Promise<LabIdentity>;
}

export interface LabIssueOptions {
  ocsp?: boolean;
  years?: number;
  /** Atributo serialNumber (2.5.4.5) del sujeto, ej. "PNOPE-12345678" o "IDCCO-1020304050". */
  serialNumber?: string;
  /** CPF a incluir en el otherName 2.16.76.1.3.1 de ICP-Brasil. */
  icpBrasilCpf?: string;
  /** Tipo de clave del titular. */
  key?: "rsa" | "ec-p256" | "ec-p384";
}

/** SubjectAltName con otherName ICP-Brasil pessoa física: nacimiento (8) + CPF (11) + NIS (11) + RG (15)… */
function icpBrasilSan(cpf: string): x509.Extension {
  const text = `01011980${cpf.replace(/\D/g, "").padStart(11, "0")}${"0".repeat(11)}${"0".repeat(15)}SSPSP`;
  const otherName = new asn1js.Constructed({
    idBlock: { tagClass: 3, tagNumber: 0 },
    value: [
      new asn1js.ObjectIdentifier({ value: "2.16.76.1.3.1" }),
      new asn1js.Constructed({
        idBlock: { tagClass: 3, tagNumber: 0 },
        value: [new asn1js.OctetString({ valueHex: toAB(new Uint8Array(Buffer.from(text, "latin1"))) })],
      }),
    ],
  });
  const der = new asn1js.Sequence({ value: [otherName] }).toBER(false);
  return new x509.Extension("2.5.29.17", false, der);
}

function serial(): string {
  const b = randomBytes(12);
  b[0] &= 0x7f;
  return b.toString("hex");
}

async function identity(cert: x509.X509Certificate, keys: CryptoKeyPair): Promise<LabIdentity> {
  const der = new Uint8Array(cert.rawData);
  return {
    certDer: der,
    certPem: cert.toString("pem") + "\n",
    key: keys.privateKey,
    keyPem: derToPem(new Uint8Array(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey)), "PRIVATE KEY"),
  };
}

const keys = () => webcrypto.subtle.generateKey(ALG, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;

export async function createLabPki(baseUrl: string): Promise<LabPki> {
  const now = Date.now();
  const nb = new Date(now - 3600_000);
  const na = (y: number) => new Date(now + y * 365 * 86400_000);

  const rk = await keys();
  const rootCert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serial(),
    name: "CN=CalaSign Lab Root CA, O=CalaSign Lab",
    notBefore: nb,
    notAfter: na(10),
    keys: rk,
    signingAlgorithm: ALG,
    extensions: [
      new x509.BasicConstraintsExtension(true, 1, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(rk.publicKey),
    ],
  });
  const root = await identity(rootCert, rk);

  const ik = await keys();
  const interCert = await x509.X509CertificateGenerator.create({
    serialNumber: serial(),
    subject: "CN=CalaSign Lab Issuing CA, O=CalaSign Lab",
    issuer: rootCert.subject,
    notBefore: nb,
    notAfter: na(5),
    signingKey: rk.privateKey,
    publicKey: ik.publicKey,
    signingAlgorithm: ALG,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(ik.publicKey),
      await x509.AuthorityKeyIdentifierExtension.create(rootCert),
      new x509.CRLDistributionPointsExtension([`${baseUrl}/crl/root.crl`]),
    ],
  });
  const intermediate = await identity(interCert, ik);

  const leaf = async (cn: string, eku: string[], opts: LabIssueOptions = {}) => {
    const lk =
      opts.key === "ec-p256" || opts.key === "ec-p384"
        ? ((await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: opts.key === "ec-p256" ? "P-256" : "P-384" }, true, [
            "sign",
            "verify",
          ])) as CryptoKeyPair)
        : await keys();
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: serial(),
      subject: `CN=${cn}, O=CalaSign Lab${opts.serialNumber ? `, 2.5.4.5=${opts.serialNumber}` : ""}`,
      issuer: interCert.subject,
      notBefore: nb,
      notAfter: na(opts.years ?? 2),
      signingKey: ik.privateKey,
      publicKey: lk.publicKey,
      signingAlgorithm: ALG,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.nonRepudiation, true),
        new x509.ExtendedKeyUsageExtension(eku, eku.includes("1.3.6.1.5.5.7.3.8")),
        await x509.SubjectKeyIdentifierExtension.create(lk.publicKey),
        await x509.AuthorityKeyIdentifierExtension.create(interCert),
        new x509.AuthorityInfoAccessExtension({
          ...(opts.ocsp === false ? {} : { ocsp: `${baseUrl}/ocsp` }),
          caIssuers: `${baseUrl}/ca/intermediate.cer`,
        }),
        new x509.CRLDistributionPointsExtension([`${baseUrl}/crl/intermediate.crl`]),
        ...(opts.icpBrasilCpf ? [icpBrasilSan(opts.icpBrasilCpf)] : []),
      ],
    });
    return identity(cert, lk);
  };

  // emailProtection además de documentSigning: NSS (pdfsig, Firefox) valida firmas PDF con ese uso.
  const seal = await leaf("CalaSign Lab Sello de Plataforma", ["1.3.6.1.5.5.7.3.36", "1.3.6.1.5.5.7.3.4"]);
  const tsa = await leaf("CalaSign Lab TSA", ["1.3.6.1.5.5.7.3.8"]);
  return {
    baseUrl,
    root,
    intermediate,
    seal,
    tsa,
    sealChainPem: seal.certPem + intermediate.certPem + root.certPem,
    revoked: new Set(),
    issue: (cn, opts) => leaf(cn, ["1.3.6.1.5.5.7.3.36", "1.3.6.1.5.5.7.3.4"], opts),
  };
}

// ───────────────────────────── Servicios ─────────────────────────────

async function crlFor(pki: LabPki, which: "root" | "intermediate"): Promise<Uint8Array> {
  const ca = which === "root" ? pki.root : pki.intermediate;
  const caCert = new x509.X509Certificate(toAB(ca.certDer));
  const crl = await x509.X509CrlGenerator.create({
    issuer: caCert.subject,
    thisUpdate: new Date(Date.now() - 60_000),
    nextUpdate: new Date(Date.now() + 7 * 86400_000),
    entries: which === "intermediate" ? [...pki.revoked].map((s) => ({ serialNumber: s, revocationDate: new Date(Date.now() - 30_000) })) : [],
    signingKey: ca.key,
    signingAlgorithm: ALG,
  });
  return new Uint8Array(crl.rawData);
}

async function ocspResponse(pki: LabPki, body: Uint8Array): Promise<Uint8Array> {
  const req = pkijs.OCSPRequest.fromBER(toAB(body));
  const issuer = parseCert(pki.intermediate.certDer);
  const basic = new pkijs.BasicOCSPResponse();
  basic.tbsResponseData.responderID = issuer.subject;
  basic.tbsResponseData.producedAt = new Date();
  for (const r of req.tbsRequest.requestList) {
    const single = new pkijs.SingleResponse();
    single.certID = r.reqCert;
    const s = Buffer.from(r.reqCert.serialNumber.valueBlock.valueHexView).toString("hex");
    single.certStatus = pki.revoked.has(s)
      ? new asn1js.Constructed({
          idBlock: { tagClass: 3, tagNumber: 1 },
          value: [new asn1js.GeneralizedTime({ valueDate: new Date(Date.now() - 30_000) })],
        })
      : new asn1js.Primitive({ idBlock: { tagClass: 3, tagNumber: 0 }, lenBlockLength: 1 } as any);
    single.thisUpdate = new Date(Date.now() - 60_000);
    single.nextUpdate = new Date(Date.now() + 86400_000);
    basic.tbsResponseData.responses.push(single);
  }
  basic.certs = [issuer];
  await basic.sign(pki.intermediate.key, "SHA-256");
  const resp = new pkijs.OCSPResponse();
  resp.responseStatus.valueBlock.valueDec = 0;
  resp.responseBytes = new pkijs.ResponseBytes({
    responseType: OIDS.basicOcsp,
    response: new asn1js.OctetString({ valueHex: basic.toSchema().toBER(false) }),
  });
  return new Uint8Array(resp.toSchema().toBER(false));
}

let tsSerial = 1;

async function tsaResponse(pki: LabPki, body: Uint8Array): Promise<Uint8Array> {
  const req = pkijs.TimeStampReq.fromBER(toAB(body));
  const tsaCert = parseCert(pki.tsa.certDer);
  const tst = new pkijs.TSTInfo({
    version: 1,
    policy: "1.3.6.1.4.1.99999.1.1",
    messageImprint: req.messageImprint,
    serialNumber: new asn1js.Integer({ value: tsSerial++ }),
    genTime: new Date(),
    ordering: false,
    ...(req.nonce ? { nonce: req.nonce } : {}),
  });
  const tstDer = new Uint8Array(tst.toSchema().toBER(false));
  const essCertIdV2 = new asn1js.Sequence({
    value: [
      new asn1js.OctetString({ valueHex: toAB(hash("sha256", pki.tsa.certDer)) }),
      new asn1js.Sequence({
        value: [
          new asn1js.Sequence({ value: [new asn1js.Constructed({ idBlock: { tagClass: 3, tagNumber: 4 }, value: [tsaCert.issuer.toSchema()] })] }),
          tsaCert.serialNumber,
        ],
      }),
    ],
  });
  const sd = new pkijs.SignedData({
    version: 3,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: OIDS.tstInfo, eContent: new asn1js.OctetString({ valueHex: toAB(tstDer) }) }),
    signerInfos: [
      new pkijs.SignerInfo({
        version: 1,
        sid: new pkijs.IssuerAndSerialNumber({ issuer: tsaCert.issuer, serialNumber: tsaCert.serialNumber }),
        signedAttrs: new pkijs.SignedAndUnsignedAttributes({
          type: 0,
          attributes: [
            new pkijs.Attribute({ type: OIDS.contentType, values: [new asn1js.ObjectIdentifier({ value: OIDS.tstInfo })] }),
            new pkijs.Attribute({ type: OIDS.messageDigest, values: [new asn1js.OctetString({ valueHex: toAB(hash("sha256", tstDer)) })] }),
            new pkijs.Attribute({
              type: OIDS.signingCertificateV2,
              values: [new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [essCertIdV2] })] })],
            }),
          ],
        }),
      }),
    ],
    certificates: req.certReq ? [tsaCert, parseCert(pki.intermediate.certDer)] : undefined,
  });
  await sd.sign(pki.tsa.key, 0, "SHA-256");
  // pkijs codifica el eContent como OCTET STRING construido; RFC 3161 (y los validadores) esperan el primitivo.
  const sdSchema = sd.toSchema(true) as asn1js.Sequence;
  sdSchema.valueBlock.value[2] = new asn1js.Sequence({
    value: [
      new asn1js.ObjectIdentifier({ value: OIDS.tstInfo }),
      new asn1js.Constructed({ idBlock: { tagClass: 3, tagNumber: 0 }, value: [new asn1js.OctetString({ valueHex: toAB(tstDer) })] }),
    ],
  });
  const resp = new pkijs.TimeStampResp({
    status: new pkijs.PKIStatusInfo({ status: 0 }),
    timeStampToken: new pkijs.ContentInfo({ contentType: OIDS.signedData, content: sdSchema }),
  });
  return new Uint8Array(resp.toSchema().toBER(false));
}

export interface LabServer {
  url: string;
  close(): Promise<void>;
}

/** Levanta OCSP (/ocsp), CRL (/crl/root.crl, /crl/intermediate.crl), CA (/ca/*.cer) y TSA (/tsr). */
export async function startLabServer(pkiOrGetter: LabPki | (() => LabPki), port = 0, host = "127.0.0.1"): Promise<LabServer> {
  const server: Server = createServer(async (req, res) => {
    try {
      const pki = typeof pkiOrGetter === "function" ? pkiOrGetter() : pkiOrGetter;
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = new Uint8Array(Buffer.concat(chunks));
      const url = (req.url ?? "").split("?")[0];
      const send = (type: string, data: Uint8Array) => {
        res.writeHead(200, { "content-type": type, "content-length": data.length });
        res.end(Buffer.from(data));
      };
      if (req.method === "POST" && url === "/ocsp") return send("application/ocsp-response", await ocspResponse(pki, body));
      if (req.method === "POST" && url === "/tsr") return send("application/timestamp-reply", await tsaResponse(pki, body));
      if (url === "/crl/root.crl") return send("application/pkix-crl", await crlFor(pki, "root"));
      if (url === "/crl/intermediate.crl") return send("application/pkix-crl", await crlFor(pki, "intermediate"));
      if (url === "/ca/intermediate.cer") return send("application/pkix-cert", pki.intermediate.certDer);
      if (url === "/ca/root.cer") return send("application/pkix-cert", pki.root.certDer);
      res.writeHead(404).end();
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
  await new Promise<void>((r) => server.listen(port, host, r));
  const addr = server.address();
  const actual = typeof addr === "object" && addr ? addr.port : port;
  return {
    url: `http://${host}:${actual}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/** Levanta el servidor y crea la PKI con su URL real (puerto 0 = cualquiera libre). */
export async function startLab(port = 0, host = "127.0.0.1"): Promise<{ pki: LabPki; server: LabServer }> {
  let pki: LabPki | null = null;
  const server = await startLabServer(
    () => {
      if (!pki) throw new Error("PKI no lista");
      return pki;
    },
    port,
    host,
  );
  pki = await createLabPki(server.url);
  return { pki, server };
}
