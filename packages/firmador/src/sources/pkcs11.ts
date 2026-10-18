// Token o tarjeta criptográfica vía PKCS#11 (pkcs11js). La firma la hace el token: la clave nunca sale.
// RSA: CKM_RSA_PKCS sobre DigestInfo(SHA-256). EC: CKM_ECDSA sobre el hash (devuelve r||s).
import { X509Certificate } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { CertEntry, CertSource, ToSign } from "../types";

/** Rutas habituales de los módulos PKCS#11 de los tokens más comunes en la región. */
export const KNOWN_PKCS11_MODULES: Record<"win32" | "darwin" | "linux", { vendor: string; path: string }[]> = {
  win32: [
    { vendor: "SafeNet eToken / Thales", path: "C:\\Windows\\System32\\eTPKCS11.dll" },
    { vendor: "SafeNet Authentication Client", path: "C:\\Windows\\System32\\IDPrimePKCS11.dll" },
    { vendor: "Feitian ePass2003", path: "C:\\Windows\\System32\\eps2003csp11.dll" },
    { vendor: "Bit4id", path: "C:\\Windows\\System32\\bit4ipki.dll" },
    { vendor: "Watchdata (ICP-Brasil)", path: "C:\\Windows\\System32\\WDPKCS.dll" },
    { vendor: "OpenSC", path: "C:\\Program Files\\OpenSC Project\\OpenSC\\pkcs11\\opensc-pkcs11.dll" },
  ],
  darwin: [
    { vendor: "SafeNet eToken / Thales", path: "/usr/local/lib/libeTPkcs11.dylib" },
    { vendor: "Feitian ePass2003", path: "/usr/local/lib/libcastle.1.0.0.dylib" },
    { vendor: "Bit4id", path: "/usr/local/lib/libbit4ipki.dylib" },
    { vendor: "OpenSC", path: "/Library/OpenSC/lib/opensc-pkcs11.so" },
  ],
  linux: [
    { vendor: "SafeNet eToken / Thales", path: "/usr/lib/libeTPkcs11.so" },
    { vendor: "Feitian ePass2003", path: "/usr/lib/libcastle.so.1.0.0" },
    { vendor: "Bit4id", path: "/usr/lib/bit4id/libbit4ipki.so" },
    { vendor: "OpenSC", path: "/usr/lib/x86_64-linux-gnu/opensc-pkcs11.so" },
    { vendor: "SoftHSM (pruebas)", path: "/usr/lib/softhsm/libsofthsm2.so" },
  ],
};

export function detectPkcs11Modules(platform: NodeJS.Platform = process.platform): { vendor: string; path: string }[] {
  const list = KNOWN_PKCS11_MODULES[(platform === "win32" || platform === "darwin" ? platform : "linux") as "win32" | "darwin" | "linux"];
  return list.filter((m) => existsSync(m.path));
}

// DigestInfo DER de SHA-256 (RFC 8017 §9.2).
const SHA256_DIGEST_INFO = Buffer.from("3031300d060960864801650304020105000420", "hex");

/** Carga pkcs11js: del node_modules del paquete o, en el binario autocontenido, de la carpeta del ejecutable. */
function loadPkcs11js(): any {
  const tries = [import.meta.url, join(dirname(process.execPath), "noop.js")];
  for (const base of tries) {
    try {
      return createRequire(base)("pkcs11js");
    } catch {
      // siguiente
    }
  }
  throw new Error("Falta el componente PKCS#11 (pkcs11js). Reinstalá el Firmador o usá el almacén de Windows / un archivo .p12.");
}

export class Pkcs11Source implements CertSource {
  readonly kind = "pkcs11" as const;
  private lib: any;
  private mod: any;
  private session: any = null;

  constructor(
    readonly modulePath: string,
    private readonly pin: string,
    private readonly slotIndex = 0,
  ) {
    this.mod = loadPkcs11js();
    this.lib = new this.mod.PKCS11();
    this.lib.load(modulePath);
    this.lib.C_Initialize();
  }

  private open() {
    if (this.session) return this.session;
    const slots = this.lib.C_GetSlotList(true);
    if (!slots.length) throw new Error("No hay ningún token conectado");
    const slot = slots[Math.min(this.slotIndex, slots.length - 1)];
    this.session = this.lib.C_OpenSession(slot, this.mod.CKF_SERIAL_SESSION | this.mod.CKF_RW_SESSION);
    try {
      this.lib.C_Login(this.session, this.mod.CKU_USER, this.pin);
    } catch (e) {
      if (!/ALREADY_LOGGED_IN/.test(String(e))) throw new Error(/PIN_INCORRECT|PIN_LEN|PIN_INVALID/.test(String(e)) ? "PIN incorrecto" : `No se pudo abrir el token: ${(e as Error).message}`);
    }
    return this.session;
  }

  private find(template: { type: number; value: unknown }[]): any[] {
    const s = this.open();
    this.lib.C_FindObjectsInit(s, template);
    const out: any[] = [];
    for (let h = this.lib.C_FindObjects(s); h; h = this.lib.C_FindObjects(s)) out.push(h);
    this.lib.C_FindObjectsFinal(s);
    return out;
  }

  async list(): Promise<CertEntry[]> {
    const m = this.mod;
    const certs = this.find([{ type: m.CKA_CLASS, value: m.CKO_CERTIFICATE }]).map((h) => {
      const [value, id, label] = this.lib.C_GetAttributeValue(this.open(), h, [{ type: m.CKA_VALUE }, { type: m.CKA_ID }, { type: m.CKA_LABEL }]);
      return { der: new Uint8Array(value.value as Buffer), id: Buffer.from((id.value as Buffer) ?? []).toString("hex"), label: String(label.value ?? "") };
    });
    const withKey = new Set(
      this.find([{ type: m.CKA_CLASS, value: m.CKO_PRIVATE_KEY }]).map((h) => Buffer.from((this.lib.C_GetAttributeValue(this.open(), h, [{ type: m.CKA_ID }])[0].value as Buffer) ?? []).toString("hex")),
    );
    const parsed = certs.map((c) => ({ ...c, x: new X509Certificate(Buffer.from(c.der)) }));
    return parsed
      .filter((c) => withKey.has(c.id) && !c.x.ca)
      .map((c) => {
        // Cadena con los certificados de CA que traiga el token.
        const chain = [c.der];
        let cur = c.x;
        for (let i = 0; i < 6; i++) {
          const up = parsed.find((p) => p.x.ca && cur.checkIssued(p.x) && p.x.subject !== cur.subject);
          if (!up) break;
          chain.push(up.der);
          cur = up.x;
        }
        return { id: c.id, label: c.label || c.x.subject.split("\n").find((l) => l.startsWith("CN="))?.slice(3) || c.id, subject: c.x.subject.replace(/\n/g, ", "), issuer: c.x.issuer.replace(/\n/g, ", "), notAfter: new Date(c.x.validTo).toISOString(), chainDer: chain };
      });
  }

  async sign(entry: CertEntry, x: ToSign): Promise<Uint8Array> {
    const m = this.mod;
    const [key] = this.find([
      { type: m.CKA_CLASS, value: m.CKO_PRIVATE_KEY },
      { type: m.CKA_ID, value: Buffer.from(entry.id, "hex") },
    ]);
    if (!key) throw new Error("El token no tiene la clave de ese certificado");
    const s = this.open();
    if (x.algorithm === "ECDSA") {
      this.lib.C_SignInit(s, { mechanism: m.CKM_ECDSA }, key);
      return new Uint8Array(this.lib.C_Sign(s, Buffer.from(x.digest), Buffer.alloc(256)));
    }
    this.lib.C_SignInit(s, { mechanism: m.CKM_RSA_PKCS }, key);
    return new Uint8Array(this.lib.C_Sign(s, Buffer.concat([SHA256_DIGEST_INFO, Buffer.from(x.digest)]), Buffer.alloc(1024)));
  }

  async close() {
    try {
      if (this.session) {
        this.lib.C_Logout(this.session);
        this.lib.C_CloseSession(this.session);
      }
    } catch {
      // ya cerrado
    }
    this.lib.C_Finalize();
  }
}
