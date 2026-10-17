import { useEffect, useState } from "react";
import type { DevMailboxItem } from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { formatDateTime, useI18n } from "../lib/i18n";
import { ErrorBox, Spinner } from "../components/ui";

export function DevMailboxPage() {
  const { t, locale } = useI18n();
  const [items, setItems] = useState<DevMailboxItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api<{ items: DevMailboxItem[] }>("/dev/mailbox")
      .then((r) => {
        setItems(r.items);
        setError(null);
      })
      .catch((e) => setError(errorText(e)));

  useEffect(() => {
    void load();
    const h = window.setInterval(load, 5000);
    return () => window.clearInterval(h);
  }, []);

  return (
    <div className="page narrow">
      <div className="page-head">
        <h1>{t("mailbox.title")}</h1>
        <button type="button" className="btn btn-ghost" onClick={load}>
          {t("common.refresh")}
        </button>
      </div>
      <p className="muted">{t("mailbox.intro")}</p>
      <ErrorBox error={error} />
      {!items ? (
        <Spinner />
      ) : items.length === 0 ? (
        <div className="empty">{t("mailbox.empty")}</div>
      ) : (
        <div className="stack">
          {items.map((m) => (
            <article key={m.id} className="card pad mail">
              <div className="mail-head">
                <span className={`badge chan-${m.channel}`}>{m.channel}</span>
                <strong className="grow">{m.subject}</strong>
                <span className="muted small">{formatDateTime(m.createdAt, locale)}</span>
              </div>
              <div className="muted small">→ {m.to}</div>
              <pre className="mail-text">{m.text}</pre>
              {m.link && (
                <a className="btn btn-primary btn-sm" href={toLocal(m.link)}>
                  {t("mailbox.open")}
                </a>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

/** En dev el servidor puede armar links con otro host; si apuntan a /s/…, abrirlos en este origen. */
function toLocal(link: string): string {
  try {
    const u = new URL(link, window.location.origin);
    if (u.pathname.startsWith("/s/")) return u.pathname + u.search;
    return u.toString();
  } catch {
    return link;
  }
}
