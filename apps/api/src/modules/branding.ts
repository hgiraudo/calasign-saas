// Branding básico de la organización: color principal, logo y pie de correo.
// Se aplica en la página del firmante, los correos y el certificado de finalización.
import type { FastifyInstance } from "fastify";
import { assertPngSize } from "@calasign/pdf";
import { LOGO_CONTENT_TYPES, LOGO_MAX_BYTES, UpdateBrandingInput, type Branding } from "@calasign/shared";
import { config } from "../config";
import type { Db } from "../infra/db";
import type { BlobStore } from "../infra/storage";
import { AppError, badRequest, notFound } from "../lib/errors";
import { sha256Hex, uuidv7 } from "../lib/util";
import { authenticate, type Services } from "./context";
import { auditFromRequest } from "./audit";
import { deleteFileIfUnused, discardBlobsOnFailure } from "./file-cleanup";

interface StoredBranding {
  primaryColor?: string | null;
  emailFooter?: string | null;
  logoFileId?: string | null;
  logoContentType?: string | null;
}

export interface TenantBranding {
  slug: string;
  primaryColor: string | null;
  emailFooter: string | null;
  logoFileId: string | null;
  logoContentType: string | null;
  /** URL absoluta del logo (null si no hay). */
  logoUrl: string | null;
}

export async function getTenantBranding(db: Db, tenantId: string): Promise<TenantBranding> {
  const t = await db.one<any>(`SELECT slug, branding FROM tenants WHERE id = $1`, [tenantId]);
  const b: StoredBranding = t?.branding ?? {};
  const logoFileId = b.logoFileId ?? null;
  return {
    slug: t?.slug ?? "",
    primaryColor: b.primaryColor ?? null,
    emailFooter: b.emailFooter ?? null,
    logoFileId,
    logoContentType: b.logoContentType ?? null,
    logoUrl: logoFileId && t ? `${config.appUrl}/v1/branding/logo/${t.slug}?v=${logoFileId.slice(-8)}` : null,
  };
}

/** Bytes del logo para el certificado (solo PNG/JPG: pdf-lib no dibuja SVG). */
export async function getLogoForPdf(db: Db, blobs: BlobStore, b: TenantBranding): Promise<{ bytes: Uint8Array; type: "png" | "jpg" } | null> {
  if (!b.logoFileId || !b.logoContentType || b.logoContentType === "image/svg+xml") return null;
  const f = await db.one<any>(`SELECT storage_key FROM files WHERE id = $1`, [b.logoFileId]);
  if (!f) return null;
  return { bytes: await blobs.get(f.storage_key), type: b.logoContentType === "image/png" ? "png" : "jpg" };
}

const toApi = (b: TenantBranding): Branding => ({
  primaryColor: b.primaryColor,
  emailFooter: b.emailFooter,
  logoUrl: b.logoUrl ? b.logoUrl.replace(config.appUrl, "") : null,
  logoContentType: b.logoContentType,
});

function sniffImage(buf: Buffer): string | null {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  const head = buf.subarray(0, 1024).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  return null;
}

/** Rechaza SVG con scripts, handlers o referencias externas (el logo se sirve públicamente). */
function unsafeSvg(svg: string): boolean {
  return /<script|\bon[a-z]{1,40}\s*=|javascript:|<foreignObject|xlink:href\s*=\s*["'](?!#)|href\s*=\s*["'](?!#)|<!ENTITY/i.test(svg);
}

async function patchBranding(db: Db, tenantId: string, patch: StoredBranding) {
  await db.query(`UPDATE tenants SET branding = COALESCE(branding, '{}'::jsonb) || $2::jsonb WHERE id = $1`, [tenantId, JSON.stringify(patch)]);
}

export async function brandingRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);

  app.get("/v1/settings/branding", { preHandler: auth }, async (req) => toApi(await getTenantBranding(s.db, req.auth!.tenantId)));

  app.patch("/v1/settings/branding", { preHandler: auth }, async (req) => {
    const input = UpdateBrandingInput.parse(req.body);
    const patch: StoredBranding = {};
    if (input.primaryColor !== undefined) patch.primaryColor = input.primaryColor ? input.primaryColor.toLowerCase() : null;
    if (input.emailFooter !== undefined) patch.emailFooter = input.emailFooter?.trim() || null;
    await patchBranding(s.db, req.auth!.tenantId, patch);
    if (input.organizationName !== undefined) {
      const a = req.auth!;
      const prev = await s.db.one<any>(`SELECT name FROM tenants WHERE id = $1`, [a.tenantId]);
      if (prev && prev.name !== input.organizationName) {
        await s.db.query(`UPDATE tenants SET name = $2 WHERE id = $1`, [a.tenantId, input.organizationName]);
        await auditFromRequest(s.db, req, a, "organization.renamed", {
          // Con este registro el hook no agrega settings.changed: van también los demás campos del mismo cambio.
          data: { from: prev.name, to: input.organizationName, fields: Object.keys((req.body as object) ?? {}) },
        });
      }
    }
    return toApi(await getTenantBranding(s.db, req.auth!.tenantId));
  });

  app.post("/v1/settings/branding/logo", { preHandler: auth }, async (req) => {
    const tenantId = req.auth!.tenantId;
    const file = await req.file({ limits: { fileSize: LOGO_MAX_BYTES } });
    if (!file) throw badRequest("file_required", "Falta el archivo (campo 'file')");
    const buf = await file.toBuffer();
    if (file.file.truncated) throw new AppError(413, "file_too_large", "El logo supera los 200 KB");
    const type = sniffImage(buf);
    if (!type || !(LOGO_CONTENT_TYPES as readonly string[]).includes(type)) throw badRequest("invalid_logo", "El logo tiene que ser PNG, JPG o SVG");
    if (type === "image/svg+xml" && unsafeSvg(buf.toString("utf8"))) throw badRequest("invalid_logo", "El SVG contiene scripts o referencias externas");
    // El logo se incrusta en el certificado de cada sobre: un PNG que declara dimensiones enormes reservaría GB al sellar.
    if (type === "image/png") {
      try {
        assertPngSize(new Uint8Array(buf));
      } catch {
        throw badRequest("invalid_logo", "La imagen PNG está dañada o es demasiado grande (máximo 4096×4096)");
      }
    }
    const fileId = uuidv7();
    const ext = type === "image/png" ? "png" : type === "image/jpeg" ? "jpg" : "svg";
    const key = `tenants/${tenantId}/branding/${fileId}.${ext}`;
    await s.blobs.put(key, buf, type);
    const previous = await discardBlobsOnFailure(s.blobs, [key], () => s.db.tx(async (t) => {
      const cur = await t.one<any>(`SELECT branding->>'logoFileId' AS logo FROM tenants WHERE id = $1 FOR UPDATE`, [tenantId]);
      await t.query(`INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'logo',$3,$4,$5,$6)`, [
        fileId,
        tenantId,
        key,
        type,
        buf.length,
        sha256Hex(buf),
      ]);
      await patchBranding(t, tenantId, { logoFileId: fileId, logoContentType: type });
      return (cur?.logo as string | null) ?? null;
    }));
    // El logo anterior ya no lo usa nada (se sirve siempre el vigente): sin esto quedaba en el almacenamiento para siempre.
    await deleteFileIfUnused(s.db, s.blobs, previous).catch(() => {});
    return toApi(await getTenantBranding(s.db, tenantId));
  });

  app.delete("/v1/settings/branding/logo", { preHandler: auth }, async (req) => {
    const tenantId = req.auth!.tenantId;
    const previous = await s.db.tx(async (t) => {
      const cur = await t.one<any>(`SELECT branding->>'logoFileId' AS logo FROM tenants WHERE id = $1 FOR UPDATE`, [tenantId]);
      await patchBranding(t, tenantId, { logoFileId: null, logoContentType: null });
      return (cur?.logo as string | null) ?? null;
    });
    await deleteFileIfUnused(s.db, s.blobs, previous).catch(() => {});
    return toApi(await getTenantBranding(s.db, tenantId));
  });

  // Público: lo usan la página del firmante y los correos.
  app.get<{ Params: { slug: string } }>("/v1/branding/logo/:slug", async (req, reply) => {
    const t = await s.db.one<any>(`SELECT id FROM tenants WHERE slug = $1`, [req.params.slug]);
    if (!t) throw notFound("Logo");
    const b = await getTenantBranding(s.db, t.id);
    if (!b.logoFileId) throw notFound("Logo");
    const f = await s.db.one<any>(`SELECT storage_key, content_type FROM files WHERE id = $1 AND tenant_id = $2`, [b.logoFileId, t.id]);
    if (!f) throw notFound("Logo");
    reply
      .header("content-type", f.content_type)
      .header("cache-control", "public, max-age=86400")
      .header("x-content-type-options", "nosniff")
      // Un SVG abierto directo no puede ejecutar nada.
      .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    return reply.send(Buffer.from(await s.blobs.get(f.storage_key)));
  });
}
