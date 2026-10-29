// Editor de campos: ubicar, mover, redimensionar y borrar campos sobre las páginas.
import { FieldLogicPanel } from "./FieldLogicPanel";
import type { FieldCondition } from "@calasign/shared";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as RKeyboardEvent,
  type PointerEvent as RPointerEvent,
} from "react";
import type { Document, FieldType } from "@calasign/shared";
import { FIELD_TYPES, formulaRefs, parseFormula } from "@calasign/shared";
import { uuid } from "../lib/api";
import { useI18n, type TFunc } from "../lib/i18n";
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
/** Paso de las flechas del teclado (mover o, con Shift, redimensionar), en fracción de la página. */
const KEY_STEP = 0.005;
const ARROWS: Record<string, [number, number] | undefined> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/**
 * Lo que la API rechazaría de un campo, chequeado antes de guardar para señalar cuál es (la API solo dice "Campo N"
 * o "fields.N" y en el editor no hay números): desplegable sin opciones, mínimo mayor que máximo, solo lectura sin
 * valor, prellenado que no es una opción, fórmulas y condiciones inválidas. null si no hay problemas.
 */
export function validateFields(fields: DraftField[], t: TFunc): { id: string; message: string } | null {
  const numberLabels = new Map<string, number>();
  for (const f of fields) {
    const k = f.type === "number" ? f.label?.trim().toLowerCase() : "";
    if (k) numberLabels.set(k, (numberLabels.get(k) ?? 0) + 1);
  }
  const ids = new Set(fields.map((f) => f.id));
  for (const f of fields) {
    const err = (msg: string) => ({ id: f.id, message: t("edit.err.field", { field: f.label || t(`field.${f.type}`), page: f.page + 1, msg }) });
    const options = (f.options ?? []).map((o) => o.trim()).filter(Boolean);
    if (f.type === "dropdown" && options.length === 0) return err(t("edit.err.dropdownOptions"));
    if (f.min != null && f.max != null && f.min > f.max) return err(t("edit.err.minMax"));
    if (f.readOnly && !f.value) return err(t("edit.err.readOnlyValue"));
    const v = f.value?.trim().toLowerCase();
    if (f.type === "dropdown" && v && !options.some((o) => o.toLowerCase() === v)) return err(t("edit.err.prefillOption"));
    for (const c of f.conditions ?? []) {
      if (c.fieldId === f.id || !ids.has(c.fieldId)) return err(t("edit.err.condition"));
      if ((c.operator === "equals" || c.operator === "not_equals") && c.value == null) return err(t("edit.err.conditionValue"));
    }
    if (f.formula?.trim()) {
      let refs: string[];
      try {
        refs = formulaRefs(f.formula);
        parseFormula(f.formula);
      } catch {
        return err(t("edit.err.formula"));
      }
      const own = f.label?.trim().toLowerCase();
      for (const r of refs) {
        const k = r.trim().toLowerCase();
        const n = numberLabels.get(k) ?? 0;
        if (n > 1) return err(t("edit.err.formulaDupLabel", { label: r }));
        if (n === 0 || own === k) return err(t("edit.err.formulaRef", { ref: `{${r}}` }));
      }
    }
  }
  return null;
}

interface Props {
  envelopeId: string;
  documents: Document[];
  /** Firmantes del sobre, o roles de la plantilla (solo se usan id y nombre). */
  signers: { id: string; name: string }[];
  fields: DraftField[];
  onChange: (fields: DraftField[]) => void;
  /** URL del PDF de cada documento (por defecto, la del sobre). */
  fileUrl?: (documentId: string) => string;
  /** Campo a seleccionar y mostrar (p. ej. el que tiene un error al guardar); `seq` repite el pedido con el mismo id. */
  focus?: { id: string; seq: number } | null;
}

type Drag =
  | { kind: "move"; id: string; startX: number; startY: number; fx: number; fy: number; rect: DOMRect }
  | { kind: "resize"; id: string; startX: number; startY: number; fw: number; fh: number; rect: DOMRect };

export function FieldEditor({ envelopeId, documents, signers, fields, onChange, fileUrl, focus }: Props) {
  const { t, tn } = useI18n();
  const [tool, setTool] = useState<FieldType | null>(null);
  const [activeRecipient, setActiveRecipient] = useState<string>(signers[0]?.id ?? "");
  const [selected, setSelected] = useState<string | null>(null);
  /** Página donde "Agregar a la página" pone el campo con el teclado (`documentId:índice`). */
  const [placeAt, setPlaceAt] = useState<string>("");
  const drag = useRef<Drag | null>(null);
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;

  useEffect(() => {
    if (!signers.find((s) => s.id === activeRecipient)) setActiveRecipient(signers[0]?.id ?? "");
  }, [signers, activeRecipient]);

  // Se borró el documento (o la página) elegido para "Agregar a la página": se vuelve a proponer la más visible, así el
  // selector y el botón muestran una página que existe.
  useEffect(() => {
    if (tool && placeAt && !isPageTarget(placeAt)) setPlaceAt(mostVisiblePage());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documents, tool, placeAt]);

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
      // Las condiciones de otros campos que citaban al borrado también se quitan: si no, el panel mostraba otro campo
      // en su lugar y "Guardar" fallaba con "la condición cita un campo que no existe".
      onChange(
        fieldsRef.current
          .filter((f) => f.id !== id)
          .map((f) => {
            if (!f.conditions?.some((c) => c.fieldId === id)) return f;
            const conditions = f.conditions.filter((c) => c.fieldId !== id);
            return { ...f, conditions: conditions.length ? conditions : null };
          }),
      );
      setSelected((s) => (s === id ? null : s));
    },
    [onChange],
  );

  // Selecciona el campo pedido por la página (error al guardar) y lo lleva a la vista con el foco.
  useEffect(() => {
    if (!focus) return;
    const f = fieldsRef.current.find((x) => x.id === focus.id);
    if (!f) return;
    setSelected(f.id);
    setActiveRecipient(f.recipientId);
    return focusBox(f.id, true);
  }, [focus]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      // Borrar solo con el foco en el campo o en la página (no en un botón, enlace u otro control del panel: Supr o
      // Retroceso sobre un botón del panel borraban el campo seleccionado).
      const onCanvas =
        !el ||
        el === document.body ||
        el === document.documentElement ||
        (!!el.closest(".editor-docs") && !el.closest("button, a, [contenteditable='true']"));
      if ((e.key === "Delete" || e.key === "Backspace") && selected && onCanvas) {
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

  const place = (doc: Document, page: number, type: FieldType, relX: number, relY: number): string | null => {
    if (!activeRecipient) return null;
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
    return f.id;
  };

  /**
   * Parte de la ventana donde se ve el documento: sin la barra superior fija (.topbar, sticky arriba) ni la barra de
   * pasos del asistente (.wizard-nav, sticky abajo), que tapan lo que queda debajo de ellas.
   */
  const visibleArea = () => {
    let top = 0;
    let bottom = window.innerHeight;
    const bar = document.querySelector<HTMLElement>(".topbar")?.getBoundingClientRect();
    if (bar && bar.bottom > top && bar.top <= 0) top = bar.bottom;
    const nav = document.querySelector<HTMLElement>(".wizard-nav")?.getBoundingClientRect();
    if (nav && nav.top < bottom && nav.top > top) bottom = nav.top;
    return { top, bottom, left: 0, right: window.innerWidth };
  };

  /** ¿`documentId:índice` es una página de los documentos actuales? (un documento borrado deja un valor viejo). */
  const isPageTarget = (target: string): boolean => {
    const i = target.lastIndexOf(":");
    const doc = documents.find((d) => d.id === target.slice(0, i));
    return Boolean(doc?.pages[Number(target.slice(i + 1))]);
  };

  /** La página con más superficie a la vista (para proponerla al agregar un campo con el teclado). */
  const mostVisiblePage = (): string => {
    let best = "";
    let bestArea = -1;
    const v = visibleArea();
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(".editor-docs .pdf-page"))) {
      const docId = el.closest<HTMLElement>(".doc-view")?.dataset.document;
      if (!docId) continue;
      const r = el.getBoundingClientRect();
      const h = Math.max(0, Math.min(r.bottom, v.bottom) - Math.max(r.top, v.top));
      const w = Math.max(0, Math.min(r.right, v.right) - Math.max(r.left, v.left));
      if (h * w > bestArea) {
        bestArea = h * w;
        best = `${docId}:${el.dataset.page ?? "0"}`;
      }
    }
    return best || (documents[0] ? `${documents[0].id}:0` : "");
  };

  /** Teclado: pone el campo de la herramienta activa en el centro de la parte visible de la página elegida. */
  const placeByKeyboard = () => {
    if (!tool) return;
    // Si la página elegida ya no existe (se borró su documento), la más visible: el botón nunca queda sin efecto.
    const target = isPageTarget(placeAt) ? placeAt : mostVisiblePage();
    const i = target.lastIndexOf(":");
    const doc = documents.find((d) => d.id === target.slice(0, i));
    const page = Number(target.slice(i + 1));
    if (!doc || !doc.pages[page]) return;
    let relX = 0.5;
    let relY = 0.5;
    const el = document.querySelector<HTMLElement>(`.editor-docs .doc-view[data-document="${CSS.escape(doc.id)}"] .pdf-page[data-page="${page}"]`);
    if (el) {
      const r = el.getBoundingClientRect();
      const v = visibleArea();
      const top = Math.max(r.top, v.top);
      const bottom = Math.min(r.bottom, v.bottom);
      const left = Math.max(r.left, v.left);
      const right = Math.min(r.right, v.right);
      if (bottom > top && right > left && r.height > 0 && r.width > 0) {
        relY = ((top + bottom) / 2 - r.top) / r.height;
        relX = ((left + right) / 2 - r.left) / r.width;
      }
    }
    const id = place(doc, page, tool, relX, relY);
    setTool(null);
    if (id) focusBox(id, true);
  };

  const onPagePointerDown = (doc: Document) => (page: number, e: RPointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return; // clic sobre un campo
    if (!tool) {
      setSelected(null);
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    const at = (x: number, y: number) => {
      place(doc, page, tool, (x - r.left) / r.width, (y - r.top) / r.height);
      setTool(null);
    };
    if (e.pointerType !== "touch") {
      at(e.clientX, e.clientY);
      return;
    }
    // Con el dedo, un pointerdown también empieza un scroll: el campo se pone recién al soltar sin haberse movido (si
    // no, deslizar para ir a otra página dejaba una firma donde empezó el gesto).
    const x0 = e.clientX;
    const y0 = e.clientY;
    const up = (ev: PointerEvent) => {
      cleanup();
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 8) at(x0, y0);
    };
    const cleanup = () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cleanup);
    };
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cleanup);
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

  // Teclado sobre un campo: Enter/Espacio lo selecciona, flechas lo mueven y Shift + flechas lo redimensionan, sin salir de la página.
  const onBoxKey = (box: DraftField) => (e: RKeyboardEvent<HTMLDivElement>) => {
    const f = fieldsRef.current.find((x) => x.id === box.id) ?? box;
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setSelected(f.id);
      setActiveRecipient(f.recipientId);
      return;
    }
    const d = ARROWS[e.key];
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    setSelected(f.id);
    const [dx, dy] = [d[0] * KEY_STEP, d[1] * KEY_STEP];
    if (e.shiftKey) update(f.id, { width: clamp(f.width + dx, MIN, 1 - f.x), height: clamp(f.height + dy, MIN, 1 - f.y) });
    else update(f.id, { x: clamp(f.x + dx, 0, 1 - f.width), y: clamp(f.y + dy, 0, 1 - f.height) });
  };

  const sel = fields.find((f) => f.id === selected) ?? null;

  if (signers.length === 0) return <div className="empty">{t("edit.noSigners")}</div>;

  return (
    <div className="editor">
      <aside className="editor-side card pad">
        <div className="field" role="group" aria-labelledby="fe-active-recipient">
          <span id="fe-active-recipient">{t("edit.activeRecipient")}</span>
          <div className="recipient-picker">
            {signers.map((s, i) => (
              <button
                key={s.id}
                type="button"
                className={`rp ${activeRecipient === s.id ? "active" : ""}`}
                aria-pressed={activeRecipient === s.id}
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
        </div>

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
              onClick={() => {
                if (tool !== ft) setPlaceAt(mostVisiblePage());
                setTool(tool === ft ? null : ft);
              }}
              aria-pressed={tool === ft}
            >
              <span className="pi-icon">{ICON[ft]}</span>
              {t(`field.${ft}`)}
            </button>
          ))}
        </div>
        {tool && <p className="hint">{t("edit.selectFieldHint")}</p>}
        {tool && (
          <div className="stack-sm">
            <label className="field">
              <span>{t("edit.placePage")}</span>
              <select value={placeAt} onChange={(e) => setPlaceAt(e.target.value)}>
                {documents.flatMap((d) =>
                  d.pages.map((_, i) => (
                    <option key={`${d.id}:${i}`} value={`${d.id}:${i}`}>
                      {documents.length > 1 ? `${d.name} — ` : ""}
                      {t("edit.pageN", { page: i + 1 })}
                    </option>
                  )),
                )}
              </select>
            </label>
            <button type="button" className="btn btn-sm" onClick={placeByKeyboard} disabled={!activeRecipient}>
              {t("edit.addToPage", { page: Number(placeAt.slice(placeAt.lastIndexOf(":") + 1) || 0) + 1 })}
            </button>
          </div>
        )}

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
                        .map((o) => o.trimStart().slice(0, 100)) // la API acepta opciones de hasta 100 caracteres
                        .slice(0, 50),
                    })
                  }
                  onBlur={(e) => {
                    const options = e.target.value
                      .split("\n")
                      .map((o) => o.trim().slice(0, 100))
                      .filter(Boolean);
                    const known = new Map(options.map((o) => [o.toLowerCase(), o]));
                    // Un valor prellenado que ya no es una opción (se renombró o quitó) quedaba oculto: el select mostraba
                    // "—" pero se mandaba igual y el guardado fallaba con "opción inválida". Con un cambio solo de
                    // mayúsculas se conserva (con la opción como se escribe ahora), igual que las condiciones: si no, el
                    // valor fijado se borraba y el campo dejaba de ser de solo lectura.
                    const prefilled = sel.value ? (known.get(sel.value.trim().toLowerCase()) ?? null) : null;
                    const stale = !!sel.value && prefilled !== sel.value;
                    // Lo mismo con las condiciones de otros campos que comparan con una opción quitada o renombrada: el
                    // select de la condición mostraba "—" pero se guardaba el valor viejo, que nunca coincide (el campo
                    // quedaba oculto para siempre). Sin valor, el guardado avisa que la condición necesita uno.
                    // Un cambio solo de mayúsculas ("si" → "Sí") sigue valiendo (la comparación no distingue), pero el valor
                    // pasa a la opción tal como se escribe ahora: si no, el select de la condición mostraba "—".
                    const fixCond = (c: FieldCondition): FieldCondition => {
                      if (c.fieldId !== sel.id || (c.operator !== "equals" && c.operator !== "not_equals") || !c.value) return c;
                      const v = known.get(c.value.trim().toLowerCase()) ?? null;
                      return v === c.value ? c : { ...c, value: v };
                    };
                    onChange(
                      fieldsRef.current.map((f) => {
                        if (f.id === sel.id)
                          return { ...f, options, ...(stale ? { value: prefilled, ...(prefilled ? {} : { readOnly: false }) } : {}) };
                        const conditions = f.conditions?.map(fixCond);
                        return conditions?.some((c, i) => c !== f.conditions![i]) ? { ...f, conditions } : f;
                      }),
                    );
                  }}
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
                    // Como en el campo de texto: sin valor deja de ser de solo lectura. Si no, la casilla quedaba oculta pero
                    // marcada y el guardado fallaba con "un campo de solo lectura necesita valor".
                    <select
                      value={sel.value ?? ""}
                      onChange={(e) => update(sel.id, { value: e.target.value || null, readOnly: e.target.value ? sel.readOnly : false })}
                    >
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
        <p className="muted small">{tn("edit.fieldsCount", fields.length)}</p>
        <p className="muted small">{t("edit.fieldKeysHint")}</p>
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
                    data-field-id={f.id}
                    tabIndex={0}
                    role="button"
                    aria-pressed={selected === f.id}
                    aria-keyshortcuts="Delete Backspace"
                    aria-label={`${t(`field.${f.type}`)}${f.label ? `: ${f.label}` : ""} — ${signers.find((s) => s.id === f.recipientId)?.name ?? ""}`}
                    onKeyDown={onBoxKey(f)}
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
                          tabIndex={-1}
                          aria-hidden="true"
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

/**
 * Lleva a la vista y enfoca el recuadro de un campo. La página puede no estar dibujada todavía (recién se abrió el
 * paso, el PDF carga o el campo se acaba de crear): se reintenta un rato. Devuelve la función que cancela.
 */
function focusBox(id: string, scroll: boolean): () => void {
  let tries = 0;
  let timer = 0;
  const show = () => {
    const el = document.querySelector<HTMLElement>(`.fbox[data-field-id="${CSS.escape(id)}"]`);
    if (el) {
      if (scroll) el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.focus({ preventScroll: true });
    } else if (++tries < 20) timer = window.setTimeout(show, 150);
  };
  timer = window.setTimeout(show, 0);
  return () => window.clearTimeout(timer);
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), Math.max(min, max));
}
