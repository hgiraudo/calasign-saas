// Sala de firma por video: tarjeta en el detalle del sobre (remitente), mosaico de videos y panel flotante del
// firmante (se monta junto a la página de firma, fuera de su flujo, para no cortar la llamada al avanzar).
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import type { CreateVideoSessionInput, EnvelopeStatus, Recipient, SignerVideoInfo, VideoSession } from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { useVideoText } from "../lib/i18n-video";
import { VideoClient, applyCobrowse, bindScrollBroadcast, type VideoState } from "../lib/video";
import { ErrorBox } from "./ui";

// ───────────────────────────── Mosaico ─────────────────────────────

export function VideoTile({ stream, label, muted, mirrored, badge }: { stream: MediaStream | null; label: string; muted?: boolean; mirrored?: boolean; badge?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <figure className="vtile">
      {stream ? (
        <video ref={ref} autoPlay playsInline muted={muted} className={mirrored ? "mirrored" : undefined} aria-label={label} />
      ) : (
        <div className="vtile-empty" aria-hidden="true">
          {label.slice(0, 1).toUpperCase()}
        </div>
      )}
      <figcaption>
        {label}
        {badge && <span className="vtile-badge">{badge}</span>}
      </figcaption>
    </figure>
  );
}

export function useVideoClient(path: string | null, onCobrowse?: VideoClient["onCobrowse"]) {
  const [client, setClient] = useState<VideoClient | null>(null);
  const [state, setState] = useState<VideoState | null>(null);
  useEffect(() => {
    if (!path) return;
    const c = new VideoClient(path);
    c.onCobrowse = onCobrowse ?? null;
    setClient(c);
    const off = c.subscribe(setState);
    void c.start();
    return () => {
      off();
      c.stop();
      setClient(null);
      setState(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  return { client, state };
}

export function VideoGrid({ state, compact }: { state: VideoState; compact?: boolean }) {
  const v = useVideoText();
  const others = state.peers;
  return (
    <div className={`vgrid ${compact ? "vgrid-compact" : ""} vgrid-${Math.min(4, others.length + 1)}`}>
      <VideoTile stream={state.localStream} label={`${v("room.you")}${state.you ? ` · ${state.you.name}` : ""}`} muted mirrored />
      {others.map((p) => (
        <VideoTile key={p.id} stream={p.stream} label={p.name} badge={p.kind === "host" ? v("room.host") : undefined} />
      ))}
    </div>
  );
}

export function MediaControls({ client, state, onLeave }: { client: VideoClient; state: VideoState; onLeave?: () => void }) {
  const v = useVideoText();
  return (
    <div className="vcontrols">
      <button type="button" className="btn btn-ghost btn-sm" aria-pressed={state.micOn} onClick={() => client.toggleMic()} disabled={!state.localStream}>
        🎙 {v("room.mic")}: {state.micOn ? v("room.on") : v("room.off")}
      </button>
      <button type="button" className="btn btn-ghost btn-sm" aria-pressed={state.camOn} onClick={() => client.toggleCam()} disabled={!state.localStream}>
        🎥 {v("room.cam")}: {state.camOn ? v("room.on") : v("room.off")}
      </button>
      {onLeave && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onLeave}>
          {v("room.leave")}
        </button>
      )}
    </div>
  );
}

// ───────────────────────────── Remitente: tarjeta en el detalle del sobre ─────────────────────────────

export function VideoSessionsPanel({ envelopeId, envelopeStatus, recipients }: { envelopeId: string; envelopeStatus: EnvelopeStatus; recipients: Recipient[] }) {
  const v = useVideoText();
  const [items, setItems] = useState<VideoSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ scheduledAt: "", requireIdentityConfirmation: false, recordingEnabled: true, notify: true });
  const base = `/v1/envelopes/${envelopeId}/video-sessions`;
  const load = () =>
    api<{ items: VideoSession[] }>(base)
      .then((r) => setItems(r.items))
      .catch((e) => setError(errorText(e)));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envelopeId]);
  const pending = recipients.filter((r) => (r.role === "signer" || r.role === "approver") && ["created", "sent", "viewed"].includes(r.status));
  const open = items?.find((s) => s.status !== "ended");
  if (!items) return null;
  if (envelopeStatus !== "sent" && items.length === 0) return null;
  const names = new Map(recipients.map((r) => [r.id, r.name]));

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: CreateVideoSessionInput = {
        recipientIds: pending.slice(0, 3).map((r) => r.id),
        requireIdentityConfirmation: form.requireIdentityConfirmation,
        recordingEnabled: form.recordingEnabled,
        notify: form.notify,
        scheduledAt: form.scheduledAt ? new Date(form.scheduledAt).toISOString() : null,
      };
      await api(base, { method: "POST", body });
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const act = async (path: string) => {
    setError(null);
    try {
      await api(path, { method: "POST", body: {} });
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <section className="card pad video-panel" aria-labelledby="video-panel-title">
      <h2 id="video-panel-title">🎥 {v("panel.title")}</h2>
      <p className="small muted">{v("panel.intro")}</p>
      <ErrorBox error={error} />
      {envelopeStatus === "sent" && !open && pending.length > 0 && (
        <div className="video-create">
          <label className="field">
            <span>{v("panel.scheduledAt")}</span>
            <input type="datetime-local" value={form.scheduledAt} onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })} />
          </label>
          <label className="check">
            <input type="checkbox" checked={form.requireIdentityConfirmation} onChange={(e) => setForm({ ...form, requireIdentityConfirmation: e.target.checked })} />{" "}
            {v("panel.requireIdentity")}
          </label>
          <label className="check">
            <input type="checkbox" checked={form.recordingEnabled} onChange={(e) => setForm({ ...form, recordingEnabled: e.target.checked })} /> {v("panel.recording")}
          </label>
          <label className="check">
            <input type="checkbox" checked={form.notify} onChange={(e) => setForm({ ...form, notify: e.target.checked })} /> {v("panel.notify")}
          </label>
          <p className="small muted">
            {v("panel.invited")}: {pending.slice(0, 3).map((r) => r.name).join(", ")}
          </p>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={create}>
            {busy ? v("panel.creating") : v("panel.create")}
          </button>
        </div>
      )}
      {items.length === 0 && envelopeStatus !== "sent" && <p className="small muted">{v("panel.none")}</p>}
      <ul className="video-sessions">
        {items.map((s) => (
          <li key={s.id}>
            <div className="row-between">
              <strong>
                <span className={`badge ${s.status === "active" ? "badge-sent" : s.status === "ended" ? "badge-completed" : "badge-draft"}`}>{v(`status.${s.status}`)}</span>{" "}
                {s.scheduledAt ? new Date(s.scheduledAt).toLocaleString() : ""}
              </strong>
              <span className="video-actions">
                {s.status !== "ended" && (
                  <>
                    <Link className="btn btn-primary btn-sm" to={`/app/envelopes/${envelopeId}/video/${s.id}`}>
                      {v("panel.enter")}
                    </Link>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => act(`${base}/${s.id}/invite`)}>
                      {v("panel.resend")}
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => act(`${base}/${s.id}/end`)}>
                      {v("panel.end")}
                    </button>
                  </>
                )}
              </span>
            </div>
            <p className="small muted">
              {v("panel.invited")}: {s.invitedRecipientIds.map((id) => names.get(id) ?? "—").join(", ")}
            </p>
            {s.participants.length > 0 && (
              <ul className="small video-people">
                {s.participants.map((p) => (
                  <li key={p.id}>
                    {p.online ? "🟢" : "⚪"} {p.name}
                    {p.kind === "host" ? ` (${v("room.host")})` : ""} · {p.consentedAt ? v("room.consented") : v("room.notConsented")}
                    {p.kind === "recipient" ? ` · ${p.identityConfirmedAt ? v("room.identityOk") : v("room.identityPending")}` : ""}
                  </li>
                ))}
              </ul>
            )}
            {s.recordings
              .filter((r) => r.status === "stored")
              .map((r) => (
                <p key={r.id} className="small">
                  <a href={`${base}/${s.id}/recordings/${r.id}`}>⬇ {v("panel.download")}</a> <span className="mono break">SHA-256 {r.sha256}</span>
                </p>
              ))}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ───────────────────────────── Firmante: panel flotante ─────────────────────────────

/** Se monta en la ruta /s/:token junto a la página de firma. Si no hay sala, no muestra nada. */
export function SignerVideoDock() {
  const { token = "" } = useParams();
  const loc = useLocation();
  const v = useVideoText();
  const base = `/v1/signing/${encodeURIComponent(token)}`;
  const [info, setInfo] = useState<SignerVideoInfo["session"]>(null);
  const [joined, setJoined] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const wantsVideo = useMemo(() => new URLSearchParams(loc.search).has("video"), [loc.search]);

  // Busca la sala periódicamente (el link puede estar todavía detrás del código o de la verificación de identidad).
  useEffect(() => {
    let alive = true;
    const check = () =>
      api<SignerVideoInfo>(`${base}/video`)
        .then((r) => alive && setInfo(r.session))
        .catch(() => {});
    void check();
    const t = window.setInterval(check, 15_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [base]);

  const { client, state } = useVideoClient(joined ? `${base}/video/ws` : null, (st) => applyCobrowse(st));

  useEffect(() => {
    if (!client) return;
    return bindScrollBroadcast(client, () => ({ zoom: 1, fieldId: null }));
  }, [client]);

  if (!info) return null;
  if (!joined) {
    return (
      <aside className={`vdock vdock-invite ${wantsVideo ? "vdock-attn" : ""}`} aria-live="polite">
        <p className="small">
          🎥{" "}
          {info.status === "active" || !info.scheduledAt
            ? v("dock.now", { host: info.hostName })
            : v("dock.scheduled", { host: info.hostName, when: new Date(info.scheduledAt).toLocaleString() })}
        </p>
        {info.requireIdentityConfirmation && !info.identityConfirmed && <p className="small muted">{v("dock.identityWait", { host: info.hostName })}</p>}
        <button type="button" className="btn btn-accent btn-sm" onClick={() => setJoined(true)}>
          {v("dock.join")}
        </button>
      </aside>
    );
  }
  if (!state || !client) return null;
  const controllerName =
    state.controller === state.you?.id ? null : state.peers.find((p) => p.id === state.controller)?.name ?? null;
  return (
    <aside className={`vdock ${minimized ? "vdock-min" : ""}`} aria-label={v("panel.title")}>
      <div className="row-between vdock-head">
        <strong className="small">🎥 {v("panel.title")}</strong>
        <span>
          {state.recording.status === "recording" && <span className="rec-dot small">{v("dock.recording")}</span>}{" "}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMinimized(!minimized)}>
            {minimized ? v("dock.expand") : v("dock.minimize")}
          </button>
        </span>
      </div>
      {state.status === "connecting" && <p className="small muted">{v("room.connecting")}</p>}
      {state.status === "ended" && <p className="small">{v("room.ended")}</p>}
      {state.status === "error" && <p className="small error-text">{v("room.error", { code: state.error ?? "" })}</p>}
      {!minimized && state.status === "connected" && (
        <>
          <VideoGrid state={state} compact />
          {state.you && !state.you.consented && (
            <div className="vconsent" role="region" aria-label={v("dock.consentTitle")}>
              <strong className="small">{v("dock.consentTitle")}</strong>
              <p className="small muted">{v("dock.consentText")}</p>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => client.consent()}>
                {v("dock.consent")}
              </button>
            </div>
          )}
          {state.you?.consented && <p className="small muted">✓ {v("dock.consentDone")}</p>}
          {info.requireIdentityConfirmation && (
            <p className="small" aria-live="polite">
              {state.you?.identityConfirmed ? `✓ ${v("dock.identityOk")}` : v("dock.identityWait", { host: info.hostName })}
            </p>
          )}
          <p className="small muted">{controllerName ? v("dock.following", { name: controllerName }) : client.isController ? v("dock.leading") : ""}</p>
          {client.isController && state.peers.some((p) => p.kind === "host") && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => client.giveControl(state.peers.find((p) => p.kind === "host")!.id)}>
              {v("room.returnControl")}
            </button>
          )}
          <MediaControls client={client} state={state} onLeave={() => setJoined(false)} />
        </>
      )}
    </aside>
  );
}
