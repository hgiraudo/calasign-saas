// Sala de firma por video, vista del anfitrión: videos, participantes (control, consentimiento, identidad),
// grabación y el documento con co-navegación (página, desplazamiento, zoom y campo resaltado).
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { EnvelopeDetail, VideoSession } from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { useVideoText } from "../lib/i18n-video";
import { RoomRecorder, bindScrollBroadcast, captureCobrowse, type VideoState } from "../lib/video";
import { DocumentView } from "../components/DocumentView";
import { ErrorBox, Modal, Spinner, recipientColor } from "../components/ui";
import { MediaControls, VideoGrid, useVideoClient } from "../components/Video";

export function VideoRoomPage() {
  const { id = "", sid = "" } = useParams();
  const v = useVideoText();
  const nav = useNavigate();
  const [detail, setDetail] = useState<EnvelopeDetail | null>(null);
  const [session, setSession] = useState<VideoSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [identityFor, setIdentityFor] = useState<{ pid: string; name: string } | null>(null);
  const [recorder, setRecorder] = useState<RoomRecorder | null>(null);
  const [, force] = useState(0);
  const base = `/v1/envelopes/${id}/video-sessions/${sid}`;

  const { client, state } = useVideoClient(`${base}/ws`);
  const stateRef = useRef<VideoState | null>(null);
  stateRef.current = state;
  const extraRef = useRef({ zoom, fieldId: highlight });
  extraRef.current = { zoom, fieldId: highlight };

  const reload = () =>
    api<VideoSession>(base)
      .then(setSession)
      .catch((e) => setError(errorText(e)));
  useEffect(() => {
    api<EnvelopeDetail>(`/v1/envelopes/${id}`)
      .then(setDetail)
      .catch((e) => setError(errorText(e)));
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, sid]);
  // Refrescar participantes cuando cambia la sala (entradas, consentimientos, identidad).
  const peersKey = state ? state.peers.map((p) => `${p.id}:${p.consented}:${p.identityConfirmed}`).join("|") : "";
  useEffect(() => {
    if (state?.status === "connected") void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peersKey, state?.status]);

  // Co-navegación: el anfitrión (con el control) emite su posición al desplazarse, cambiar el zoom o resaltar.
  useEffect(() => {
    if (!client) return;
    return bindScrollBroadcast(client, () => extraRef.current);
  }, [client]);
  useEffect(() => {
    if (!client?.isController) return;
    const st = captureCobrowse(zoom, highlight);
    if (st) client.sendCobrowse(st);
    for (const s of document.querySelectorAll<HTMLElement>("section.doc-view")) s.style.zoom = String(zoom);
  }, [client, zoom, highlight, state?.controller]);

  // Grabación: se pausa si entra alguien sin consentimiento y se retoma cuando consiente.
  useEffect(() => {
    if (!recorder || !state) return;
    if (state.recording.consentRequired) recorder.pause();
    else recorder.resume();
  }, [recorder, state?.recording.consentRequired]);

  if (!detail || !state || !client) return <div className="page">{error ? <ErrorBox error={error} /> : <Spinner />}</div>;

  const signers = detail.recipients.filter((r) => r.role !== "cc");
  const colorOf = (rid: string) => recipientColor(Math.max(0, signers.findIndex((r) => r.id === rid)));
  const nameOf = (rid: string) => detail.recipients.find((r) => r.id === rid)?.name ?? "";
  const isController = client.isController;
  const controllerName = state.controller === state.you?.id ? v("room.you") : state.peers.find((p) => p.id === state.controller)?.name ?? "—";

  const startRecording = async () => {
    setError(null);
    const rec = new RoomRecorder(
      () => {
        const s = stateRef.current!;
        return [{ stream: s.localStream, label: s.you?.name ?? "" }, ...s.peers.map((p) => ({ stream: p.stream, label: p.name }))];
      },
      async (seq, chunk) => {
        const res = await fetch(`${base}/recording/chunks/${seq}`, { method: "PUT", body: chunk, headers: { "Content-Type": "video/webm" }, credentials: "include" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      },
    );
    rec.onChange = () => force((n) => n + 1);
    try {
      await api(`${base}/recording/start`, { method: "POST", body: { mimeType: rec.mimeType() } });
      rec.start();
      setRecorder(rec);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const stopRecording = async () => {
    if (!recorder) return;
    await recorder.stop();
    setRecorder(null);
    try {
      await api(`${base}/recording/stop`, { method: "POST", body: {} });
    } catch (e) {
      setError(errorText(e));
    }
    void reload();
  };
  const end = async () => {
    if (recorder) await stopRecording();
    try {
      await api(`${base}/end`, { method: "POST", body: {} });
    } catch (e) {
      setError(errorText(e));
    }
    nav(`/app/envelopes/${id}`);
  };

  return (
    <div className="page video-room">
      <div className="page-head row-between">
        <div>
          <Link to={`/app/envelopes/${id}`} className="small">
            {v("room.back")}
          </Link>
          <h1>{v("room.title")}</h1>
          <p className="muted small">{detail.envelope.subject}</p>
        </div>
        <div className="video-actions">
          {session?.recordingEnabled && state.you && !state.you.consented && (
            <button type="button" className="btn btn-ghost" onClick={() => client.consent()}>
              ✓ {v("dock.consent")}
            </button>
          )}
          {session?.recordingEnabled &&
            (recorder ? (
              <button type="button" className="btn btn-ghost" onClick={stopRecording}>
                ■ {v("room.recStop")}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={startRecording}
                disabled={state.recording.consentRequired || state.peers.length === 0 || state.recording.status === "recording"}
                title={state.recording.consentRequired ? v("room.recNeedConsent") : undefined}
              >
                ● {v("room.recStart")}
              </button>
            ))}
          <button type="button" className="btn btn-primary" onClick={end}>
            {v("room.endSession")}
          </button>
        </div>
      </div>
      <ErrorBox error={error} />
      {state.status === "connecting" && <p className="muted">{v("room.connecting")}</p>}
      {state.status === "ended" && <div className="alert alert-warn">{v("room.ended")}</div>}
      {state.status === "error" && <div className="alert alert-warn">{v("room.error", { code: state.error ?? "" })}</div>}
      {state.recording.status === "recording" && (
        <p className="rec-dot" aria-live="polite">
          {v("room.recording")}
          {recorder && recorder.pendingChunks > 0 ? ` · ${v("room.recPending", { n: recorder.pendingChunks })}` : ""}
        </p>
      )}
      {state.recording.consentRequired && session?.recordingEnabled && <p className="small muted">{v("room.recNeedConsent")}</p>}

      <div className="video-layout">
        <div className="video-stage">
          <VideoGrid state={state} />
          {state.peers.length === 0 && <p className="muted small">{v("room.waiting")}</p>}
          <MediaControls client={client} state={state} />
          <section className="card pad">
            <h2>{v("room.participants")}</h2>
            <p className="small muted">{v("room.controller", { name: controllerName })}</p>
            <ul className="video-people">
              {state.peers.map((p) => {
                const part = session?.participants.find((x) => x.id === p.id);
                return (
                  <li key={p.id}>
                    <strong>{p.name}</strong>
                    <span className="small muted">
                      {" "}
                      · {p.consented ? v("room.consented") : v("room.notConsented")}
                      {p.kind === "recipient" ? ` · ${p.identityConfirmed ? v("room.identityOk") : v("room.identityPending")}` : ""}
                    </span>
                    <span className="video-actions">
                      {state.controller !== p.id ? (
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => client.giveControl(p.id)}>
                          {v("room.giveControl")}
                        </button>
                      ) : (
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => state.you && client.giveControl(state.you.id)}>
                          {v("room.takeControl")}
                        </button>
                      )}
                      {p.kind === "recipient" && !p.identityConfirmed && (
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setIdentityFor({ pid: p.id, name: p.name })}>
                          {v("room.confirmIdentity")}
                        </button>
                      )}
                    </span>
                    {part?.identityNote && <p className="small muted">{part.identityNote}</p>}
                  </li>
                );
              })}
            </ul>
          </section>
        </div>

        <div className="video-doc">
          <div className="row-between">
            <h2>{v("room.documents")}</h2>
            <span className="video-actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))} aria-label="−">
                −
              </button>
              <span className="small">{Math.round(zoom * 100)}%</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setZoom((z) => Math.min(2, +(z + 0.25).toFixed(2)))} aria-label="+">
                +
              </button>
            </span>
          </div>
          {isController && <p className="small muted">{v("room.highlight")}</p>}
          {detail.documents.map((d) => (
            <DocumentView
              key={d.id}
              doc={d}
              url={`/v1/envelopes/${id}/documents/${d.id}/file`}
              renderOverlay={(page) =>
                detail.fields
                  .filter((f) => f.documentId === d.id && f.page === page)
                  .map((f) => (
                    <button
                      type="button"
                      key={f.id}
                      data-field-id={f.id}
                      className={`video-field ${highlight === f.id ? "cobrowse-highlight" : ""}`}
                      style={{
                        left: `${f.x * 100}%`,
                        top: `${f.y * 100}%`,
                        width: `${f.width * 100}%`,
                        height: `${f.height * 100}%`,
                        borderColor: colorOf(f.recipientId),
                      }}
                      title={`${nameOf(f.recipientId)} · ${f.label ?? f.type}`}
                      onClick={() => isController && setHighlight(highlight === f.id ? null : f.id)}
                    >
                      <span className="small">{nameOf(f.recipientId)}</span>
                    </button>
                  ))
              }
            />
          ))}
        </div>
      </div>

      {identityFor && <IdentityModal base={base} target={identityFor} onClose={() => setIdentityFor(null)} onDone={reload} />}
    </div>
  );
}

function IdentityModal({ base, target, onClose, onDone }: { base: string; target: { pid: string; name: string }; onClose: () => void; onDone: () => void }) {
  const v = useVideoText();
  const [checked, setChecked] = useState(false);
  const [doc, setDoc] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api(`${base}/participants/${target.pid}/identity`, { method: "POST", body: { confirmed: true, idDocumentNumber: doc || null, note: note || null } });
      onDone();
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={v("room.identityTitle", { name: target.name })}
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-primary" disabled={!checked || busy} onClick={save}>
          {v("room.identitySave")}
        </button>
      }
    >
      <p className="small muted">{v("room.identityIntro")}</p>
      <ErrorBox error={error} />
      <label className="check">
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> {v("room.identityCheck", { name: target.name })}
      </label>
      <label className="field">
        <span>{v("room.identityDoc")}</span>
        <input value={doc} onChange={(e) => setDoc(e.target.value)} maxLength={50} />
      </label>
      <label className="field">
        <span>{v("room.identityNote")}</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} />
      </label>
    </Modal>
  );
}
