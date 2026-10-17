// Editor de campos: ubicar, mover, redimensionar y borrar campos sobre las páginas.
import { FieldLogicPanel } from "./FieldLogicPanel";
import type { FieldCondition } from "@calasign/shared";
import { useCallback, useEffect, useRef, useState, type DragEvent, type PointerEvent as RPointerEvent } from "react";
import type { Document, FieldType } from "@calasign/shared";
import { FIELD_TYPES } from "@calasign/shared";
import { uuid } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { DocumentView } from "./DocumentView";
import { recipientColor } from "./ui";

export interface DraftField {
  id: string;
  documentId: string;
  recipientId: string;
  type: FieldType;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  required: boolean;
  label: string | null;
  /** Valor prellenado por el remitente (texto, número, desplegable, empresa, cargo). */
  value?: string | null;
  readOnly?: boolean;
  options?: string[] | null;
  min?: number | null;
  max?: number | null;
  /** Fase 4: se muestra solo si se cumplen las condiciones; fórmula de campo número calculado. */
  conditions?: FieldCondition[] | null;
  formula?: string | null;
}

/** Tipos que el remitente puede prellenar o fijar como solo lectura. */
const PREFILL_TYPES: FieldType[] = ["text", "number", "dropdown", "company", "title"];
/** Tipos con etiqueta visible para el firmante. */
const LABEL_TYPES: FieldType[] = ["text", "checkbox", "number", "dropdown", "company", "title", "attachment"];

/** Tamaño por defecto en puntos PDF. */
const DEFAULT_SIZE: Record<FieldType, [number, number]> = {
  signature: [150, 42],
  initials: [60, 36],
  date_signed: [100, 20],
  name: [150, 20],
  email: [170, 20],
  text: [150, 20],
  checkbox: [16, 16],
  number: [100, 20],
  dropdown: [140, 20],
  company: [170, 20],
  title: [150, 20],
  attachment: [170, 24],
};

const ICON: Record<FieldType, string> = {
  signature: "✍",
  initials: "AB",
  date_signed: "📅",
  name: "👤",
  email: "@",
  text: "T",
  checkbox: "☑",
  number: "#",
  dropdown: "▾",
  company: "🏢",
  title: "💼",
  attachment: "📎",
};

const MIN = 0.008;

interface Props {
  envelopeId: string;
  documents: Document[];
  /** Firmantes del sobre, o roles de la plantilla (solo se usan id y nombre). */
  signers: { id: string; name: string }[];
  fields: DraftField[];
  onChange: (fields: DraftField[]) => void;
  /** URL del PDF de cada documento (por defecto, la del sobre). */
  fileUrl?: (documentId: string) => string;
}

type Drag =
  | { kind: "move"; id: string; startX: number; startY: number; fx: number; fy: number; rect: DOMRect }
  | { kind: "resize"; id: string; startX: number; startY: number; fw: number; fh: number; rect: DOMRect };

export function FieldEditor({ envelopeId, documents, signers, fields, onChange, fileUrl }: Props) {
  const { t } = useI18n();
  const [tool, setTool] = useState<FieldType | null>(null);
  const [activeRecipient, setActiveRecipient] = useState<string>(signers[0]?.id ?? "");
  const [selected, setSelected] = useState<string | null>(null);
  const drag = useRef<Drag | null>(null);
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;

  useEffect(() => {
    if (!signers.find((s) => s.id === activeRecipient)) setActiveRecipient(signers[0]?.id ?? "");
  }, [signers, activeRecipient]);

  const colorOf = useCallback(
    (recipientId: string) => {
      const i = signers.findIndex((s) => s.id === recipientId);
      return i >= 0 ? recipientColor(i) : "#94a3b8";
    },
    [signers],
  );

  const update = useCallback(
    (id: string, patch: Partial<DraftField>) => {
      onChange(fieldsRef.current.map((f) => (f.id === id ? { ...f, ...patch } : f)));
    },
    [onChange],
  );

  const remove = useCallback(
    (id: string) => {
      onChange(fieldsRef.current.filter((f) => f.id !== id));
      setSelected((s) => (s === id ? null : s));
    },
    [onChange],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        e.preventDefault();
        remove(selected);
      }
      if (e.key === "Escape") {
        setTool(null);
        setSelected(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selected, remove]);

  const place = (doc: Document, page: number, type: FieldType, relX: number, relY: number) => {
    if (!activeRecipient) return;
    const size = doc.pages[page];
    const [wp, hp] = DEFAULT_SIZE[type];
    const width = Math.min(wp / size.width, 1);
    const height = Math.min(hp / size.height, 1);
    const x = clamp(relX - width / 2, 0, 1 - width);
    const y = clamp(relY - height / 2, 0, 1 - height);
    const f: DraftField = {
      id: uuid(),
      documentId: doc.id,
      recipientId: activeRecipient,
      type,
      page,
      x,
      y,
      width,
      height,
      required: type !== "checkbox",
      label: null,
      options: type === "dropdown" ? [t("edit.optionDefault1"), t("edit.optionDefault2")] : null,
    };
    onChange([...fieldsRef.current, f]);
    setSelected(f.id);
  };

  const onPagePointerDown = (doc: Document) => (page: number, e: RPointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return; // clic sobre un campo
    if (!tool) {
      setSelected(null);
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    place(doc, page, tool, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    setTool(null);
  };

  const onPageDrop = (doc: Document) => (page: number, e: DragEvent<HTMLDivElement>) => {
    const type = e.dataTransfer.getData("application/x-calasign-field") as FieldType;
    if (!FIELD_TYPES.includes(type)) return;
    e.preventDefault();
    const overlay = (e.currentTarget as HTMLElement).querySelector(".pdf-overlay");
    if (!overlay) return;
    const r = overlay.getBoundingClientRect();
    place(doc, page, type, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  };

  const startMove = (f: DraftField) => (e: RPointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const overlay = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { kind: "move", id: f.id, startX: e.clientX, startY: e.clientY, fx: f.x, fy: f.y, rect: overlay };
    setSelected(f.id);
    setActiveRecipient(f.recipientId);
  };

  const startResize = (f: DraftField) => (e: RPointerEvent<HTMLSpanElement>) => {
    e.stopPropagation();
    const box = e.currentTarget.parentElement as HTMLElement;
    const overlay = (box.parentElement as HTMLElement).getBoundingClientRect();
    box.setPointerCapture(e.pointerId);
    drag.current = { kind: "resize", id: f.id, startX: e.clientX, startY: e.clientY, fw: f.width, fh: f.height, rect: overlay };
    setSelected(f.id);
  };

  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const f = fieldsRef.current.find((x) => x.id === d.id);
    if (!f) return;
    const dx = (e.clientX - d.startX) / d.rect.width;
    const dy = (e.clientY - d.startY) / d.rect.height;
    if (d.kind === "move") {
      update(d.id, { x: clamp(d.fx + dx, 0, 1 - f.width), y: clamp(d.fy + dy, 0, 1 - f.height) });
    } else {
      update(d.id, { width: clamp(d.fw + dx, MIN, 1 - f.x), height: clamp(d.fh + dy, MIN, 1 - f.y) });
    }
  };

  const endDrag = () => {
    drag.current = null;
  };

  const sel = fields.find((f) => f.id === selected) ?? null;

  if (signers.length === 0) return <div className="empty">{t("edit.noSigners")}</div>;

  return (
    <div className="editor">
      <aside className="editor-side card pad">
        <label className="field">
          <span>{t("edit.activeRecipient")}</span>
          <div className="recipient-picker">
            {signers.map((s, i) => (
              <button
                key={s.id}
                type="button"
                className={`rp ${activeRecipient === s.id ? "active" : ""}`}
                style={{ borderColor: recipientColor(i) }}
                onClick={() => {
                  setActiveRecipient(s.id);
                  setSelected(null);
                }}
              >
                <span className="dot" style={{ background: recipientColor(i) }} />
                {s.name}
              </button>
            ))}
          </div>
        </label>

        <p className="muted small">{t("edit.palette")}</p>
        <div className="palette">
          {FIELD_TYPES.map((ft) => (
            <button
              key={ft}
              type="button"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("application/x-calasign-field", ft);
                e.dataTransfer.effectAllowed = "copy";
              }}
              className={`palette-item ${tool === ft ? "active" : ""}`}
              onClick={() => setTool(tool === ft ? null : ft)}
              aria-pressed={tool === ft}
            >
              <span className="pi-icon">{ICON[ft]}</span>
              {t(`field.${ft}`)}
            </button>
          ))}
        </div>
        {tool && <p className="hint">{t("edit.selectFieldHint")}</p>}

        {sel && (
          <div className="field-props">
            <div className="row-between">
              <strong>{t(`field.${sel.type}`)}</strong>
              <button type="button" className="btn btn-danger btn-sm" onClick={() => remove(sel.id)}>
                {t("common.delete")}
              </button>
            </div>
            <label className="field">
              <span>{t("edit.fieldFor")}</span>
              <select value={sel.recipientId} onChange={(e) => update(sel.id, { recipientId: e.target.value })}>
                {signers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            {sel.type !== "date_signed" && sel.type !== "name" && sel.type !== "email" && (
              <label className="check">
                <input type="checkbox" checked={sel.required} onChange={(e) => update(sel.id, { required: e.target.checked })} />
                {t("edit.required")}
              </label>
            )}
            {LABEL_TYPES.includes(sel.type) && (
              <label className="field">
                <span>
                  {t("edit.label")} <span className="muted">({t("common.optional")})</span>
                </span>
                <input value={sel.label ?? ""} maxLength={200} onChange={(e) => update(sel.id, { label: e.target.value || null })} />
              </label>
            )}
            {sel.type === "dropdown" && (
              <label className="field">
                <span>{t("edit.options")}</span>
                <textarea
                  rows={4}
                  value={(sel.options ?? []).join("\n")}
                  onChange={(e) =>
                    update(sel.id, {
                      options: e.target.value
                        .split("\n")
                        .map((o) => o.trimStart())
                        .slice(0, 50),
                    })
                  }
                  onBlur={(e) => update(sel.id, { options: e.target.value.split("\n").map((o) => o.trim()).filter(Boolean) })}
                />
                <small className="muted">{t("edit.optionsHint")}</small>
              </label>
            )}
            {sel.type === "number" && (
              <div className="row-2">
                <label className="field">
                  <span>{t("edit.min")}</span>
                  <input
                    type="number"
                    value={sel.min ?? ""}
                    onChange={(e) => update(sel.id, { min: e.target.value === "" ? null : Number(e.target.value) })}
                  />
                </label>
                <label className="field">
                  <span>{t("edit.max")}</span>
                  <input
                    type="number"
                    value={sel.max ?? ""}
                    onChange={(e) => update(sel.id, { max: e.target.value === "" ? null : Number(e.target.value) })}
                  />
                </label>
              </div>
            )}
            {PREFILL_TYPES.includes(sel.type) && !sel.formula && (
              <>
                <label className="field">
                  <span>
                    {t("edit.prefill")} <span className="muted">({t("common.optional")})</span>
                  </span>
                  {sel.type === "dropdown" ? (
                    <select value={sel.value ?? ""} onChange={(e) => update(sel.id, { value: e.target.value || null })}>
                      <option value="">—</option>
                      {(sel.options ?? []).filter(Boolean).map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={sel.value ?? ""}
                      maxLength={2000}
                      inputMode={sel.type === "number" ? "decimal" : undefined}
                      onChange={(e) => update(sel.id, { value: e.target.value || null, readOnly: e.target.value ? sel.readOnly : false })}
                    />
                  )}
                </label>
                {sel.value && (
                  <label className="check">
                    <input type="checkbox" checked={!!sel.readOnly} onChange={(e) => update(sel.id, { readOnly: e.target.checked })} />
                    {t("edit.readOnly")}
                  </label>
                )}
              </>
            )}
            <FieldLogicPanel field={sel} fields={fields} signers={signers} onChange={(patch) => update(sel.id, patch)} />
          </div>
        )}
        <p className="muted small">
          {fields.length} {t("edit.fieldsCount")}
        </p>
      </aside>

      <div className={`editor-docs ${tool ? "placing" : ""}`}>
        {documents.map((doc) => (
          <DocumentView
            key={doc.id}
            doc={doc}
            url={fileUrl ? fileUrl(doc.id) : `/v1/envelopes/${envelopeId}/documents/${doc.id}/file`}
            onPagePointerDown={onPagePointerDown(doc)}
            onPageDrop={onPageDrop(doc)}
            renderOverlay={(page) =>
              fields
                .filter((f) => f.documentId === doc.id && f.page === page)
                .map((f) => (
                  <div
                    key={f.id}
                    className={`fbox ${selected === f.id ? "selected" : ""} ftype-${f.type}`}
                    style={{
                      left: `${f.x * 100}%`,
                      top: `${f.y * 100}%`,
                      width: `${f.width * 100}%`,
                      height: `${f.height * 100}%`,
                      borderColor: colorOf(f.recipientId),
                      background: `${colorOf(f.recipientId)}22`,
                    }}
                    onPointerDown={startMove(f)}
                    onPointerMove={onMove}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                    title={`${t(`field.${f.type}`)} — ${signers.find((s) => s.id === f.recipientId)?.name ?? ""}`}
                  >
                    <span className="fbox-label" style={{ color: colorOf(f.recipientId) }}>
                      {f.type === "checkbox" ? "☐" : f.readOnly && f.value ? `🔒 ${f.value}` : (f.label ?? t(`field.${f.type}`))}
                      {f.formula ? " ƒ" : ""}
                      {f.conditions?.length ? " ⚙" : ""}
                      {f.required && f.type !== "checkbox" ? " *" : ""}
                    </span>
                    {selected === f.id && (
                      <>
                        <button
                          type="button"
                          className="fbox-del"
                          aria-label={t("common.delete")}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => remove(f.id)}
                        >
                          ×
                        </button>
                        <span className="fbox-resize" onPointerDown={startResize(f)} aria-hidden="true" />
                      </>
                    )}
                  </div>
                ))
            }
          />
        ))}
      </div>
    </div>
  );
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), Math.max(min, max));
}
