// Contrato del bloque "video" (Fase 6): sala de firma por videollamada (tipo Virtual Room).
// WebRTC en malla para hasta 4 participantes (anfitrión + firmantes), señalización por WebSocket a través
// de la API, co-navegación del documento, consentimiento y grabación, y confirmación de identidad en cámara.
import { z } from "zod";

export const VIDEO_MAX_PARTICIPANTS = 4;
/** Tamaño máximo de un fragmento de grabación (bytes). */
export const VIDEO_CHUNK_MAX_BYTES = 8 * 1024 * 1024;
/** Máximo de fragmentos por grabación (a ~3 s por fragmento, más de 4 h). */
export const VIDEO_MAX_CHUNKS = 5000;

export const VIDEO_SESSION_STATUSES = ["scheduled", "active", "ended"] as const;
export type VideoSessionStatus = (typeof VIDEO_SESSION_STATUSES)[number];

export const VIDEO_RECORDING_STATUSES = ["none", "recording", "stored", "failed", "purged"] as const;
export type VideoRecordingStatus = (typeof VIDEO_RECORDING_STATUSES)[number];

// ───────────── Remitente (anfitrión) ─────────────

export const CreateVideoSessionInput = z.object({
  /** Fecha y hora acordada (opcional). Sin fecha, la sala queda lista para empezar cuando el anfitrión entre. */
  scheduledAt: z.string().datetime().optional().nullable(),
  /** Destinatarios invitados. Por defecto, todos los firmantes y aprobadores pendientes. */
  recipientIds: z.array(z.string().uuid()).max(3).optional(),
  /** Enviar la invitación (link de firma con la sala) por los canales de cada destinatario. */
  notify: z.boolean().default(true),
  /** El firmante no puede finalizar hasta que el anfitrión confirme su identidad en cámara. */
  requireIdentityConfirmation: z.boolean().default(false),
  /** Grabar la sesión (exige el consentimiento de todos los participantes). */
  recordingEnabled: z.boolean().default(true),
  message: z.string().max(1000).optional().nullable(),
});
export type CreateVideoSessionInput = z.input<typeof CreateVideoSessionInput>;

export const VideoIdentityInput = z.object({
  confirmed: z.boolean(),
  /** Nota del anfitrión (qué documento vio, observaciones). */
  note: z.string().trim().max(500).optional().nullable(),
  /** Número de documento leído en cámara (se compara con el declarado; en la evidencia queda enmascarado). */
  idDocumentNumber: z.string().trim().max(50).optional().nullable(),
});
export type VideoIdentityInput = z.infer<typeof VideoIdentityInput>;

export interface VideoParticipant {
  id: string;
  kind: "host" | "recipient";
  recipientId: string | null;
  userId: string | null;
  name: string;
  joinedAt: string | null;
  leftAt: string | null;
  consentedAt: string | null;
  identityConfirmedAt: string | null;
  identityNote: string | null;
  online: boolean;
}

export interface VideoRecording {
  id: string;
  status: VideoRecordingStatus;
  startedAt: string;
  finishedAt: string | null;
  chunks: number;
  bytes: number;
  sha256: string | null;
  mimeType: string;
}

export interface VideoSession {
  id: string;
  envelopeId: string;
  status: VideoSessionStatus;
  hostUserId: string;
  hostName: string;
  scheduledAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  requireIdentityConfirmation: boolean;
  recordingEnabled: boolean;
  invitedRecipientIds: string[];
  participants: VideoParticipant[];
  recordings: VideoRecording[];
  createdAt: string;
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

// ───────────── Firmante ─────────────

/** GET /v1/signing/:token/video — sala activa o programada para este destinatario (o null). */
export interface SignerVideoInfo {
  session: {
    id: string;
    status: VideoSessionStatus;
    scheduledAt: string | null;
    hostName: string;
    requireIdentityConfirmation: boolean;
    recordingEnabled: boolean;
    identityConfirmed: boolean;
  } | null;
}

// ───────────── Señalización (WebSocket) ─────────────

/** Estado de co-navegación del documento. */
export interface CobrowseState {
  documentId: string | null;
  page: number;
  /** Desplazamiento vertical relativo dentro de la página (0..1). */
  scroll: number;
  zoom: number;
  /** Campo resaltado por quien guía (opcional). */
  fieldId: string | null;
}

export interface VideoPeer {
  id: string;
  kind: "host" | "recipient";
  name: string;
  recipientId: string | null;
  consented: boolean;
  identityConfirmed: boolean;
}

/** Mensajes del cliente al servidor. */
export type VideoClientMessage =
  | { type: "signal"; to: string; data: unknown }
  | { type: "cobrowse"; state: CobrowseState }
  | { type: "control"; to: string }
  | { type: "consent"; granted: true }
  | { type: "ping" };

/** Mensajes del servidor al cliente. */
export type VideoServerMessage =
  | {
      type: "welcome";
      you: VideoPeer;
      peers: VideoPeer[];
      iceServers: IceServer[];
      controller: string | null;
      cobrowse: CobrowseState | null;
      recording: { status: "idle" | "recording"; consentRequired: boolean };
      session: { id: string; envelopeId: string; requireIdentityConfirmation: boolean; recordingEnabled: boolean };
    }
  | { type: "peer_joined"; peer: VideoPeer }
  | { type: "peer_left"; id: string }
  | { type: "peer_updated"; peer: VideoPeer }
  | { type: "signal"; from: string; data: unknown }
  | { type: "cobrowse"; from: string; state: CobrowseState }
  | { type: "control"; controller: string }
  | { type: "recording"; status: "idle" | "recording"; consentRequired: boolean }
  | { type: "ended" }
  | { type: "pong" }
  | { type: "error"; code: string; message: string };
