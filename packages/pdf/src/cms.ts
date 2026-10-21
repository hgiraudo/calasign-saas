// Firma CMS para PAdES Baseline (ETSI EN 319 142-1): SubFilter ETSI.CAdES.detached,
// atributos firmados contentType + messageDigest + signingCertificateV2, y opcionalmente
// signatureTimeStampToken (B-T) como atributo no firmado.
import { X509Certificate, randomBytes, verify as cryptoVerify, webcrypto } from "node:crypto";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { hasTimeStampingEku, signerCertOf } from "./pki";
import { sha256, type SignatureProvider } from "./provider";
import { normalizeEcdsaSignature, signingAlgorithmFor, type CmsSignatureAlgorithm } from "./sigalg";

pkijs.setEngine("node", new pkijs.CryptoEngine({ name: "node", crypto: webcrypto as unknown as Crypto }));

const OID = {
  data: "1.2.840.113549.1.7.1",
  signedData: "1.2.840.113549.1.7.2",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
  signatureTimeStampToken: "1.2.840.113549.1.9.16.2.14",
  sha256: "2.16.840.1.101.3.4.2.1",
  sha256WithRSA: "1.2.840.113549.1.1.11",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
};

function toAB(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

export interface CmsOptions {
  /** URL de una TSA RFC 3161. Si falta, la firma queda en PAdES B-B. */
  tsaUrl?: string | null;
  tsaAuthHeader?: string | null;
}

export async function buildPadesCms(content: Uint8Array, provider: SignatureProvider, opts: CmsOptions = {}) {
  const chainDer = await provider.certificateChain();
  const signedAttrsDer = buildSignedAttributes(sha256(content), chainDer);
  // El algoritmo sale de la clave del certificado: un prestador CSC con clave ECDSA firma con ecdsa-with-SHA256.
  const { algorithm, namedCurve } = signingAlgorithmFor(chainDer[0]);
  const raw = await provider.signDigest(sha256(signedAttrsDer));
  const signature = algorithm === "ECDSA" ? normalizeEcdsaSignature(raw, namedCurve) : raw;
  assertSignatureMatchesCertificate(signedAttrsDer, signature, chainDer[0], provider.id);
  return assembleCms({ signedAttrsDer, chainDer, signature, signatureAlgorithm: algorithm }, opts);
}

/** La firma del proveedor no verifica con la clave pública de su certificado (chain[0]). */
export class SignatureKeyMismatchError extends Error {
  override name = "SignatureKeyMismatchError";
}

/**
 * Comprueba la firma recién hecha con la clave pública del certificado firmante. Si la clave del proveedor (KMS, PEM,
 * CSC) no corresponde al certificado de su cadena —por ejemplo, tras rotar la clave y no la cadena—, el PDF saldría con
 * una firma que ningún validador acepta; mejor fallar acá (el job de finalización falla con este error y se reintenta).
 */
export function assertSignatureMatchesCertificate(signedAttrsDer: Uint8Array, signature: Uint8Array, certDer: Uint8Array, providerId = "?"): void {
  let ok = false;
  try {
    const key = new X509Certificate(certDer).publicKey;
    ok = cryptoVerify("sha256", signedAttrsDer, key.asymmetricKeyType === "ec" ? { key, dsaEncoding: "der" } : key, signature);
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new SignatureKeyMismatchError(
      `La firma del proveedor "${providerId}" no verifica con la clave pública de su certificado: la clave de firma no corresponde al primer certificado de la cadena (revisar SEAL_KEY_FILE / KMS_KEY_ID y SEAL_CHAIN_FILE)`,
    );
  }
}

/**
 * Atributos firmados PAdES (contentType, messageDigest, signingCertificateV2) en DER, como SET OF ordenado.
 * Es exactamente lo que firma el titular: su SHA-256 es el "hash a firmar" de la firma en dos pasos.
 */
export function buildSignedAttributes(contentDigest: Uint8Array, chainDer: Uint8Array[]): Uint8Array {
  const certs = chainDer.map((d) => pkijs.Certificate.fromBER(toAB(d)));
  const signerCert = certs[0];

  // ESSCertIDv2 (hashAlgorithm por defecto = SHA-256, se omite) con IssuerSerial.
  const essCertIdV2 = new asn1js.Sequence({
    value: [
      new asn1js.OctetString({ valueHex: toAB(sha256(chainDer[0])) }),
      new asn1js.Sequence({
        value: [
          new asn1js.Sequence({
            value: [
              new asn1js.Constructed({
                idBlock: { tagClass: 3, tagNumber: 4 },
                value: [signerCert.issuer.toSchema()],
              }),
            ],
          }),
          signerCert.serialNumber,
        ],
      }),
    ],
  });
  const signingCertificateV2 = new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [essCertIdV2] })] });

  const attrs = [
    new pkijs.Attribute({ type: OID.contentType, values: [new asn1js.ObjectIdentifier({ value: OID.data })] }),
    new pkijs.Attribute({ type: OID.messageDigest, values: [new asn1js.OctetString({ valueHex: toAB(contentDigest) })] }),
    new pkijs.Attribute({ type: OID.signingCertificateV2, values: [signingCertificateV2] }),
  ];
  // DER: SET OF ordenado por su codificación.
  const encoded = attrs.map((a) => ({ a, der: new Uint8Array(a.toSchema().toBER(false)) }));
  encoded.sort((x, y) => Buffer.compare(Buffer.from(x.der), Buffer.from(y.der)));
  const sortedAttrs = encoded.map((e) => e.a);

  return new Uint8Array(new asn1js.Set({ value: sortedAttrs.map((a) => a.toSchema()) }).toBER(false));
}

export type { CmsSignatureAlgorithm };

/** Arma el CMS SignedData a partir de los atributos firmados y la firma del titular (RSA o ECDSA en DER). */
export async function assembleCms(
  x: { signedAttrsDer: Uint8Array; chainDer: Uint8Array[]; signature: Uint8Array; signatureAlgorithm: CmsSignatureAlgorithm },
  opts: CmsOptions = {},
): Promise<Uint8Array> {
  const certs = x.chainDer.map((d) => pkijs.Certificate.fromBER(toAB(d)));
  const signerCert = certs[0];
  const parsed = asn1js.fromBER(toAB(x.signedAttrsDer));
  if (parsed.offset === -1 || !(parsed.result instanceof asn1js.Set)) throw new Error("atributos firmados inválidos");
  const sortedAttrs = (parsed.result.valueBlock.value as asn1js.Sequence[]).map((v) => new pkijs.Attribute({ schema: v }));
  const signature = x.signature;

  const signerInfo = new pkijs.SignerInfo({
    version: 1,
    sid: new pkijs.IssuerAndSerialNumber({ issuer: signerCert.issuer, serialNumber: signerCert.serialNumber }),
    digestAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID.sha256 }),
    signedAttrs: new pkijs.SignedAndUnsignedAttributes({ type: 0, attributes: sortedAttrs }),
    signatureAlgorithm:
      x.signatureAlgorithm === "ECDSA"
        ? new pkijs.AlgorithmIdentifier({ algorithmId: OID.ecdsaWithSha256 })
        : new pkijs.AlgorithmIdentifier({ algorithmId: OID.sha256WithRSA, algorithmParams: new asn1js.Null() }),
    signature: new asn1js.OctetString({ valueHex: toAB(signature) }),
  });

  if (opts.tsaUrl) {
    const token = await requestTimestampToken(opts.tsaUrl, sha256(signature), opts.tsaAuthHeader, signature);
    const parsed = asn1js.fromBER(toAB(token));
    if (parsed.offset === -1) throw new Error("token de sello de tiempo inválido");
    signerInfo.unsignedAttrs = new pkijs.SignedAndUnsignedAttributes({
      type: 1,
      attributes: [new pkijs.Attribute({ type: OID.signatureTimeStampToken, values: [parsed.result] })],
    });
  }

  const signedData = new pkijs.SignedData({
    version: 1,
    digestAlgorithms: [new pkijs.AlgorithmIdentifier({ algorithmId: OID.sha256 })],
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: OID.data }),
    certificates: certs,
    signerInfos: [signerInfo],
  });
  const contentInfo = new pkijs.ContentInfo({ contentType: OID.signedData, content: signedData.toSchema(true) });
  return new Uint8Array(contentInfo.toSchema().toBER(false));
}

/** Pide un TimeStampToken (RFC 3161) sobre un digest SHA-256. Devuelve el ContentInfo DER. */
/** Falla de la TSA (red, HTTP, rechazo o respuesta que no corresponde): quien sella puede caer a B-B solo por esto. */
export class TsaError extends Error {
  override name = "TsaError";
}

/**
 * `digest` es el SHA-256 de `data` (lo sellado). `data` hace falta para verificar el token antes de incrustarlo: pkijs
 * comprueba el messageImprint contra el hash de los datos.
 */
export async function requestTimestampToken(url: string, digest: Uint8Array, authHeader: string | null | undefined, data: Uint8Array) {
  try {
    return await requestTimestampTokenRaw(url, digest, authHeader, data);
  } catch (e) {
    throw e instanceof TsaError ? e : new TsaError(e instanceof Error ? e.message : String(e));
  }
}

async function requestTimestampTokenRaw(url: string, digest: Uint8Array, authHeader: string | null | undefined, data: Uint8Array) {
  const nonce = randomBytes(8);
  nonce[0] &= 0x7f;
  const req = new pkijs.TimeStampReq({
    version: 1,
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID.sha256 }),
      hashedMessage: new asn1js.OctetString({ valueHex: toAB(digest) }),
    }),
    nonce: new asn1js.Integer({ valueHex: toAB(new Uint8Array(nonce)) }),
    certReq: true,
  });
  const headers: Record<string, string> = { "Content-Type": "application/timestamp-query" };
  if (authHeader) headers.Authorization = authHeader;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: Buffer.from(req.toSchema().toBER(false)),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`TSA respondió HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const resp = pkijs.TimeStampResp.fromBER(toAB(buf));
  const status = resp.status.status;
  if ((status !== 0 && status !== 1) || !resp.timeStampToken) {
    throw new Error(`TSA rechazó el pedido (status ${status})`);
  }
  // El sello tiene que ser de ESTE pedido: mismo hash (SHA-256) y mismo nonce. Si no, quedaría incrustado un sello
  // que no corresponde a la firma.
  const token = new pkijs.SignedData({ schema: resp.timeStampToken.content });
  const eContent = token.encapContentInfo.eContent;
  if (!eContent) throw new Error("La TSA devolvió un sello sin TSTInfo");
  const tst = pkijs.TSTInfo.fromBER(eContent.getValue().slice(0));
  const imprint = new Uint8Array(tst.messageImprint.hashedMessage.valueBlock.valueHexView);
  if (tst.messageImprint.hashAlgorithm.algorithmId !== OID.sha256 || !Buffer.from(imprint).equals(Buffer.from(digest))) {
    throw new Error("La TSA devolvió un sello para otro contenido");
  }
  const gotNonce = tst.nonce ? Buffer.from(tst.nonce.valueBlock.valueHexView) : null;
  const strip = (b: Buffer) => b.subarray(b.findIndex((x) => x !== 0) < 0 ? b.length : b.findIndex((x) => x !== 0));
  if (!gotNonce || !strip(gotNonce).equals(strip(nonce))) throw new Error("La TSA devolvió un sello con otro nonce");
  await checkTimestampToken(token, tst, data);
  return new Uint8Array(resp.timeStampToken.toSchema().toBER(false));
}

/**
 * Lo mismo que exige el validador (validate.ts, verifyToken) a un sello de tiempo, antes de incrustarlo: firma CMS del
 * token correcta (con el messageImprint sobre `data`), certificado de la TSA presente y con uso extendido timeStamping, y
 * vigente en genTime. Un sello que no pasa esto dejaría la firma en un B-T que el validador reporta inválido; mejor fallar
 * con TsaError (quien sella puede caer a B-B).
 */
async function checkTimestampToken(token: pkijs.SignedData, tst: pkijs.TSTInfo, data: Uint8Array): Promise<void> {
  let ok = false;
  try {
    ok = (await token.verify({ signer: 0, data: toAB(data), checkChain: false, extendedMode: true })).signatureVerified === true;
  } catch {
    ok = false;
  }
  if (!ok) throw new Error("La firma del sello de tiempo de la TSA no verifica");
  const tsa = signerCertOf(token);
  if (!tsa) throw new Error("La TSA devolvió un sello sin su certificado");
  if (!hasTimeStampingEku(tsa)) throw new Error("El certificado de la TSA no tiene el uso extendido timeStamping");
  const at = tst.genTime;
  if (!(tsa.notBefore.value <= at && at <= tsa.notAfter.value)) throw new Error("El certificado de la TSA no estaba vigente en la hora del sello");
}
