import { execFileSync } from "node:child_process";
import { createHash, verify as cryptoVerify, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import forge from "node-forge";
import {
  CertsignClient,
  apiHostTrusted,
  assertSignedAttributes,
  assertPreparedMatchesDocument,
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

describe("servidores de confianza", () => {
  it("confía en calasign.com, sus subdominios, la máquina local y los declarados", () => {
    expect(apiHostTrusted("https://dev.calasign.com", [])).toBe(true);
    expect(apiHostTrusted("https://calasign.com", [])).toBe(true);
    expect(apiHostTrusted("http://127.0.0.1:4118", [])).toBe(true);
    expect(apiHostTrusted("https://calasign.com.evil.example", [])).toBe(false);
    expect(apiHostTrusted("https://evilcalasign.com", [])).toBe(false);
    expect(apiHostTrusted("https://firmas.cliente.com", [])).toBe(false);
    expect(apiHostTrusted("https://firmas.cliente.com", ["firmas.cliente.com"])).toBe(true);
    expect(apiHostTrusted("https://a.cliente.com", ["*.cliente.com"])).toBe(true);
    expect(apiHostTrusted("https://cliente.com", ["*.cliente.com"])).toBe(false);
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

describe("vínculo con el documento (assertPreparedMatchesDocument)", () => {
  const A = forge.asn1;
  const sha = (b: Buffer) => createHash("sha256").update(b).digest();
  const attrsWithDigest = (digest: Buffer) => {
    const attr = (oid: string, value: forge.asn1.Asn1) =>
      A.create(A.Class.UNIVERSAL, A.Type.SEQUENCE, true, [A.create(A.Class.UNIVERSAL, A.Type.OID, false, A.oidToDer(oid).getBytes()), A.create(A.Class.UNIVERSAL, A.Type.SET, true, [value])]);
    const ct = attr("1.2.840.113549.1.9.3", A.create(A.Class.UNIVERSAL, A.Type.OID, false, A.oidToDer("1.2.840.113549.1.7.1").getBytes()));
    const md = attr("1.2.840.113549.1.9.4", A.create(A.Class.UNIVERSAL, A.Type.OCTETSTRING, false, digest.toString("binary")));
    return new Uint8Array(Buffer.from(A.toDer(A.create(A.Class.UNIVERSAL, A.Type.SET, true, [ct, md])).getBytes(), "binary"));
  };
  // Igual que prepareExternalSignature: revisión incremental agregada con ByteRange real y /Contents reservado.
  const working = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1");
  function prepare(base: Buffer) {
    const placeholder = "[0 0000000000 0000000000 0000000000]";
    const head = Buffer.concat([base, Buffer.from(`2 0 obj\n<< /Type /Sig /ByteRange ${placeholder} /Contents `, "latin1")]);
    const b = head.length;
    const hole = Buffer.from(`<${"0".repeat(64)}>`, "latin1");
    const after = Buffer.from(" >>\nendobj\n%%EOF", "latin1");
    const c = b + hole.length;
    const d = after.length;
    const br = `[0 ${String(b).padStart(10, "0")} ${String(c).padStart(10, "0")} ${String(d).padStart(10, "0")}]`;
    const headFixed = Buffer.from(head.toString("latin1").replace(placeholder, br), "latin1");
    const pdf = Buffer.concat([headFixed, hole, after]);
    const covered = sha(Buffer.concat([pdf.subarray(0, b), pdf.subarray(c, c + d)]));
    return { pdf, covered };
  }
  const announced = createHash("sha256").update(working).digest("hex");

  it("acepta cuando el documento, el ByteRange y el messageDigest coinciden", () => {
    const { pdf, covered } = prepare(working);
    expect(() => assertPreparedMatchesDocument({ announcedSha256: announced, workingPdf: working, preparedPdf: pdf, signedAttrsDer: attrsWithDigest(covered) })).not.toThrow();
  });
  it("rechaza un messageDigest que no corresponde al documento", () => {
    const { pdf } = prepare(working);
    expect(() =>
      assertPreparedMatchesDocument({ announcedSha256: announced, workingPdf: working, preparedPdf: pdf, signedAttrsDer: attrsWithDigest(sha(Buffer.from("otro documento"))) }),
    ).toThrow(/no corresponden al documento/);
  });
  it("rechaza un PDF preparado sobre otro documento", () => {
    const otro = Buffer.from(working.toString("latin1").replace("Catalog", "Catalgo"), "latin1");
    const { pdf, covered } = prepare(otro);
    expect(() => assertPreparedMatchesDocument({ announcedSha256: announced, workingPdf: working, preparedPdf: pdf, signedAttrsDer: attrsWithDigest(covered) })).toThrow(
      /no conserva intacto/,
    );
  });
  it("rechaza un documento descargado distinto del anunciado", () => {
    const { pdf, covered } = prepare(working);
    expect(() =>
      assertPreparedMatchesDocument({ announcedSha256: "0".repeat(64), workingPdf: working, preparedPdf: pdf, signedAttrsDer: attrsWithDigest(covered) }),
    ).toThrow(/no es el que anunció/);
  });
  it("rechaza un ByteRange que deja bytes sin cubrir", () => {
    const { pdf, covered } = prepare(working);
    const extra = Buffer.concat([pdf, Buffer.from("\n% bytes agregados fuera del ByteRange", "latin1")]);
    expect(() => assertPreparedMatchesDocument({ announcedSha256: announced, workingPdf: working, preparedPdf: extra, signedAttrsDer: attrsWithDigest(covered) })).toThrow(
      /no cubre el documento completo/,
    );
  });
});

describe("la revisión preparada solo agrega la firma (assertOnlySignatureAdded)", async () => {
  const { PDFDocument, StandardFonts, PDFName } = await import("pdf-lib");
  const pdfmod = await import("@calasign/pdf");
  const { assertOnlySignatureAdded } = await import("../src");
  const ca = await pdfmod.generateDevRootCa("Firmador Test Root");
  const seal = await pdfmod.issueSealCertificate(ca, { commonName: "Titular de prueba" });
  const chain = pdfmod.pemToDerList(seal.chainPem);

  async function base() {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([595, 842]).drawText("Monto a pagar: 100", { x: 50, y: 780, size: 14, font });
    return doc.save({ useObjectStreams: false });
  }
  const prep = async (pdf: Uint8Array) =>
    (await pdfmod.prepareExternalSignature(pdf, chain, { fieldName: "FirmaCertificado1", reason: "Prueba", name: "Titular", location: "CalaSign" })).preparedPdf;

  it("acepta la preparación legítima (firma + widget invisible enganchados)", async () => {
    const working = await base();
    await expect(assertOnlySignatureAdded(working, await prep(working))).resolves.toBeUndefined();
  });

  it("rechaza una revisión que además cambia el contenido de la página", async () => {
    const working = await base();
    const u = await pdfmod.IncrementalUpdate.open(working);
    const page = u.doc.getPages()[0];
    const stream = u.context.flateStream("BT /F1 14 Tf 50 780 Td (Monto a pagar: 999999) Tj ET");
    page.node.set(PDFName.of("Contents"), u.add(stream));
    u.touch(page.ref);
    await expect(assertOnlySignatureAdded(working, await prep(u.serialize()))).rejects.toThrow(/No se firma/);
  });

  // Variantes que pdf-lib leería igual (ignora la tabla xref) pero un lector de PDF mostraría distinto.
  const lastStartxref = (b: Buffer) => Number([...b.toString("latin1").matchAll(/startxref\s+(\d+)/g)].pop()![1]);
  const rootOf = (b: Buffer) => [...b.toString("latin1").matchAll(/\/Root (\d+ \d+ R)/g)].pop()![1];
  function appendRevision(prepared: Buffer, xrefBody: string) {
    const off = prepared.length + 1;
    return Buffer.concat([
      prepared,
      Buffer.from(`\nxref\n${xrefBody}trailer\n<< /Size 99 /Root ${rootOf(prepared)} /Prev ${lastStartxref(prepared)} >>\nstartxref\n${off}\n%%EOF\n`, "latin1"),
    ]);
  }

  it("rechaza una revisión que libera un objeto del documento en la tabla xref", async () => {
    const working = await base();
    const prepared = Buffer.from(await prep(working));
    const bad = appendRevision(prepared, "0 1\n0000000000 65535 f\r\n4 1\n0000000000 00001 f\r\n");
    await expect(assertOnlySignatureAdded(working, bad)).rejects.toThrow(/libera objetos/);
  });

  it("rechaza una revisión que redirige un objeto a otros bytes del documento", async () => {
    const working = await base();
    const prepared = Buffer.from(await prep(working));
    const bad = appendRevision(prepared, "4 1\n0000000009 00000 n\r\n");
    await expect(assertOnlySignatureAdded(working, bad)).rejects.toThrow(/redirige objetos/);
  });

  it("rechaza una revisión que salta la última revisión del documento mostrado (/Prev)", async () => {
    const original = await base();
    const u = await pdfmod.IncrementalUpdate.open(original);
    u.touch(u.doc.getPages()[0].ref);
    const working = await u.serialize();
    const firstXref = lastStartxref(Buffer.from(original));
    const prepared = Buffer.from(await prep(working)).toString("latin1");
    const tamperedTail = prepared.slice(working.length).replace(/\/Prev \d+/, `/Prev ${firstXref}`);
    const bad = Buffer.from(prepared.slice(0, working.length) + tamperedTail, "latin1");
    await expect(assertOnlySignatureAdded(working, bad)).rejects.toThrow(/no encadena/);
  });

  it("rechaza una revisión cuya tabla xref apunta a una copia alterada que pdf-lib no ve (la tapa otra copia idéntica)", async () => {
    const working = await base();
    const prepared = Buffer.from(await prep(working));
    const doc = await PDFDocument.load(working);
    // Contents: "N 0 R" o "[ N 0 R ]".
    const [, num, gen] = /(\d+) (\d+) R/.exec(doc.getPages()[0].node.get(PDFName.of("Contents"))!.toString())!;
    const w = Buffer.from(working).toString("latin1");
    const start = w.search(new RegExp(`(^|\\n)${num} ${gen} obj`)) + (w.startsWith(`${num} ${gen} obj`) ? 0 : 1);
    const original = w.slice(start, w.indexOf("endobj", start) + "endobj".length);
    const body = "BT /F1 14 Tf 50 780 Td (Monto a pagar: 999999) Tj ET";
    const tampered = `${num} ${gen} obj\n<< /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj`;
    const tamperedAt = prepared.length + 1;
    const extra = `\n${tampered}\n${original}\n`;
    const xrefAt = prepared.length + extra.length;
    const bad = Buffer.concat([
      prepared,
      Buffer.from(
        `${extra}xref\n0 1\n0000000000 65535 f\r\n${num} 1\n${String(tamperedAt).padStart(10, "0")} ${gen.padStart(5, "0")} n\r\n` +
          `trailer\n<< /Size 99 /Root ${rootOf(prepared)} /Prev ${lastStartxref(prepared)} >>\nstartxref\n${xrefAt}\n%%EOF\n`,
        "latin1",
      ),
    ]);
    await expect(assertOnlySignatureAdded(working, bad)).rejects.toThrow(/No se firma/);
  });

  it("rechaza un widget con acciones o un diccionario de firma con /Reference", async () => {
    const working = await base();
    const prepared = Buffer.from(await prep(working)).toString("latin1");
    const tail = prepared.slice(working.length);
    const withAA = tail.replace("/F 132", "/F 132 /AA << /PO << /S /JavaScript /JS (x) >> >>");
    expect(withAA).not.toBe(tail);
    await expect(assertOnlySignatureAdded(working, Buffer.from(prepared.slice(0, working.length) + withAA, "latin1"))).rejects.toThrow(/No se firma/);
    const withRef = tail.replace("/Filter /Adobe.PPKLite", "/Filter /Adobe.PPKLite /Reference [ << /TransformMethod /DocMDP >> ]");
    expect(withRef).not.toBe(tail);
    await expect(assertOnlySignatureAdded(working, Buffer.from(prepared.slice(0, working.length) + withRef, "latin1"))).rejects.toThrow(/No se firma/);
  });

  it("rechaza una revisión que cambia la raíz del documento", async () => {
    const working = await base();
    const prepared = Buffer.from(await prep(working)).toString("latin1");
    const tail = prepared.slice(working.length);
    const sigNum = /(\d+) 0 obj\s*<<\s*\/Type \/Sig/.exec(tail)![1];
    const bad = prepared.slice(0, working.length) + tail.replace(/\/Root \d+ 0 R/, `/Root ${sigNum} 0 R`);
    await expect(assertOnlySignatureAdded(working, Buffer.from(bad, "latin1"))).rejects.toThrow(/raíz|No se firma/);
  });

  it("rechaza una revisión que agrega otra anotación visible", async () => {
    const working = await base();
    const u = await pdfmod.IncrementalUpdate.open(working);
    const page = u.doc.getPages()[0];
    const note = u.add(u.context.obj({ Type: "Annot", Subtype: "FreeText", Rect: [40, 770, 300, 800], Contents: "Monto: 999999" }));
    page.node.set(PDFName.of("Annots"), u.context.obj([note]));
    u.touch(page.ref);
    await expect(assertOnlySignatureAdded(working, await prep(u.serialize()))).rejects.toThrow(/No se firma/);
  });
});
