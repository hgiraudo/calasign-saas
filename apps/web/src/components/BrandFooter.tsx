// Pie de las páginas públicas (firmante, verificación): "Powered by" de la plataforma salvo en marca blanca total,
// y los links propios de la marca (soporte, privacidad, términos).
import { useI18n } from "../lib/i18n";
import { useBrandTheme } from "../lib/white-label";
import { useWlText } from "../lib/i18n-white-label";
import { Logo } from "./ui";

export function BrandFooter({ className = "signer-foot muted small" }: { className?: string }) {
  const { t } = useI18n();
  const w = useWlText();
  const brand = useBrandTheme();
  const links = brand
    ? ([
        [brand.links.supportUrl, w("footer.support")],
        [brand.links.privacyUrl, w("footer.privacy")],
        [brand.links.termsUrl, w("footer.terms")],
      ].filter(([u]) => u) as [string, string][])
    : [];
  if (brand?.whiteLabel && !links.length) return null;
  return (
    <footer className={className}>
      {!brand?.whiteLabel && (
        <>
          <Logo /> · {t("sign.poweredBy")}
        </>
      )}
      {links.map(([u, label], i) => (
        <span key={label}>
          {(i > 0 || !brand?.whiteLabel) && " · "}
          <a href={u} target="_blank" rel="noopener noreferrer">
            {label}
          </a>
        </span>
      ))}
    </footer>
  );
}
