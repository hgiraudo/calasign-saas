// PKI de laboratorio para e2e-certsign: levanta OCSP/CRL/TSA, emite los certificados de los firmantes y los
// guarda como .p12 (con openssl) en el directorio indicado. Imprime "LAB_READY <url>" y queda sirviendo.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startLab } from "@calasign/pdf/lab";
import { parseCert, serialHex } from "@calasign/pdf";

const dir = process.argv[2];
if (!dir) throw new Error("uso: e2e-certsign-lab.mts <dir>");
mkdirSync(join(dir, "trust"), { recursive: true });
const { pki, server } = await startLab(0, "127.0.0.1");
writeFileSync(join(dir, "trust", "lab-root.pem"), pki.root.certPem);

async function p12(name: string, cn: string, opts: Parameters<typeof pki.issue>[1]) {
  const id = await pki.issue(cn, opts);
  writeFileSync(join(dir, `${name}.key`), id.keyPem);
  writeFileSync(join(dir, `${name}.crt`), id.certPem);
  writeFileSync(join(dir, `${name}.chain`), pki.intermediate.certPem + pki.root.certPem);
  execFileSync("openssl", [
    "pkcs12",
    "-export",
    "-inkey",
    join(dir, `${name}.key`),
    "-in",
    join(dir, `${name}.crt`),
    "-certfile",
    join(dir, `${name}.chain`),
    "-out",
    join(dir, `${name}.p12`),
    "-passout",
    "pass:clave-del-titular",
  ]);
  return id;
}

// Firmante 1 (Perú): DNI en serialNumber, RSA. Firmante 3 (Brasil): CPF en el otherName de ICP-Brasil, ECDSA P-256.
await p12("peru", "JUAN PEREZ", { serialNumber: "PNOPE-12345678" });
await p12("brasil", "MARIA DA SILVA:12345678909", { icpBrasilCpf: "12345678909", key: "ec-p256" });
// Certificado de otra persona (para probar que se rechaza).
await p12("otro", "OTRA PERSONA", { serialNumber: "PNOPE-99999999" });
// Mismo titular que "peru", pero revocado por la CA (OCSP y CRL lo informan): solo falla por la revocación.
pki.revoked.add(serialHex(parseCert((await p12("revocado", "JUAN PEREZ", { serialNumber: "PNOPE-12345678" })).certDer)));

console.log(`LAB_READY ${server.url}`);
process.on("SIGTERM", async () => {
  await server.close();
  process.exit(0);
});
