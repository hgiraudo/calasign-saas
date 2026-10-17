// Lectura de las firmas de un PDF: campos /FT /Sig del AcroForm (incluye sellos de documento) y el /DSS.
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFString, decodePDFRawStream } from "pdf-lib";
import { trimDer } from "./pki";

export interface PdfSignature {
  fieldName: string | null;
  type: "Sig" | "DocTimeStamp";
  subFilter: string | null;
  byteRange: [number, number, number, number];
  contents: Uint8Array;
  signingTimeM: string | null;
  name: string | null;
  reason: string | null;
}

export interface PdfDss {
  certs: Uint8Array[];
  ocsps: Uint8Array[];
  crls: Uint8Array[];
}

function str(o: unknown): string | null {
  if (o instanceof PDFString || o instanceof PDFHexString) return o.decodeText();
  if (o instanceof PDFName) return o.decodeText();
  return null;
}

function collectFields(doc: PDFDocument, arr: PDFArray | undefined, out: PDFDict[]) {
  if (!arr) return;
  for (const r of arr.asArray()) {
    const f = doc.context.lookup(r);
    if (!(f instanceof PDFDict)) continue;
    out.push(f);
    collectFields(doc, f.lookupMaybe(PDFName.of("Kids"), PDFArray), out);
  }
}

function pdfDateToIso(s: string | null): string | null {
  if (!s) return null;
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Z+-])?(\d{2})?'?(\d{2})?/.exec(s);
  if (!m) return null;
  const [, y, mo = "01", d = "01", h = "00", mi = "00", se = "00", z, oh = "00", om = "00"] = m;
  const off = !z || z === "Z" ? "Z" : `${z}${oh}:${om}`;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${se}${off}`);
  return isNaN(date.getTime()) ? null : date.toISOString();
}

export async function readPdfSignatures(pdf: Uint8Array): Promise<{ signatures: PdfSignature[]; dss: PdfDss | null }> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false, ignoreEncryption: true });
  const acro = doc.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict);
  const fields: PDFDict[] = [];
  collectFields(doc, acro?.lookupMaybe(PDFName.of("Fields"), PDFArray), fields);
  const signatures: PdfSignature[] = [];
  const seen = new Set<string>();
  for (const f of fields) {
    if (f.lookupMaybe(PDFName.of("FT"), PDFName)?.decodeText() !== "Sig") continue;
    const vRaw = f.get(PDFName.of("V"));
    const v = vRaw instanceof PDFRef ? doc.context.lookup(vRaw) : vRaw;
    if (!(v instanceof PDFDict)) continue;
    const br = v.lookupMaybe(PDFName.of("ByteRange"), PDFArray);
    const contents = v.get(PDFName.of("Contents"));
    if (!br || !(contents instanceof PDFHexString)) continue;
    const nums = br.asArray().map((n) => (n instanceof PDFNumber ? n.asNumber() : NaN));
    if (nums.length !== 4 || nums.some(isNaN)) continue;
    const key = nums.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    let raw: Uint8Array;
    try {
      raw = trimDer(contents.asBytes());
    } catch {
      raw = contents.asBytes();
    }
    signatures.push({
      fieldName: str(f.get(PDFName.of("T"))),
      type: v.lookupMaybe(PDFName.of("Type"), PDFName)?.decodeText() === "DocTimeStamp" ? "DocTimeStamp" : "Sig",
      subFilter: v.lookupMaybe(PDFName.of("SubFilter"), PDFName)?.decodeText() ?? null,
      byteRange: nums as [number, number, number, number],
      contents: raw,
      signingTimeM: pdfDateToIso(str(v.get(PDFName.of("M")))),
      name: str(v.get(PDFName.of("Name"))),
      reason: str(v.get(PDFName.of("Reason"))),
    });
  }
  signatures.sort((a, b) => a.byteRange[2] + a.byteRange[3] - (b.byteRange[2] + b.byteRange[3]));

  const dssDict = doc.catalog.lookupMaybe(PDFName.of("DSS"), PDFDict);
  let dss: PdfDss | null = null;
  if (dssDict) {
    const streams = (key: string) =>
      (dssDict.lookupMaybe(PDFName.of(key), PDFArray)?.asArray() ?? [])
        .map((r) => doc.context.lookup(r))
        .filter((s): s is PDFRawStream => s instanceof PDFRawStream)
        .map((s) => decodePDFRawStream(s).decode());
    dss = { certs: streams("Certs"), ocsps: streams("OCSPs"), crls: streams("CRLs") };
  }
  return { signatures, dss };
}

/** Bytes cubiertos por un ByteRange. */
export function signedContent(pdf: Uint8Array, br: [number, number, number, number]): Uint8Array {
  const [a, b, c, d] = br;
  return new Uint8Array(Buffer.concat([Buffer.from(pdf.subarray(a, a + b)), Buffer.from(pdf.subarray(c, c + d))]));
}
