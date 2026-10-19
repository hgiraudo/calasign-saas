// Panel de lógica del campo seleccionado (Fase 4): condiciones de visibilidad y fórmula de campos número.
import type { ConditionOperator, FieldCondition } from "@calasign/shared";
import { useI18n } from "../lib/i18n";
import { useScaleText } from "../lib/i18n-scale";
import type { DraftField } from "./FieldEditor";

/** Tipos que pueden ser origen de una condición (tienen un valor que el firmante elige o escribe). */
const SOURCE_TYPES = ["checkbox", "dropdown", "text", "number", "company", "title", "attachment"];

function operatorsFor(type: string): ConditionOperator[] {
  if (type === "checkbox") return ["checked", "unchecked"];
  if (type === "dropdown") return ["equals", "not_equals", "filled"];
  if (type === "attachment") return ["filled"];
  return ["filled", "equals", "not_equals"];
}

export function FieldLogicPanel({
  field,
  fields,
  signers,
  onChange,
}: {
  field: DraftField;
  fields: DraftField[];
  signers: { id: string; name: string }[];
  onChange: (patch: Partial<DraftField>) => void;
}) {
  const { t } = useI18n();
  const st = useScaleText();
  const conditions = field.conditions ?? [];
  const sources = fields.filter((f) => f.id !== field.id && SOURCE_TYPES.includes(f.type));
  const describe = (f: DraftField) => {
    const who = signers.find((s) => s.id === f.recipientId)?.name ?? "";
    return `${f.label || `${t(`field.${f.type}`)} (${st("logic.unnamed")})`} — ${who}`;
  };
  const setConds = (next: FieldCondition[]) => onChange({ conditions: next.length ? next : null });
  const numberLabels = [...new Set(fields.filter((f) => f.type === "number" && f.id !== field.id && f.label).map((f) => f.label as string))];

  return (
    <div className="logic-panel">
      <p className="logic-title">
        <strong>{st("logic.title")}</strong>
      </p>

      <div className="field">
        <span>{st("logic.showIf")}</span>
        {conditions.length === 0 && <small className="muted">{st("logic.always")}</small>}
        {conditions.map((c, i) => {
          const src = fields.find((f) => f.id === c.fieldId);
          const ops = operatorsFor(src?.type ?? "text");
          const needsValue = c.operator === "equals" || c.operator === "not_equals";
          const patch = (p: Partial<FieldCondition>) => setConds(conditions.map((x, j) => (j === i ? { ...x, ...p } : x)));
          return (
            <div key={i} className="logic-cond">
              <select
                aria-label={st("logic.field")}
                value={c.fieldId}
                onChange={(e) => {
                  const nf = fields.find((f) => f.id === e.target.value);
                  const nops = operatorsFor(nf?.type ?? "text");
                  patch({ fieldId: e.target.value, operator: nops.includes(c.operator) ? c.operator : nops[0], value: null });
                }}
              >
                {sources.map((f) => (
                  <option key={f.id} value={f.id}>
                    {describe(f)}
                  </option>
                ))}
              </select>
              <div className="logic-cond-row">
                <select aria-label={st("logic.operator")} value={c.operator} onChange={(e) => patch({ operator: e.target.value as ConditionOperator })}>
                  {ops.map((o) => (
                    <option key={o} value={o}>
                      {st(`logic.op.${o}` as "logic.op.equals")}
                    </option>
                  ))}
                </select>
                {needsValue &&
                  (src?.type === "dropdown" ? (
                    <select aria-label={st("logic.value")} value={c.value ?? ""} onChange={(e) => patch({ value: e.target.value })}>
                      <option value="">—</option>
                      {(src.options ?? []).filter(Boolean).map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input aria-label={st("logic.value")} placeholder={st("logic.value")} value={c.value ?? ""} maxLength={200} onChange={(e) => patch({ value: e.target.value })} />
                  ))}
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConds(conditions.filter((_, j) => j !== i))} aria-label={st("logic.remove")}>
                  ×
                </button>
              </div>
            </div>
          );
        })}
        {sources.length === 0 ? (
          <small className="muted">{st("logic.noOtherFields")}</small>
        ) : (
          conditions.length < 10 && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                const s0 = sources[0];
                setConds([...conditions, { fieldId: s0.id, operator: operatorsFor(s0.type)[0], value: null }]);
              }}
            >
              {st("logic.addCondition")}
            </button>
          )
        )}
        {conditions.length > 0 && <small className="muted">{st("logic.allMustMatch")}</small>}
      </div>

      {field.type === "number" && (
        <label className="field">
          <span>{st("logic.formula")}</span>
          <input
            value={field.formula ?? ""}
            maxLength={500}
            placeholder="{Precio} * {Cantidad}"
            // Solo espacios cuenta como sin fórmula (la API rechaza una fórmula vacía).
            onChange={(e) => {
              const v = e.target.value;
              onChange({ formula: v.trim() ? v : null, ...(v.trim() ? { readOnly: false, value: null, required: false } : {}) });
            }}
          />
          <small className="muted">{numberLabels.length ? st("logic.formulaHint") : st("logic.formulaNeedsLabels")}</small>
          {numberLabels.length > 0 && (
            <div className="chips">
              {numberLabels.map((l) => (
                <button key={l} type="button" className="chip chip-btn" onClick={() => onChange({ formula: `${field.formula ?? ""}{${l}}`, readOnly: false, value: null, required: false })}>
                  {st("logic.insert")} {`{${l}}`}
                </button>
              ))}
            </div>
          )}
        </label>
      )}
    </div>
  );
}
