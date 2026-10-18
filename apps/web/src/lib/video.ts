// Cliente de la sala de firma por video: WebRTC en malla + señalización por WebSocket + co-navegación.
// Lo usan el anfitrión (página de la sala) y el firmante (panel flotante en la página de firma).
import type { CobrowseState, IceServer, VideoPeer, VideoServerMessage } from "@calasign/shared";

export interface RemotePeer extends VideoPeer {
  stream: MediaStream | null;
  connection: RTCPeerConnectionState | "new";
}

export interface VideoState {
  status: "idle" | "connecting" | "connected" | "ended" | "error";
  error: string | null;
  you: VideoPeer | null;
  peers: RemotePeer[];
  controller: string | null;
  recording: { status: "idle" | "recording"; consentRequired: boolean };
  localStream: MediaStream | null;
  micOn: boolean;
  camOn: boolean;
}

type Listener = (s: VideoState) => void;

/** URL ws(s):// del mismo origen. */
export function wsUrl(path: string) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${path}`;
}

export class VideoClient {
  private ws: WebSocket | null = null;
  private pcs = new Map<string, RTCPeerConnection>();
  private pending = new Map<string, RTCIceCandidateInit[]>();
  private iceServers: IceServer[] = [];
  private listeners = new Set<Listener>();
  private pingTimer: number | null = null;
  onCobrowse: ((state: CobrowseState, from: string) => void) | null = null;
  state: VideoState = {
    status: "idle",
    error: null,
    you: null,
    peers: [],
    controller: null,
    recording: { status: "idle", consentRequired: false },
    localStream: null,
    micOn: true,
    camOn: true,
  };

  constructor(private path: string) {}

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    fn(this.state);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private set(patch: Partial<VideoState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  private upsertPeer(p: VideoPeer, extra: Partial<RemotePeer> = {}) {
    const peers = [...this.state.peers];
    const i = peers.findIndex((x) => x.id === p.id);
    if (i >= 0) peers[i] = { ...peers[i], ...p, ...extra };
    else peers.push({ ...p, stream: null, connection: "new", ...extra });
    this.set({ peers });
  }

  private patchPeer(id: string, extra: Partial<RemotePeer>) {
    this.set({ peers: this.state.peers.map((p) => (p.id === id ? { ...p, ...extra } : p)) });
  }

  async start() {
    this.set({ status: "connecting", error: null });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: { ideal: 640 }, height: { ideal: 480 } } });
      this.set({ localStream: stream });
    } catch {
      // Sin cámara/micrófono se puede seguir en la sala (solo ver y escuchar a los demás).
      this.set({ localStream: null, micOn: false, camOn: false });
    }
    const ws = new WebSocket(wsUrl(this.path));
    this.ws = ws;
    ws.onmessage = (ev) => void this.onMessage(JSON.parse(String(ev.data)) as VideoServerMessage);
    ws.onclose = (ev) => {
      if (this.state.status !== "ended") this.set({ status: ev.code === 4000 ? "ended" : "error", error: this.state.error ?? (ev.code === 4000 ? null : "closed") });
      this.cleanupPeers();
    };
    ws.onerror = () => this.set({ status: "error", error: this.state.error ?? "connection" });
    this.pingTimer = window.setInterval(() => this.send({ type: "ping" }), 25_000);
  }

  stop() {
    if (this.pingTimer) window.clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
    this.cleanupPeers();
    this.state.localStream?.getTracks().forEach((t) => t.stop());
    this.set({ localStream: null, status: this.state.status === "ended" ? "ended" : "idle", peers: [] });
  }

  private cleanupPeers() {
    for (const pc of this.pcs.values()) pc.close();
    this.pcs.clear();
  }

  send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  toggleMic() {
    const on = !this.state.micOn;
    this.state.localStream?.getAudioTracks().forEach((t) => (t.enabled = on));
    this.set({ micOn: on });
  }

  toggleCam() {
    const on = !this.state.camOn;
    this.state.localStream?.getVideoTracks().forEach((t) => (t.enabled = on));
    this.set({ camOn: on });
  }

  consent() {
    this.send({ type: "consent", granted: true });
  }

  giveControl(to: string) {
    this.send({ type: "control", to });
  }

  sendCobrowse(state: CobrowseState) {
    if (this.state.you && this.state.controller === this.state.you.id) this.send({ type: "cobrowse", state });
  }

  get isController() {
    return Boolean(this.state.you && this.state.controller === this.state.you.id);
  }

  private pcFor(peerId: string) {
    let pc = this.pcs.get(peerId);
    if (pc) return pc;
    pc = new RTCPeerConnection({ iceServers: this.iceServers as RTCIceServer[] });
    this.pcs.set(peerId, pc);
    this.state.localStream?.getTracks().forEach((t) => pc!.addTrack(t, this.state.localStream!));
    if (!this.state.localStream) {
      // Sin dispositivos propios igual se reciben audio y video de los demás.
      pc.addTransceiver("audio", { direction: "recvonly" });
      pc.addTransceiver("video", { direction: "recvonly" });
    }
    pc.onicecandidate = (e) => {
      if (e.candidate) this.send({ type: "signal", to: peerId, data: { candidate: e.candidate.toJSON() } });
    };
    pc.ontrack = (e) => this.patchPeer(peerId, { stream: e.streams[0] ?? new MediaStream([e.track]) });
    pc.onconnectionstatechange = () => this.patchPeer(peerId, { connection: pc!.connectionState });
    return pc;
  }

  private async call(peerId: string) {
    const pc = this.pcFor(peerId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.send({ type: "signal", to: peerId, data: { sdp: pc.localDescription } });
  }

  private async flushCandidates(peerId: string) {
    const pc = this.pcs.get(peerId);
    const list = this.pending.get(peerId) ?? [];
    this.pending.delete(peerId);
    for (const c of list) await pc?.addIceCandidate(c).catch(() => {});
  }

  private async onSignal(from: string, data: any) {
    const pc = this.pcFor(from);
    if (data?.sdp) {
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.send({ type: "signal", to: from, data: { sdp: pc.localDescription } });
      }
      await this.flushCandidates(from);
    } else if (data?.candidate) {
      if (!pc.remoteDescription) {
        const list = this.pending.get(from) ?? [];
        list.push(data.candidate);
        this.pending.set(from, list);
      } else await pc.addIceCandidate(data.candidate).catch(() => {});
    }
  }

  private async onMessage(m: VideoServerMessage) {
    switch (m.type) {
      case "welcome":
        this.iceServers = m.iceServers;
        this.set({
          status: "connected",
          you: m.you,
          controller: m.controller,
          recording: m.recording,
          peers: m.peers.map((p) => ({ ...p, stream: null, connection: "new" })),
        });
        // Quien llega llama a los que ya estaban (así nunca hay dos ofertas cruzadas).
        for (const p of m.peers) await this.call(p.id);
        if (m.cobrowse && this.onCobrowse) this.onCobrowse(m.cobrowse, m.controller ?? "");
        break;
      case "peer_joined":
        this.upsertPeer(m.peer);
        break;
      case "peer_updated":
        if (this.state.you && m.peer.id === this.state.you.id) this.set({ you: m.peer });
        else this.upsertPeer(m.peer);
        break;
      case "peer_left": {
        this.pcs.get(m.id)?.close();
        this.pcs.delete(m.id);
        this.set({ peers: this.state.peers.filter((p) => p.id !== m.id) });
        break;
      }
      case "signal":
        await this.onSignal(m.from, m.data);
        break;
      case "cobrowse":
        this.onCobrowse?.(m.state, m.from);
        break;
      case "control":
        this.set({ controller: m.controller || null });
        break;
      case "recording":
        this.set({ recording: { status: m.status, consentRequired: m.consentRequired } });
        break;
      case "ended":
        this.set({ status: "ended" });
        this.stop();
        break;
      case "error":
        this.set({ error: m.code });
        break;
      default:
        break;
    }
  }
}

// ───────────────────────────── Co-navegación ─────────────────────────────

function pageElements(documentId: string | null): HTMLElement[] {
  const section = documentId
    ? document.querySelector<HTMLElement>(`section.doc-view[data-document="${CSS.escape(documentId)}"]`)
    : document.querySelector<HTMLElement>("section.doc-view");
  return section ? [...section.querySelectorAll<HTMLElement>(".page-wrap")] : [];
}

/** Página visible (debajo de la barra superior) y desplazamiento relativo dentro de ella. */
export function captureCobrowse(zoom = 1, fieldId: string | null = null): CobrowseState | null {
  const sections = [...document.querySelectorAll<HTMLElement>("section.doc-view")];
  const probe = 90;
  for (const s of sections) {
    const pages = [...s.querySelectorAll<HTMLElement>(".page-wrap")];
    for (let i = 0; i < pages.length; i++) {
      const r = pages[i].getBoundingClientRect();
      if (r.top <= probe && r.bottom > probe) {
        return { documentId: s.dataset.document ?? null, page: i, scroll: Math.min(1, Math.max(0, (probe - r.top) / r.height)), zoom, fieldId };
      }
    }
  }
  const first = sections[0];
  return first ? { documentId: first.dataset.document ?? null, page: 0, scroll: 0, zoom, fieldId } : null;
}

let lastHighlight: HTMLElement | null = null;

/** Lleva la vista a la página y posición indicadas, aplica el zoom y resalta el campo. */
export function applyCobrowse(state: CobrowseState) {
  for (const s of document.querySelectorAll<HTMLElement>("section.doc-view")) s.style.zoom = String(state.zoom || 1);
  const pages = pageElements(state.documentId);
  const el = pages[state.page];
  if (el) {
    const r = el.getBoundingClientRect();
    window.scrollTo({ top: window.scrollY + r.top + r.height * state.scroll - 90, behavior: "smooth" });
  }
  lastHighlight?.classList.remove("cobrowse-highlight");
  lastHighlight = null;
  if (state.fieldId) {
    const f = document.getElementById(`f-${state.fieldId}`) ?? document.querySelector<HTMLElement>(`[data-field-id="${CSS.escape(state.fieldId)}"]`);
    if (f) {
      f.classList.add("cobrowse-highlight");
      lastHighlight = f;
    }
  }
}

/** Emite la posición propia (si se tiene el control) al desplazarse, con un ritmo máximo. */
export function bindScrollBroadcast(client: VideoClient | null, getExtra: () => { zoom: number; fieldId: string | null }) {
  let timer: number | null = null;
  const handler = () => {
    if (!client || !client.isController || timer) return;
    timer = window.setTimeout(() => {
      timer = null;
      const extra = getExtra();
      const st = captureCobrowse(extra.zoom, extra.fieldId);
      if (st) client.sendCobrowse(st);
    }, 250);
  };
  window.addEventListener("scroll", handler, { passive: true });
  return () => {
    window.removeEventListener("scroll", handler);
    if (timer) window.clearTimeout(timer);
  };
}

// ───────────────────────────── Grabación (navegador del anfitrión) ─────────────────────────────

/**
 * Compone los videos de la sala en un canvas y mezcla los audios; graba con MediaRecorder y sube fragmentos
 * en orden. Si el servidor rechaza por falta de consentimiento, se pausa y se reintenta al recuperarlo.
 */
export class RoomRecorder {
  private canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d")!;
  private audio = new AudioContext();
  private dest = this.audio.createMediaStreamDestination();
  private sources = new Map<MediaStream, MediaStreamAudioSourceNode>();
  private recorder: MediaRecorder | null = null;
  private raf = 0;
  private queue: Blob[] = [];
  private seq = 0;
  private uploading = false;
  stopped = false;
  error: string | null = null;
  onChange: (() => void) | null = null;

  constructor(
    private getStreams: () => { stream: MediaStream | null; label: string }[],
    private upload: (seq: number, chunk: Blob) => Promise<void>,
  ) {
    this.canvas.width = 1280;
    this.canvas.height = 720;
  }

  get pendingChunks() {
    return this.queue.length;
  }

  mimeType() {
    for (const m of ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm"]) if (MediaRecorder.isTypeSupported(m)) return m;
    return "video/webm";
  }

  private draw = () => {
    const list = this.getStreams();
    const { width: W, height: H } = this.canvas;
    this.ctx.fillStyle = "#0b1f3a";
    this.ctx.fillRect(0, 0, W, H);
    const cols = list.length <= 1 ? 1 : 2;
    const rows = Math.ceil(Math.max(1, list.length) / cols);
    const cw = W / cols;
    const ch = H / rows;
    list.forEach((item, i) => {
      const x = (i % cols) * cw;
      const y = Math.floor(i / cols) * ch;
      const v = this.videoFor(item.stream);
      if (v && v.readyState >= 2) this.ctx.drawImage(v, x, y, cw, ch);
      this.ctx.fillStyle = "rgba(0,0,0,.55)";
      this.ctx.fillRect(x, y + ch - 28, cw, 28);
      this.ctx.fillStyle = "#fff";
      this.ctx.font = "16px sans-serif";
      this.ctx.fillText(item.label, x + 10, y + ch - 9);
      if (item.stream && !this.sources.has(item.stream) && item.stream.getAudioTracks().length) {
        const src = this.audio.createMediaStreamSource(item.stream);
        src.connect(this.dest);
        this.sources.set(item.stream, src);
      }
    });
    this.ctx.fillStyle = "#fff";
    this.ctx.font = "14px sans-serif";
    this.ctx.fillText(new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC", 10, 22);
    this.raf = requestAnimationFrame(this.draw);
  };

  private videos = new Map<MediaStream, HTMLVideoElement>();
  private videoFor(stream: MediaStream | null) {
    if (!stream) return null;
    let v = this.videos.get(stream);
    if (!v) {
      v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.srcObject = stream;
      void v.play().catch(() => {});
      this.videos.set(stream, v);
    }
    return v;
  }

  start() {
    this.draw();
    const tracks = [...this.canvas.captureStream(15).getVideoTracks(), ...this.dest.stream.getAudioTracks()];
    this.recorder = new MediaRecorder(new MediaStream(tracks), { mimeType: this.mimeType(), videoBitsPerSecond: 1_200_000 });
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        this.queue.push(e.data);
        void this.pump();
      }
    };
    this.recorder.start(3000);
  }

  pause() {
    if (this.recorder?.state === "recording") this.recorder.pause();
  }

  resume() {
    if (this.recorder?.state === "paused") this.recorder.resume();
    void this.pump();
  }

  /** Detiene y espera a que se suban todos los fragmentos. */
  async stop() {
    this.stopped = true;
    cancelAnimationFrame(this.raf);
    if (this.recorder && this.recorder.state !== "inactive") {
      await new Promise<void>((res) => {
        this.recorder!.onstop = () => res();
        this.recorder!.stop();
      });
    }
    for (let i = 0; i < 120 && (this.queue.length || this.uploading); i++) {
      await this.pump();
      await new Promise((r) => setTimeout(r, 500));
    }
    void this.audio.close();
  }

  async pump() {
    if (this.uploading) return;
    this.uploading = true;
    try {
      while (this.queue.length) {
        try {
          await this.upload(this.seq, this.queue[0]);
          this.queue.shift();
          this.seq++;
          this.error = null;
        } catch (e) {
          this.error = String((e as Error).message ?? e);
          break; // se reintenta más tarde (consentimiento, red)
        }
      }
    } finally {
      this.uploading = false;
      this.onChange?.();
    }
  }
}
