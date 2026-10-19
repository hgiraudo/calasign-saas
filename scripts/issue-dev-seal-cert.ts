// Emite el certificado del sello de plataforma para una clave de KMS y lo publica en SSM.
// La CA raíz de desarrollo vive solo en var/dev-ca/ de la máquina del operador (no se sube a ningún lado).
//
// Uso (con credenciales de la cuenta del entorno):
//   tsx scripts/issue-dev-seal-cert.ts <kms-key-arn> <ssm-parameter-name> [commonName]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KMSClient, GetPublicKeyCommand } from "@aws-sdk/client-kms";
import { SSMClient, PutParameterCommand } from "@aws-sdk/client-ssm";
import { generateDevRootCa, issueSealCertificate, type DevCa } from "@calasign/pdf";

const [keyArn, paramName, cn = "CalaSign Sello de Plataforma (dev)"] = process.argv.slice(2);
if (!keyArn || !paramName) {
  console.error("uso: issue-dev-seal-cert.ts <kms-key-arn> <ssm-parameter-name> [commonName]");
  process.exit(1);
}
const region = keyArn.split(":")[3];
// fileURLToPath y no .pathname: con espacios o tildes en la ruta del repo, .pathname queda con %20/%C3%A1 y la CA
// se creaba (y se buscaba) en otra carpeta.
const caDir = fileURLToPath(new URL("../var/dev-ca/", import.meta.url));
mkdirSync(caDir, { recursive: true });

let ca: DevCa;
if (existsSync(caDir + "root.key.pem")) {
  ca = { certPem: readFileSync(caDir + "root.cert.pem", "utf8"), keyPem: readFileSync(caDir + "root.key.pem", "utf8") };
} else {
  ca = await generateDevRootCa("CalaSign Dev Root CA");
  writeFileSync(caDir + "root.cert.pem", ca.certPem);
  writeFileSync(caDir + "root.key.pem", ca.keyPem, { mode: 0o600 });
  console.log(`CA raíz de desarrollo creada en ${caDir}`);
}

const pub = await new KMSClient({ region }).send(new GetPublicKeyCommand({ KeyId: keyArn }));
const seal = await issueSealCertificate(ca, { commonName: cn, subjectPublicKeySpki: pub.PublicKey!, years: 2 });
writeFileSync(caDir + "seal.chain.pem", seal.chainPem);
await new SSMClient({ region }).send(
  new PutParameterCommand({ Name: paramName, Value: seal.chainPem, Type: "String", Tier: "Advanced", Overwrite: true }),
);
console.log(`certificado del sello emitido para ${keyArn} y publicado en ${paramName}`);
