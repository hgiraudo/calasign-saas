// Custodia de certificados de organizaciones: el cifrado de la clave está atado a la organización y al certificado
// (contexto de KMS y AAD de AES-GCM, formato v2), las claves del formato anterior (v1) se siguen abriendo y se
// vuelven a cifrar en v2 al usarlas.
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-custody-"));

const TENANT_A = "0192f0e0-0000-7000-8000-0000000000a1";
const TENANT_B = "0192f0e0-0000-7000-8000-0000000000b2";
const CERT_1 = "0192f0e0-0000-7000-8000-0000000000c1";
const CERT_2 = "0192f0e0-0000-7000-8000-0000000000c2";
const OK_ARN = "arn:aws:kms:us-east-1:111122223333:key/mock-ok";

let custody: typeof import("../src/modules/custody");
let util: typeof import("../src/lib/util");
let kms: typeof import("../src/infra/kms");

beforeAll(async () => {
  kms = await import("../src/infra/kms");
  kms.setKmsClientFactory(() => kms.mockKms());
  custody = await import("../src/modules/custody");
  util = await import("../src/lib/util");
}, 120_000);

/** Clave en el formato anterior (v1): sin AAD y con la clave de datos envuelta sin contexto. */
function legacySeal(plain: string) {
  const dataKey = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", dataKey, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return {
    key_ciphertext: `v1.${iv.toString("base64url")}.${enc.toString("base64url")}.${c.getAuthTag().toString("base64url")}`,
    key_wrapped: util.encrypt(dataKey.toString("base64")),
    key_wrap_method: "local",
  };
}

describe("custodia: contexto de cifrado", () => {
  it("v2 local: abre con su organización y certificado, no con otros", async () => {
    const sealed = await custody.sealKey("CLAVE-PEM", { tenantId: TENANT_A, certificateId: CERT_1 });
    expect(sealed.ciphertext.startsWith("v2.")).toBe(true);
    const row = { id: CERT_1, tenant_id: TENANT_A, key_ciphertext: sealed.ciphertext, key_wrapped: sealed.wrapped, key_wrap_method: sealed.method };
    expect(await custody.openKey(row)).toBe("CLAVE-PEM");
    await expect(custody.openKey({ ...row, tenant_id: TENANT_B })).rejects.toThrow();
    await expect(custody.openKey({ ...row, id: CERT_2 })).rejects.toThrow();
    // Solo el texto cifrado copiado a otra fila (con la clave de datos de esa otra fila) tampoco abre: AAD distinto.
    const other = await custody.sealKey("OTRA", { tenantId: TENANT_A, certificateId: CERT_2 });
    await expect(custody.openKey({ ...row, key_wrapped: other.wrapped, id: CERT_2 })).rejects.toThrow();
  });

  it("v2 BYOK: contexto de KMS con propósito y organización (política recomendada); el certificado va en el AAD", async () => {
    const seen: Record<string, string>[] = [];
    const real = kms.mockKms();
    kms.setKmsClientFactory(() => ({
      ...real,
      encrypt: async (i: any) => (seen.push(i.EncryptionContext), real.encrypt(i)),
    }));
    try {
      const sealed = await custody.sealKey("CLAVE-BYOK", { tenantId: TENANT_A, certificateId: CERT_1 }, { tenantId: TENANT_A, keyArn: OK_ARN });
      expect(seen.at(-1)).toEqual({ purpose: "calasign-tenant-certificate", tenant: TENANT_A });
      const row = {
        id: CERT_1,
        tenant_id: TENANT_A,
        key_ciphertext: sealed.ciphertext,
        key_wrapped: sealed.wrapped,
        key_wrap_method: sealed.method,
        key_wrap_key_arn: OK_ARN,
      };
      expect(await custody.openKey(row)).toBe("CLAVE-BYOK");
      // Otro certificado: KMS abre la clave de datos, pero el AAD de AES-GCM no coincide.
      await expect(custody.openKey({ ...row, id: CERT_2 })).rejects.toThrow();
      // Otra organización: el contexto de KMS no coincide.
      await expect(custody.openKey({ ...row, tenant_id: TENANT_B })).rejects.toMatchObject({ code: "byok_key_unavailable" });
    } finally {
      kms.setKmsClientFactory(() => kms.mockKms());
    }
  });

  it("v2 BYOK escrita con el certificado en el contexto de KMS (formato anterior) se sigue abriendo", async () => {
    const dataKey = randomBytes(32);
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", dataKey, iv);
    c.setAAD(Buffer.from(`calasign-tenant-certificate|${TENANT_A}|${CERT_1}`, "utf8"));
    const enc = Buffer.concat([c.update("CLAVE-VIEJA", "utf8"), c.final()]);
    const wrapped = await kms.kmsForKey(OK_ARN).encrypt({
      KeyId: OK_ARN,
      Plaintext: dataKey,
      EncryptionContext: { purpose: "calasign-tenant-certificate", tenant: TENANT_A, certificate: CERT_1 },
    });
    const row = {
      id: CERT_1,
      tenant_id: TENANT_A,
      key_ciphertext: `v2.${iv.toString("base64url")}.${enc.toString("base64url")}.${c.getAuthTag().toString("base64url")}`,
      key_wrapped: Buffer.from(wrapped.CiphertextBlob).toString("base64"),
      key_wrap_method: "kms-byok",
      key_wrap_key_arn: OK_ARN,
    };
    expect(await custody.openKey(row)).toBe("CLAVE-VIEJA");
    await expect(custody.openKey({ ...row, id: CERT_2 })).rejects.toThrow();
  });

  it("v2 BYOK con el contexto anterior: al usarla se vuelve a cifrar con {purpose, tenant} (una sola vez si falla)", async () => {
    const { generateDevRootCa } = await import("@calasign/pdf");
    const ca = await generateDevRootCa("Custodia Contexto Viejo");
    /** Clave BYOK v2 escrita con el certificado también en el contexto de KMS (versión anterior). */
    const legacyByok = async (certificateId: string) => {
      const dataKey = randomBytes(32);
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", dataKey, iv);
      c.setAAD(Buffer.from(`calasign-tenant-certificate|${TENANT_A}|${certificateId}`, "utf8"));
      const enc = Buffer.concat([c.update(ca.keyPem, "utf8"), c.final()]);
      const wrapped = await kms.kmsForKey(OK_ARN).encrypt({
        KeyId: OK_ARN,
        Plaintext: dataKey,
        EncryptionContext: { purpose: "calasign-tenant-certificate", tenant: TENANT_A, certificate: certificateId },
      });
      return {
        id: certificateId,
        tenant_id: TENANT_A,
        chain_pem: ca.certPem,
        key_ciphertext: `v2.${iv.toString("base64url")}.${enc.toString("base64url")}.${c.getAuthTag().toString("base64url")}`,
        key_wrapped: Buffer.from(wrapped.CiphertextBlob).toString("base64"),
        key_wrap_method: "kms-byok",
        key_wrap_key_arn: OK_ARN,
      };
    };
    const CERT_3 = "0192f0e0-0000-7000-8000-0000000000c3";
    const CERT_4 = "0192f0e0-0000-7000-8000-0000000000c4";
    const row = await legacyByok(CERT_3);
    const updates: unknown[][] = [];
    const db = {
      query: async (sql: string, params: unknown[]) => (/UPDATE tenant_certificates SET key_ciphertext/.test(sql) ? (updates.push(params), []) : []),
    };
    const decrypts: Record<string, string>[] = [];
    const real = kms.mockKms();
    kms.setKmsClientFactory(() => ({ ...real, decrypt: async (i: any) => (decrypts.push(i.EncryptionContext), real.decrypt(i)) }));
    try {
      await custody.tenantCertificateProvider(db as any, row);
      expect(updates).toHaveLength(1);
      const [id, ciphertext, newWrapped, method, prev] = updates[0] as string[];
      expect([id, method, prev]).toEqual([CERT_3, "kms-byok", row.key_ciphertext]);
      const resealed = { ...row, key_ciphertext: ciphertext, key_wrapped: newWrapped };
      decrypts.length = 0;
      expect(await custody.openKey(resealed)).toBe(ca.keyPem);
      // Se abre al primer intento con el contexto nuevo (el que permite la política de la clave del cliente).
      expect(decrypts).toEqual([{ purpose: "calasign-tenant-certificate", tenant: TENANT_A }]);
      // Ya re-cifrada: no se vuelve a cifrar.
      updates.length = 0;
      await custody.tenantCertificateProvider(db as any, resealed);
      expect(updates).toHaveLength(0);
    } finally {
      kms.setKmsClientFactory(() => kms.mockKms());
    }
    // Si el UPDATE falla, no se reintenta en cada uso.
    let attempts = 0;
    const failing = {
      query: async (sql: string) => {
        if (/UPDATE tenant_certificates SET key_ciphertext/.test(sql)) {
          attempts++;
          throw new Error("base caída");
        }
        return [];
      },
    };
    const row4 = await legacyByok(CERT_4);
    await custody.tenantCertificateProvider(failing as any, row4);
    await custody.tenantCertificateProvider(failing as any, row4);
    expect(attempts).toBe(1);
  }, 60_000);

  it("si la migración a v2 falla, no se reintenta en cada uso", async () => {
    const { generateDevRootCa } = await import("@calasign/pdf");
    const ca = await generateDevRootCa("Custodia Reintento");
    const row: any = { id: CERT_2, tenant_id: TENANT_B, chain_pem: ca.certPem, ...legacySeal(ca.keyPem) };
    let attempts = 0;
    const db = {
      query: async (sql: string) => {
        if (/UPDATE tenant_certificates SET key_ciphertext/.test(sql)) {
          attempts++;
          throw new Error("base caída");
        }
        return [];
      },
    };
    await custody.tenantCertificateProvider(db as any, row);
    await custody.tenantCertificateProvider(db as any, row);
    expect(attempts).toBe(1);
  }, 60_000);

  it("una clave v1 se sigue abriendo y se vuelve a cifrar en v2 al usarla", async () => {
    const { generateDevRootCa } = await import("@calasign/pdf");
    const ca = await generateDevRootCa("Custodia Test");
    const row: any = { id: CERT_1, tenant_id: TENANT_A, chain_pem: ca.certPem, ...legacySeal(ca.keyPem) };
    expect(await custody.openKey(row)).toBe(ca.keyPem);
    const updates: unknown[][] = [];
    const db = {
      query: async (sql: string, params: unknown[]) => (/UPDATE tenant_certificates SET key_ciphertext/.test(sql) ? (updates.push(params), []) : []),
    };
    const provider = await custody.tenantCertificateProvider(db as any, row);
    expect((await provider.signDigest(new Uint8Array(32))).length).toBeGreaterThan(0);
    expect(updates).toHaveLength(1);
    const [id, ciphertext, wrapped, method, prev] = updates[0] as string[];
    expect(id).toBe(CERT_1);
    expect(prev).toBe(row.key_ciphertext);
    expect(ciphertext.startsWith("v2.")).toBe(true);
    expect(method).toBe("local");
    expect(
      await custody.openKey({ id: CERT_1, tenant_id: TENANT_A, key_ciphertext: ciphertext, key_wrapped: wrapped, key_wrap_method: method }),
    ).toBe(ca.keyPem);
    // Ya en v2: no se vuelve a cifrar.
    updates.length = 0;
    await custody.tenantCertificateProvider(db as any, { ...row, key_ciphertext: ciphertext, key_wrapped: wrapped });
    expect(updates).toHaveLength(0);
  }, 60_000);
});
