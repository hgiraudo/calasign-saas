// Pipeline de evidencia al finalizar un sobre: sello de empresa (segunda firma CAdES) y PAdES B-LT/B-LTA
// (DSS + sello de documento) como revisiones incrementales sobre el PDF ya sellado por la plataforma.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  CscSignatureProvider,
  addCadesSignatureIncremental,
  applyLtv,
  defaultSealLevel,
  parseCert,
  pemToDerList,
  type CscConfig,
  type LtvReport,
  type PadesLevel,
  type SignatureProvider,
} from "@calasign/pdf";
import type { SignatureProviderInfo } from "@calasign/shared";
import { config } from "../config";
import type { Db } from "../infra/db";
import { getSealProvider } from "../infra/seal";
import { loadTenantCertificate, tenantCertificateProvider } from "./custody";
import { safeRequest } from "./webhooks";

// ───────────── Nivel PAdES ─────────────

const LEVELS = ["B-B", "B-T", "B-LT", "B-LTA"] as const;

export async function resolveSealLevel(db: Db, tenantId: string): Promise<PadesLevel> {
  const t = await db.one<any>(`SELECT seal_level FROM tenants WHERE id = $1`, [tenantId]);
  const wanted = t?.seal_level && t.seal_level !== "auto" ? t.seal_level : config.seal.level;
  const hasTsa = Boolean(config.seal.tsaUrl);
  if ((LEVELS as readonly string[]).includes(wanted)) {
    // Sin TSA no hay B-T ni superiores.
    return hasTsa ? (wanted as PadesLevel) : "B-B";
  }
  const provider = await getSealProvider();
  return defaultSealLevel(await provider.certificateChain(), hasTsa);
}

// ───────────── Raíces de confianza ─────────────

let anchorsCache: Uint8Array[] | null = null;

export async function trustAnchors(): Promise<Uint8Array[]> {
  if (anchorsCache) return anchorsCache;
  const out: Uint8Array[] = [];
  const dir = config.evidence.trustStoreDir;
  if (dir && existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!/\.(pem|crt|cer|der)$/i.test(f)) continue;
      const raw = readFileSync(resolve(dir, f));
      const ders = raw.toString("latin1").includes("BEGIN CERTIFICATE") ? pemToDerList(raw.toString("latin1")) : [new Uint8Array(raw)];
      for (const d of ders) {
        try {
          const c = parseCert(d);
          if (c.subject.isEqual(c.issuer)) out.push(d);
        } catch {
          // archivo no es un certificado
        }
      }
    }
  }
  // La raíz de la cadena ACTUAL del sello de plataforma (dev/local: la CA de desarrollo). Las raíces de sellos anteriores
  // (rotación) tienen que estar en TRUST_STORE_DIR para que los PDF ya sellados sigan figurando como confiables
  // (docs/EVIDENCIA.md, "Rotación del sello de plataforma").
  const chain = await (await getSealProvider()).certificateChain();
  const last = chain[chain.length - 1];
  if (last) {
    const c = parseCert(last);
    if (c.subject.isEqual(c.issuer)) out.push(last);
  }
  anchorsCache = out;
  return out;
}

// ───────────── Fetch con protección SSRF (URLs que vienen dentro de certificados ajenos) ─────────────

/**
 * Fetch para URLs que vienen dentro de certificados ajenos (OCSP, CRL, AIA) y conectores: solo http(s), sin
 * redirecciones y con la validación de destino en la misma resolución DNS que usa la conexión (`safeRequest`).
 * En local se permite todo (PKI de laboratorio), como en los webhooks.
 */
export const guardedFetch = async (url: string, init?: RequestInit): Promise<Response> => {
  const headers: Record<string, string> = {};
  new Headers(init?.headers ?? {}).forEach((v, k) => (headers[k] = v));
  let body: string | Uint8Array | undefined;
  const b = init?.body;
  if (typeof b === "string") body = b;
  else if (b instanceof ArrayBuffer) body = new Uint8Array(b);
  else if (ArrayBuffer.isView(b)) body = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  else if (b != null) throw new Error("tipo de cuerpo no soportado");
  const r = await safeRequest(url, { method: init?.method ?? "GET", headers, body, signal: init?.signal ?? undefined, timeoutMs: 15_000 });
  if (r.status >= 300 && r.status < 400) throw new Error("redirección no permitida");
  return new Response(r.status === 204 || r.status === 304 ? null : new Uint8Array(r.body), { status: r.status, headers: r.headers });
};

// ───────────── Plan y pipeline ─────────────

export interface EvidencePlan {
  level: PadesLevel;
  signatureLevel: "simple" | "advanced" | "qualified";
  companySealRow: any | null;
  certificate: { signatureLevel: "simple" | "advanced" | "qualified"; companySeal: { name: string; commonName: string | null } | null };
}

export async function planEvidence(db: Db, e: any): Promise<EvidencePlan> {
  const level = await resolveSealLevel(db, e.tenant_id);
  let companySealRow: any = null;
  if (e.company_seal_certificate_id) companySealRow = await loadTenantCertificate(db, e.tenant_id, e.company_seal_certificate_id, "pdf_seal");
  const signatureLevel = (e.signature_level ?? "simple") as EvidencePlan["signatureLevel"];
  return {
    level,
    signatureLevel,
    companySealRow,
    certificate: { signatureLevel, companySeal: companySealRow ? { name: companySealRow.name, commonName: companySealRow.common_name } : null },
  };
}

export interface EvidenceResult {
  pdf: Uint8Array;
  format: string;
  ltv: LtvReport | null;
  companySeal: { certificateId: string; commonName: string | null } | null;
  ltvError: string | null;
}

/** Aplica sello de empresa y LTV sobre el PDF sellado. `timestamped` = la firma de plataforma lleva sello de tiempo. */
export async function applyEvidencePipeline(
  db: Db,
  log: { warn(o: object, m?: string): void },
  e: any,
  sealed: Uint8Array,
  plan: EvidencePlan,
  opts: { timestamped: boolean; orgName: string },
): Promise<EvidenceResult> {
  let pdf = sealed;
  const tsaUrl = opts.timestamped ? config.seal.tsaUrl : null;
  let companySeal: EvidenceResult["companySeal"] = null;
  if (plan.companySealRow) {
    // Si se pidió sello de empresa y falla, el job falla y se reintenta: no se entrega sin él.
    const provider = await tenantCertificateProvider(db, plan.companySealRow);
    pdf = await addCadesSignatureIncremental(pdf, provider, {
      fieldName: "SelloEmpresa",
      reason: "Sello electrónico de la organización",
      name: opts.orgName,
      location: opts.orgName || "Cloud",
      tsaUrl,
    });
    companySeal = { certificateId: plan.companySealRow.id, commonName: plan.companySealRow.common_name };
  }

  let level: PadesLevel = opts.timestamped ? "B-T" : "B-B";
  let ltv: LtvReport | null = null;
  let ltvError: string | null = null;
  if (opts.timestamped && (plan.level === "B-LT" || plan.level === "B-LTA")) {
    try {
      const r = await applyLtv(pdf, { level: plan.level, tsaUrl, extraCerts: await trustAnchors(), fetcher: guardedFetch });
      pdf = r.pdf;
      ltv = r.report;
      level = plan.level;
    } catch (err) {
      if (config.seal.tsaRequired) throw err;
      ltvError = String(err);
      log.warn({ envelopeId: e.id, err: ltvError }, `no se pudo llevar el sello a ${plan.level}: queda en B-T`);
    }
  }
  return { pdf, format: `PAdES-${level}`, ltv, companySeal, ltvError };
}

// ───────────── Conectores de firma (CSC v2) ─────────────

function cscConfigs(): CscConfig[] {
  const out: CscConfig[] = [];
  if (config.evidence.cscConnectors) {
    try {
      const list = JSON.parse(config.evidence.cscConnectors) as CscConfig[];
      for (const c of list) if (c?.id && c?.baseUrl && c?.auth) out.push({ ...c, fetcher: guardedFetch });
    } catch {
      // JSON inválido: se ignora (se ve en /v1/signature-providers como no configurado)
    }
  }
  // Conector de la CA de Calasign (placeholder: habla CSC v2; no está cableado a la CA real).
  const env = process.env;
  if (env.CALASIGN_CA_CSC_URL && !out.some((c) => c.id === "calasign-ca")) {
    out.push({
      id: "calasign-ca",
      baseUrl: env.CALASIGN_CA_CSC_URL,
      auth: env.CALASIGN_CA_TOKEN_URL
        ? {
            type: "oauth2_client",
            tokenUrl: env.CALASIGN_CA_TOKEN_URL,
            clientId: env.CALASIGN_CA_CLIENT_ID ?? "",
            clientSecret: env.CALASIGN_CA_CLIENT_SECRET ?? "",
          }
        : { type: "basic", username: env.CALASIGN_CA_CLIENT_ID ?? "", password: env.CALASIGN_CA_CLIENT_SECRET ?? "" },
      level: "advanced",
      fetcher: guardedFetch,
    });
  }
  return out;
}

export async function listSignatureProviders(): Promise<SignatureProviderInfo[]> {
  const platform = await getSealProvider();
  const list: SignatureProviderInfo[] = [{ id: platform.id, type: "platform", level: "simple", baseUrl: null, configured: true }];
  // Sin la URL del prestador: los conectores son de la plataforma y cualquier organización los lista.
  for (const c of cscConfigs()) list.push({ id: c.id, type: "csc", level: c.level ?? "qualified", baseUrl: null, configured: true });
  if (!list.some((p) => p.id === "calasign-ca")) list.push({ id: "calasign-ca", type: "csc", level: "advanced", baseUrl: null, configured: false });
  return list;
}

export function getCscProvider(id: string): CscSignatureProvider | null {
  const c = cscConfigs().find((x) => x.id === id);
  return c ? new CscSignatureProvider(c) : null;
}

export type { SignatureProvider };
