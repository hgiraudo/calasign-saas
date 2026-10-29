#!/usr/bin/env tsx
// PKI de laboratorio para desarrollo local de B-LT/B-LTA, sello de empresa y conectores CSC.
// Levanta OCSP/CRL/TSA y un CSC v2 de prueba, y escribe en var/dev-pki/ todo lo necesario.
//
//   tsx scripts/dev-pki.mts [--port 4290] [--dir var/dev-pki]
//
// Después arrancar la API con las variables que imprime (o `set -a; . var/dev-pki/api.env; set +a`).
// NO usar en producción.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { startLab } from "@calasign/pdf/lab";
import { startMockCsc } from "@calasign/pdf/csc-mock";

const args = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const port = Number(arg("port", "4290"));
const dir = resolve(arg("dir", "var/dev-pki"));
mkdirSync(resolve(dir, "trust"), { recursive: true });

const { pki, server } = await startLab(port);
const company = await pki.issue("Empresa Demo S.A. (sello de empresa)");
const holder = await pki.issue("Firmante CSC Demo");
const csc = await startMockCsc(
  {
    username: "demo",
    password: "demo-pass",
    pin: "123456",
    credentials: { "cred-demo": { identity: holder, chainDer: [holder.certDer, pki.intermediate.certDer, pki.root.certDer] } },
  },
  port + 1,
);

const w = (name: string, data: string | Uint8Array, mode = 0o644) => writeFileSync(resolve(dir, name), data, { mode });
w("seal.key.pem", pki.seal.keyPem, 0o600);
w("seal.chain.pem", pki.sealChainPem);
w("trust/lab-root.pem", pki.root.certPem);
w("root.pem", pki.root.certPem);
w("company.key.pem", company.keyPem, 0o600);
w("company.cert.pem", company.certPem);
w("chain.pem", pki.intermediate.certPem + pki.root.certPem);

// .p12 moderno (AES/PBKDF2/SHA-256) y legado (3DES/SHA-1), como los que entregan las CA.
const P12_PASSWORD = "demo1234";
for (const [file, extra] of [
  ["company.p12", []],
  ["company-legacy.p12", ["-legacy"]],
] as const) {
  try {
    execFileSync("openssl", [
      "pkcs12",
      "-export",
      ...extra,
      "-inkey",
      resolve(dir, "company.key.pem"),
      "-in",
      resolve(dir, "company.cert.pem"),
      "-certfile",
      resolve(dir, "chain.pem"),
      "-passout",
      `pass:${P12_PASSWORD}`,
      "-out",
      resolve(dir, file),
    ]);
  } catch (e) {
    console.warn(`no se pudo generar ${file}: ${(e as Error).message}`);
  }
}
w("company.p12.password", P12_PASSWORD);

const cscConnectors = [
  {
    id: "csc-demo",
    baseUrl: csc.url,
    auth: { type: "basic", username: "demo", password: "demo-pass" },
    credentialId: "cred-demo",
    pin: "123456",
    level: "qualified",
  },
];
const env = [
  `SEAL_KEY_FILE=${resolve(dir, "seal.key.pem")}`,
  `SEAL_CHAIN_FILE=${resolve(dir, "seal.chain.pem")}`,
  `TSA_URL=${server.url}/tsr`,
  `TRUST_STORE_DIR=${resolve(dir, "trust")}`,
  `SEAL_LEVEL=B-LT`,
  `VALIDATE_ONLINE_REVOCATION=true`,
  `CSC_CONNECTORS='${JSON.stringify(cscConnectors)}'`,
].join("\n");
w("api.env", env + "\n");
console.log(`PKI de laboratorio en ${server.url} (OCSP/CRL/TSA), CSC de prueba en ${csc.url}`);
console.log(`Material en ${dir}. Variables para la API:\n${env}`);

const stop = async () => {
  await server.close();
  await csc.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
