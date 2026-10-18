import { execFileSync } from "node:child_process";
import { createHash, verify as cryptoVerify, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import forge from "node-forge";
import {
  CertsignClient,
  assertSignedAttributes,
  P12Source,
  WindowsStoreSource,
  linuxDesktopEntry,
  openP12,
  parseDeepLink,
  powershellArgs,
  signWithKey,
  startUi,
  windowsRegistryCommands,
  windowsSignScript,
} from "../src";

const hasOpenssl = (() => {
  try {
    execFileSync("openssl", ["version"]);
    return true;
  } catch {
    return false;
  }
})();

function makeP12(kind: "rsa" | "ec" | "rsa-legacy", withCa = false): { bytes: Uint8Array; leafPem: string } {
  const dir = mkdtempSync(join(tmpdir(), "firmador-"));
  const f = (n: string) => join(dir, n);
  const key = kind === "ec" ? ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256"] : ["-newkey", "rsa:2048"];
  if (withCa) {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", f("ca.key"), "-out", f("ca.crt"), "-subj", "/CN=Test CA", "-days", "2", "-addext", "basicConstraints=critical,CA:TRUE"], { stdio: "ignore" });
    execFileSync("openssl", ["req", ...key, "-nodes", "-keyout", f("leaf.key"), "-out", f("leaf.csr"), "-subj", "/CN=Titular/serialNumber=PNOPE-12345678"], { stdio: "ignore" });
    execFileSync("openssl", ["x509", "-req", "-in", f("leaf.csr"), "-CA", f("ca.crt"), "-CAkey", f("ca.key"), "-CAcreateserial", "-out", f("leaf.crt"), "-days", "2"], { stdio: "ignore" });
  } else {
    execFileSync("openssl", ["req", "-x509", ...key, "-nodes", "-keyout", f("leaf.key"), "-out", f("leaf.crt"), "-subj", "/CN=Titular", "-days", "2"], { stdio: "ignore" });
  }
  const args = ["pkcs12", "-export", ...(kind === "rsa-legacy" ? ["-legacy"] : []), "-inkey", f("leaf.key"), "-in", f("leaf.crt"), ...(withCa ? ["-certfile", f("ca.crt")] : []), "-out", f("c.p12"), "-passout", "pass:clave-secreta"];
  execFileSync("openssl", args, { stdio: "ignore" });
  return { bytes: new Uint8Array(readFileSync(f("c.p12"))), leafPem: readFileSync(f("leaf.crt"), "utf8") };
}

describe("deep link y cliente", () => {
  it("interpreta el link del navegador y los códigos sueltos", () => {
    expect(parseDeepLink("calasign-firmador://sign?api=https%3A%2F%2Fdev.calasign.com&code=ABCDE-FGHJK")).toEqual({ api: "https://dev.calasign.com", code: "ABCDE-FGHJK" });
    expect(parseDeepLink("abcde-fghjk")).toEqual({ api: null, code: "ABCDE-FGHJK" });
    expect(parseDeepLink("calasign-firmador://sign?api=javascript:alert(1)&code=X")).toBeNull();
    expect(parseDeepLink("hola")).toBeNull();
  });
  it("exige https (salvo localhost)", () => {
    expect(() => new CertsignClient("http://evil.example", "ABCDE-FGHJK")).toThrow(/https/);
    expect(() => new CertsignClient("http://localhost:4000", "ABCDE-FGHJK")).not.toThrow();
  });
});

describe("solo firma atributos de CMS", () => {
  const A = forge.asn1;
  const attr = (oid: string, value: forge.asn1.Asn1) => A.create(A.Class.UNIVERSAL, A.Type.SEQUENCE, true, [A.create(A.Class.UNIVERSAL, A.Type.OID, false, A.oidToDer(oid).getBytes()), A.create(A.Class.UNIVERSAL, A.Type.SET, true, [value])]);
  const pack = (attrs: forge.asn1.Asn1[]) => {
    const der = Buffer.from(A.toDer(A.create(A.Class.UNIVERSAL, A.Type.SET, true, attrs)).getBytes(), "binary");
    return { dataToSign: der.toString("base64"), digestToSign: createHash("sha256").update(der).digest("base64") };
  };
  const ct = attr("1.2.840.113549.1.9.3", A.create(A.Class.UNIVERSAL, A.Type.OID, false, A.oidToDer("1.2.840.113549.1.7.1").getBytes()));
  const md = attr("1.2.840.113549.1.9.4", A.create(A.Class.UNIVERSAL, A.Type.OCTETSTRING, false, "x".repeat(32)));
  it("acepta contentType + messageDigest", () => {
    expect(() => assertSignedAttributes(pack([ct, md]))).not.toThrow();
  });
  it("rechaza hashes arbitrarios, atributos desconocidos o un hash que no corresponde", () => {
    const random = Buffer.from("cualquier cosa que no es CMS");
    expect(() => assertSignedAttributes({ dataToSign: random.toString("base64"), digestToSign: createHash("sha256").update(random).digest("base64") })).toThrow();
    expect(() => assertSignedAttributes(pack([ct]))).toThrow(/obligatorios/);
    expect(() => assertSignedAttributes(pack([ct, md, attr("1.2.3.4", A.create(A.Class.UNIVERSAL, A.Type.NULL, false, ""))]))).toThrow(/no esperado/);
    expect(() => assertSignedAttributes({ ...pack([ct, md]), digestToSign: Buffer.alloc(32).toString("base64") })).toThrow(/no corresponde/);
  });
});

describe("almacén de Windows (PowerShell)", () => {
  it("arma el script de firma validando thumbprint y hash, codificado en UTF-16LE", () => {
    const digest = createHash("sha256").update("x").digest("base64");
    const script = windowsSignScript("a".repeat(40), digest);
    expect(script).toContain("Cert:\\CurrentUser\\My\\" + "A".repeat(40));
    expect(script).toContain("RSASignaturePadding]::Pkcs1");
    expect(script).toContain("GetECDsaPrivateKey");
    expect(() => windowsSignScript("x'; Remove-Item C:\\ -Recurse #", digest)).toThrow(/thumbprint/);
    expect(() => windowsSignScript("a".repeat(40), "no-base64'")).toThrow(/hash/);
    const args = powershellArgs(script);
    expect(args.slice(0, 5)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
    expect(Buffer.from(args[5], "base64").toString("utf16le")).toBe(script);
  });
  it("lista y firma a través del runner (simulado fuera de Windows)", async () => {
    const der = Buffer.from("MIIB").toString("base64");
    const calls: string[] = [];
    const src = new WindowsStoreSource(async (s) => {
      calls.push(s);
      return s.includes("Get-ChildItem")
        ? JSON.stringify([{ thumbprint: "B".repeat(40), subject: "CN=Juan Perez, SERIALNUMBER=PNOPE-12345678", issuer: "CN=RENIEC", notAfter: "2030-01-01T00:00:00Z", friendly: "", chain: [der] }])
        : Buffer.from([1, 2, 3]).toString("base64");
    });
    const [c] = await src.list();
    expect(c.label).toBe("Juan Perez");
    const sig = await src.sign(c, { data: new Uint8Array(), digest: new Uint8Array(32), algorithm: "RSASSA-PKCS1-v1_5" });
    expect([...sig]).toEqual([1, 2, 3]);
    expect(calls[1]).toContain("B".repeat(40));
  });
});

describe.skipIf(!hasOpenssl)("archivo .p12", () => {
  for (const kind of ["rsa", "rsa-legacy", "ec"] as const) {
    it(`${kind}: abre, firma los datos y la firma verifica con el certificado`, () => {
      const { bytes, leafPem } = makeP12(kind);
      const { key, chainDer } = openP12(bytes, "clave-secreta");
      expect(new X509Certificate(Buffer.from(chainDer[0])).toString().trim()).toBe(new X509Certificate(leafPem).toString().trim());
      const data = new Uint8Array(Buffer.from("atributos firmados"));
      const sig = signWithKey(key, { data, digest: createHash("sha256").update(data).digest(), algorithm: kind === "ec" ? "ECDSA" : "RSASSA-PKCS1-v1_5" });
      const pub = new X509Certificate(Buffer.from(chainDer[0])).publicKey;
      expect(cryptoVerify("sha256", Buffer.from(data), kind === "ec" ? { key: pub, dsaEncoding: "der" } : pub, Buffer.from(sig))).toBe(true);
    });
  }
  it("ordena la cadena (titular primero) y rechaza una contraseña incorrecta", async () => {
    const { bytes } = makeP12("rsa", true);
    const src = P12Source.fromBytes(bytes, "clave-secreta");
    const [entry] = await src.list();
    expect(entry.chainDer.length).toBe(2);
    expect(new X509Certificate(Buffer.from(entry.chainDer[0])).subject).toMatch(/Titular/);
    expect(() => openP12(bytes, "otra")).toThrow(/Contraseña incorrecta|abrir/);
  });
});

describe("registro del esquema", () => {
  it("genera el .desktop de Linux y los reg add de Windows", () => {
    expect(linuxDesktopEntry("/opt/calasign/firmador")).toContain("MimeType=x-scheme-handler/calasign-firmador;");
    expect(linuxDesktopEntry("/opt/calasign/firmador")).toContain('Exec="/opt/calasign/firmador" %u');
    const reg = windowsRegistryCommands("C:\\Firmador\\calasign-firmador.exe");
    expect(reg[0][1]).toBe("HKCU\\Software\\Classes\\calasign-firmador");
    expect(reg[2]).toContain('"C:\\Firmador\\calasign-firmador.exe" "%1"');
  });
});

describe("interfaz local", () => {
  it("solo responde en su ruta secreta, con Host 127.0.0.1 y JSON", async () => {
    const ui = await startUi({ api: "https://dev.calasign.com", code: "ABCDE-FGHJK" }, false);
    try {
      const page = await fetch(ui.url);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("ABCDE-FGHJK");
      expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect((await fetch(ui.url.replace(/\/[^/]+$/, "/otro"))).status).toBe(404);
      expect((await fetch(`${ui.url}/info`, { method: "POST", body: "code=x" })).status).toBe(405);
      const port = new URL(ui.url).port;
      const rebinding = await fetch(ui.url.replace("127.0.0.1", "localhost"));
      expect(rebinding.status).toBe(403);
      expect(port).toBeTruthy();
    } finally {
      await ui.close();
    }
  });
});
