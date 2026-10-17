// Firma CMS para PAdES Baseline (ETSI EN 319 142-1): SubFilter ETSI.CAdES.detached,
// atributos firmados contentType + messageDigest + signingCertificateV2, y opcionalmente
// signatureTimeStampToken (B-T) como atributo no firmado.
import { webcrypto, randomBytes } from "node:crypto";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { sha256, type SignatureProvider } from "./provider";

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
    new pkijs.Attribute({ type: OID.messageDigest, values: [new asn1js.OctetString({ valueHex: toAB(sha256(content)) })] }),
    new pkijs.Attribute({ type: OID.signingCertificateV2, values: [signingCertificateV2] }),
  ];
  // DER: SET OF ordenado por su codificación.
  const encoded = attrs.map((a) => ({ a, der: new Uint8Array(a.toSchema().toBER(false)) }));
  encoded.sort((x, y) => Buffer.compare(Buffer.from(x.der), Buffer.from(y.der)));
  const sortedAttrs = encoded.map((e) => e.a);

  const toBeSigned = new Uint8Array(new asn1js.Set({ value: sortedAttrs.map((a) => a.toSchema()) }).toBER(false));
  const signature = await provider.signDigest(sha256(toBeSigned));

  const signerInfo = new pkijs.SignerInfo({
    version: 1,
    sid: new pkijs.IssuerAndSerialNumber({ issuer: signerCert.issuer, serialNumber: signerCert.serialNumber }),
    digestAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID.sha256 }),
    signedAttrs: new pkijs.SignedAndUnsignedAttributes({ type: 0, attributes: sortedAttrs }),
    signatureAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID.sha256WithRSA, algorithmParams: new asn1js.Null() }),
    signature: new asn1js.OctetString({ valueHex: toAB(signature) }),
  });

  if (opts.tsaUrl) {
    const token = await requestTimestampToken(opts.tsaUrl, sha256(signature), opts.tsaAuthHeader);
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
export async function requestTimestampToken(url: string, digest: Uint8Array, authHeader?: string | null) {
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
  return new Uint8Array(resp.timeStampToken.toSchema().toBER(false));
}
