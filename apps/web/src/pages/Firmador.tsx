// Página pública de descarga del Firmador CalaSign (/firmador).
import { useTitle } from "../lib/white-label";
import { useEffect, useState } from "react";
import type { FirmadorDownload } from "@calasign/shared";
import { api } from "../lib/api";
import { useCertsignText } from "../lib/i18n-certsign";
import { formatNumber } from "../lib/i18n";
import { LocaleSwitcher, Logo, Spinner } from "../components/ui";

type Os = "windows" | "linux" | "macos";

function detectOs(): Os {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac OS|Macintosh/i.test(ua)) return "macos";
  return "linux";
}

export function FirmadorPage() {
  const c = useCertsignText();
  useTitle(c("firmador.title"));
  const [items, setItems] = useState<FirmadorDownload[] | null>(null);
  const os = detectOs();
  useEffect(() => {
    api<{ items: FirmadorDownload[] }>("/v1/firmador/downloads")
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
  }, []);
  const groups: { os: Os; title: string; steps: string | null; platforms: FirmadorDownload["platform"][] }[] = [
    { os: "windows", title: c("firmador.windows"), steps: c("firmador.windowsSteps"), platforms: ["windows-x64"] },
    { os: "linux", title: c("firmador.linux"), steps: c("firmador.linuxSteps"), platforms: ["linux-x64"] },
    { os: "macos", title: c("firmador.macos"), steps: null, platforms: ["macos-arm64", "macos-x64"] },
  ];
  groups.sort((a, b) => (a.os === os ? -1 : b.os === os ? 1 : 0));
  return (
    <div className="firmador-page">
      <header className="row between pad">
        <Logo />
        <LocaleSwitcher compact />
      </header>
      <main className="firmador-main">
        <h1>{c("firmador.title")}</h1>
        <p>{c("firmador.intro")}</p>
        <h2>{c("firmador.downloads")}</h2>
        {!items ? (
          <Spinner />
        ) : (
          groups.map((g) => {
            const files = items.filter((i) => g.platforms.includes(i.platform));
            return (
              <section key={g.os} className={`card pad firmador-os${g.os === os ? " is-current" : ""}`}>
                <h3>{g.title}</h3>
                {files.length === 0 ? (
                  <p className="muted">{c("firmador.soon")}</p>
                ) : (
                  <>
                    {files.map((f) => (
                      <div key={f.file} className="firmador-file">
                        <a className="btn btn-primary" href={f.url} download>
                          ⬇ {f.file}
                        </a>
                        <div className="muted small mono">
                          {c("firmador.size", {
                            mb: formatNumber(f.sizeBytes / 1048576, undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
                            sha: f.sha256,
                          })}
                        </div>
                      </div>
                    ))}
                    {g.steps && <p className="small">{g.steps}</p>}
                  </>
                )}
              </section>
            );
          })
        )}
        <h2>{c("firmador.tokens")}</h2>
        <p>{c("firmador.tokensText")}</p>
      </main>
    </div>
  );
}
