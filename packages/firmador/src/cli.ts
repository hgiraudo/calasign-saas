#!/usr/bin/env node
// Firmador CalaSign — línea de comandos.
//
//   calasign-firmador                                   abre la interfaz en el navegador
//   calasign-firmador "calasign-firmador://sign?api=…&code=…"   ídem, con el código cargado (lo usa el link)
//   calasign-firmador sign --api URL --code CÓDIGO (--p12 ARCHIVO [--password-env VAR | --password X]
//                          | --pkcs11 MÓDULO --pin PIN [--slot N] | --windows) [--cert ID] [--trust-host]
//   calasign-firmador list (--p12 … | --pkcs11 … | --windows)
//   calasign-firmador register-protocol
//   calasign-firmador --version
import { readFileSync } from "node:fs";
import { CertsignClient, apiHost, apiHostTrusted, parseDeepLink, signWithEntry } from "./protocol";
import { registerProtocol } from "./register";
import { P12Source } from "./sources/p12";
import { Pkcs11Source } from "./sources/pkcs11";
import { WindowsStoreSource } from "./sources/windows";
import type { CertSource } from "./types";
import { VERSION, startUi } from "./ui";

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function sourceFrom(args: string[]): CertSource {
  const p12 = arg(args, "p12");
  if (p12) {
    const envName = arg(args, "password-env");
    const file = arg(args, "password-file");
    const password = envName
      ? (process.env[envName] ?? "")
      : file
        ? readFileSync(file, "utf8").trim()
        : (arg(args, "password") ?? process.env.CALASIGN_P12_PASSWORD ?? "");
    return new P12Source(p12, password);
  }
  const mod = arg(args, "pkcs11");
  if (mod) return new Pkcs11Source(mod, arg(args, "pin") ?? process.env.CALASIGN_TOKEN_PIN ?? "", Number(arg(args, "slot") ?? 0));
  if (args.includes("--windows")) return new WindowsStoreSource();
  throw new Error("Indicá la fuente del certificado: --p12, --pkcs11 o --windows");
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [cmd] = argv;
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return 0;
  }
  if (cmd === "register-protocol") {
    console.log(registerProtocol());
    return 0;
  }
  if (cmd === "list" || cmd === "sign") {
    const source = sourceFrom(argv);
    try {
      const certs = await source.list();
      if (cmd === "list") {
        for (const c of certs) console.log(`${c.id}\t${c.label}\t${c.subject}\t${c.notAfter}`);
        return 0;
      }
      const link = parseDeepLink(arg(argv, "code") ?? "") ?? { api: null, code: arg(argv, "code") ?? "" };
      const api = arg(argv, "api") ?? link.api;
      if (!api || !link.code) throw new Error("Faltan --api y --code");
      const entry = arg(argv, "cert") ? certs.find((c) => c.id === arg(argv, "cert")) : certs[0];
      if (!entry) throw new Error("No se encontró el certificado");
      if (!apiHostTrusted(api) && !argv.includes("--trust-host")) {
        throw new Error(`${apiHost(api)} no es un servidor de CalaSign conocido. Si confiás en él, repetí el comando con --trust-host.`);
      }
      const client = new CertsignClient(api, link.code);
      const info = await client.info();
      console.error(`Firmando "${info.envelopeSubject}" (${info.organizationName}) como ${info.signerName}…`);
      const { prepared, result } = await signWithEntry(client, source, entry);
      for (const w of prepared.warnings) console.error(`Aviso: ${w}`);
      console.log(
        JSON.stringify({
          ok: true,
          certificate: prepared.certificate.commonName,
          signedPdfSha256: result.signedPdfSha256,
          envelopeStatus: result.envelopeStatus,
        }),
      );
      return 0;
    } finally {
      await source.close?.();
    }
  }
  const link = cmd ? parseDeepLink(cmd) : null;
  const ui = await startUi({ api: link?.api ?? null, code: link?.code ?? null });
  console.log(`Firmador CalaSign abierto en ${ui.url}`);
  console.log("Cerrá esta ventana cuando termines.");
  return await new Promise<number>(() => {});
}

// Ejecución directa: `tsx src/cli.ts`, o el bundle / binario autocontenido (__CALASIGN_BUNDLE__ lo define esbuild).
declare const __CALASIGN_BUNDLE__: boolean | undefined;
const isBundle = typeof __CALASIGN_BUNDLE__ !== "undefined" && __CALASIGN_BUNDLE__;
const isMain = Boolean(process.argv[1]) && /cli\.ts$/.test(process.argv[1]);
if (isBundle || isMain) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`Error: ${(e as Error).message}`);
      process.exit(1);
    },
  );
}
