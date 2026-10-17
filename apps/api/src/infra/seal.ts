// Origen del sello de plataforma: KMS (entornos en la nube) o clave PEM local (desarrollo).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { LocalKeyProvider, generateDevRootCa, issueSealCertificate, pemToDerList, type SignatureProvider } from "@calasign/pdf";
import { config } from "../config";

class KmsSignatureProvider implements SignatureProvider {
  readonly id = "platform-seal-kms";
  readonly level = "simple" as const;
  private clientP = import("@aws-sdk/client-kms").then((m) => ({ m, c: new m.KMSClient({ region: config.storage.region }) }));
  constructor(
    private keyId: string,
    private chain: Uint8Array[],
  ) {}
  async certificateChain() {
    return this.chain;
  }
  async signDigest(digest: Uint8Array) {
    const { m, c } = await this.clientP;
    const r = await c.send(
      new m.SignCommand({ KeyId: this.keyId, Message: digest, MessageType: "DIGEST", SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256" }),
    );
    return new Uint8Array(r.Signature!);
  }
}

let cached: SignatureProvider | null = null;

export async function getSealProvider(): Promise<SignatureProvider> {
  if (cached) return cached;
  const { kmsKeyId, keyPemFile, chainPemFile } = config.seal;
  if (kmsKeyId) {
    if (!chainPemFile) throw new Error("SEAL_CHAIN_FILE requerido con KMS_KEY_ID");
    cached = new KmsSignatureProvider(kmsKeyId, pemToDerList(readFileSync(chainPemFile, "utf8")));
    return cached;
  }
  if (keyPemFile && chainPemFile) {
    cached = new LocalKeyProvider("platform-seal", readFileSync(keyPemFile, "utf8"), readFileSync(chainPemFile, "utf8"));
    return cached;
  }
  if (config.production) throw new Error("Configurar KMS_KEY_ID o SEAL_KEY_FILE/SEAL_CHAIN_FILE en producción");
  // Desarrollo: CA raíz y sello autogenerados en var/keys.
  const dir = resolve(config.dataDir, "keys");
  mkdirSync(dir, { recursive: true });
  const keyFile = resolve(dir, "seal.key.pem");
  const chainFile = resolve(dir, "seal.chain.pem");
  if (!existsSync(keyFile) || !existsSync(chainFile)) {
    const ca = await generateDevRootCa("CalaSign Local Dev Root CA");
    const seal = await issueSealCertificate(ca, { commonName: "CalaSign Sello de Plataforma (local)" });
    writeFileSync(resolve(dir, "root-ca.cert.pem"), ca.certPem);
    writeFileSync(resolve(dir, "root-ca.key.pem"), ca.keyPem, { mode: 0o600 });
    writeFileSync(keyFile, seal.keyPem!, { mode: 0o600 });
    writeFileSync(chainFile, seal.chainPem);
  }
  cached = new LocalKeyProvider("platform-seal", readFileSync(keyFile, "utf8"), readFileSync(chainFile, "utf8"));
  return cached;
}
