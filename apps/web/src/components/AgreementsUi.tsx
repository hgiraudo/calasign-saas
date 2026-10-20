// Piezas compartidas de la sección Acuerdos: pestañas, vista previa de documentos y diff.
import { Fragment, useRef, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import type { DiffPart, ResolvedBlock, Run } from "@calasign/shared";
import { useAgrText } from "../lib/i18n-agreements";

type AgrText = ReturnType<typeof useAgrText>;

export function AgreementsTabs() {
  const ta = useAgrText();
  const tabs: [string, string][] = [
    ["/app/agreements", ta("tab.repository")],
    ["/app/documents", ta("tab.documents")],
    ["/app/clauses", ta("tab.clauses")],
    ["/app/workflows", ta("tab.workflows")],
    ["/app/negotiations", ta("tab.negotiations")],
  ];
  return (
    <nav className="agr-tabs" aria-label={ta("nav.agreements")}>
      {tabs.map(([to, label]) => (
        <NavLink key={to} to={to} className={({ isActive }) => (isActive ? "active" : "")}>
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

/** Texto de cada marca (no un emoji suelto: el lector de pantalla leía "pluma estilográfica" o "calendario"). */
const MARK_KEY = { signature: "mark.signature", initials: "mark.initials", date: "mark.date", name: "mark.name" } as const;

function runs(rs: Run[], ta: AgrText): ReactNode {
  return rs.map((r, i) => {
    if ("br" in r) return <br key={i} />;
    if ("mark" in r) {
      const label = `${ta(MARK_KEY[r.mark])}: ${r.role}`;
      return (
        <span key={i} className={`agr-mark agr-mark-${r.mark}`} role="img" aria-label={label} title={label}>
          {label}
        </span>
      );
    }
    let node: ReactNode = r.text;
    if (r.i) node = <em>{node}</em>;
    if (r.b) node = <strong>{node}</strong>;
    return <Fragment key={i}>{node}</Fragment>;
  });
}

const BLOCK_SELECTOR = "p,li,h2,h3,h4,th,td";

/**
 * Texto en pantalla desde el principio de `root` hasta (node, offset), con un espacio entre bloques y en cada <br>:
 * Range.toString() los pega ("fin.Inicio"), mientras que el texto plano los separa con saltos.
 */
function textBefore(root: HTMLElement, node: Node, offset: number): string {
  const end = document.createRange();
  end.setStart(node, offset);
  let out = "";
  let lastBlock: Element | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (end.comparePoint(n, 0) > 0) break;
    if (n.nodeType === Node.ELEMENT_NODE) {
      if ((n as Element).tagName === "BR") out += " ";
      continue;
    }
    const block = n.parentElement?.closest(BLOCK_SELECTOR) ?? null;
    if (block !== lastBlock) {
      out += " ";
      lastBlock = block;
    }
    const text = n.textContent ?? "";
    out += n === node ? text.slice(0, offset) : text;
  }
  return out;
}

/**
 * Documento renderizado como HTML (los valores siempre como texto: React escapa).
 * Con `onSelect`, informa el texto seleccionado y su posición en el texto plano del documento.
 */
export function DocPreview({
  blocks,
  text,
  onSelect,
}: {
  blocks: ResolvedBlock[];
  text?: string;
  onSelect?: (sel: { quote: string; start: number | null; end: number | null } | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const ta = useAgrText();
  const handleUp = () => {
    if (!onSelect) return;
    const sel = window.getSelection();
    const quote = sel?.toString().replace(/\s+/g, " ").trim() ?? "";
    if (!sel || !quote || !ref.current?.contains(sel.anchorNode)) return onSelect(null);
    // Posición en el texto original (no en el de espacios colapsados: después de cada salto de párrafo los índices
    // quedaban corridos). Si la cita aparece varias veces, vale la más cercana a donde está la selección en pantalla.
    const src = text ?? "";
    const words = quote.split(" ").map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const re = new RegExp(words.join("\\s+"), "g");
    // Cuántas veces aparece la cita en pantalla antes de la selección: vale la aparición con ese mismo número en el texto.
    // Comparar largos no servía: el texto plano tiene saltos entre bloques, viñetas ("• ", "1. "), " | " entre celdas y
    // "[Firma: …]" que la vista no tiene, y en un contrato largo la diferencia acumulada (cientos de caracteres) hacía
    // anclar el comentario en otra aparición de un término repetido.
    let ordinal = 0;
    try {
      const s = sel.getRangeAt(0);
      // Con separadores entre bloques (como el texto plano) se puede exigir espacio entre palabras igual que en `re`:
      // con \s* sobre el texto pegado, "por que" contaba también cada "porque" anterior y el comentario quedaba en otra
      // aparición.
      ordinal = [...textBefore(ref.current, s.startContainer, s.startOffset).matchAll(re)].length;
    } catch {
      /* sin rango: la primera aparición */
    }
    const all = [...src.matchAll(re)];
    const m = all[Math.min(ordinal, all.length - 1)];
    const best = m ? { start: m.index, end: m.index + m[0].length } : null;
    // Si la selección no aparece tal cual en el texto plano (p. ej. cruza celdas de una tabla), se comenta la cita sin
    // posición: antes quedaba anclada en 0…largo, es decir, al principio del documento.
    if (!best) return onSelect({ quote: quote.slice(0, 2000), start: null, end: null });
    onSelect({ quote: quote.slice(0, 2000), start: best.start, end: best.end });
  };
  return (
    <div className="agr-doc" ref={ref} onMouseUp={handleUp} onKeyUp={handleUp}>
      {blocks.length === 0 && <p className="muted small">—</p>}
      {blocks.map((b, i) => {
        if (b.type === "heading") {
          const H = (`h${b.level + 1}` as "h2" | "h3" | "h4");
          return <H key={i}>{runs(b.runs, ta)}</H>;
        }
        if (b.type === "paragraph") return <p key={i}>{runs(b.runs, ta)}</p>;
        if (b.type === "list") {
          // Una lista numerada que empieza en otro número ("3. …") lo conserva, como en el PDF.
          if (b.ordered)
            return (
              <ol key={i} start={b.start}>
                {b.items.map((it, j) => (
                  <li key={j}>{runs(it, ta)}</li>
                ))}
              </ol>
            );
          return (
            <ul key={i}>
              {b.items.map((it, j) => (
                <li key={j}>{runs(it, ta)}</li>
              ))}
            </ul>
          );
        }
        if (b.type === "table")
          return (
            <div key={i} className="agr-table-wrap">
              <table>
                {b.header && (
                  <thead>
                    <tr>
                      {b.header.map((c, j) => (
                        <th key={j}>{runs(c, ta)}</th>
                      ))}
                    </tr>
                  </thead>
                )}
                <tbody>
                  {b.rows.map((r, j) => (
                    <tr key={j}>
                      {r.map((c, k) => (
                        <td key={k}>{runs(c, ta)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        return <hr key={i} className="agr-pagebreak" />;
      })}
    </div>
  );
}

export function DiffView({ parts }: { parts: DiffPart[] }) {
  return (
    <div className="agr-diff" aria-live="polite">
      {parts.map((p, i) =>
        p.op === "eq" ? (
          <span key={i}>{p.text}</span>
        ) : p.op === "ins" ? (
          <ins key={i}>{p.text}</ins>
        ) : (
          <del key={i}>{p.text}</del>
        ),
      )}
    </div>
  );
}

/** Textarea con valor JSON: devuelve el objeto o null si no es válido. */
export function parseJsonObject(s: string): Record<string, unknown> | null {
  if (!s.trim()) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
