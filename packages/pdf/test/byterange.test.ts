import { describe, expect, it } from "vitest";
import { byteRangeIssue } from "../src/signatures";

const pdf = new Uint8Array(Buffer.from("%PDF-AAAA<00ab>BBBB", "latin1"));

describe("byteRangeIssue", () => {
  it("acepta el hueco exacto de /Contents", () => {
    expect(byteRangeIssue(pdf, [0, 9, 15, 4])).toBeNull();
  });
  it("rechaza un ByteRange corrido, fuera del archivo o que no empieza en 0", () => {
    expect(byteRangeIssue(pdf, [0, 8, 15, 4])).toMatch(/Contents/);
    expect(byteRangeIssue(pdf, [0, 9, 15, 10])).toMatch(/fuera/);
    expect(byteRangeIssue(pdf, [1, 8, 15, 4])).toMatch(/principio/);
    expect(byteRangeIssue(new Uint8Array(Buffer.from("%PDF-AAAA<0Xab>BBBB", "latin1")), [0, 9, 15, 4])).toMatch(/algo más/);
  });
  it("rechaza un hueco que no es el /Contents de la firma", () => {
    // El hueco <00ab> es una cadena hexadecimal válida, pero la firma de este diccionario es otra (por ejemplo un
    // texto visible excluido de lo firmado).
    expect(byteRangeIssue(pdf, [0, 9, 15, 4], new Uint8Array([0x00, 0xab]))).toBeNull();
    expect(byteRangeIssue(pdf, [0, 9, 15, 4], new Uint8Array([0x30, 0x82]))).toMatch(/no corresponde/);
  });

  // Casos agregados a partir de los mutantes que sobrevivían (scripts/mutacion.sh, 2026-10-29): cada borde de las
  // condiciones de byteRangeIssue tiene que estar probado, porque un ByteRange mal validado deja bytes sin firmar.
  it("rechaza valores que no son enteros no negativos", () => {
    for (const br of [
      [-1, 9, 15, 4],
      [0, -9, 15, 4],
      [0, 9, -15, 4],
      [0, 9, 15, -4],
      [0, 9.5, 15, 4],
      [0, 9, Number.NaN, 4],
      [0, 9, 15, Number.POSITIVE_INFINITY],
    ] as [number, number, number, number][]) {
      expect(byteRangeIssue(pdf, br), String(br)).toMatch(/inválidos/);
    }
  });

  it("los límites del archivo: el segundo tramo puede terminar justo al final, no un byte después", () => {
    expect(byteRangeIssue(pdf, [0, 9, 15, pdf.length - 15])).toBeNull();
    expect(byteRangeIssue(pdf, [0, 9, 15, pdf.length - 14])).toMatch(/fuera/);
    // El hueco más chico posible es "<>": c = a + b + 2. Uno menos ya no deja lugar para los delimitadores.
    const vacio = new Uint8Array(Buffer.from("%PDF-AAAA<>BBBB", "latin1"));
    expect(byteRangeIssue(vacio, [0, 9, 11, 4])).toBeNull();
    expect(byteRangeIssue(vacio, [0, 9, 10, 5])).toMatch(/fuera/);
  });

  it("el hueco tiene que abrir con < y cerrar con >, por separado", () => {
    const sinAbrir = new Uint8Array(Buffer.from("%PDF-AAAA(00ab>BBBB", "latin1"));
    const sinCerrar = new Uint8Array(Buffer.from("%PDF-AAAA<00ab)BBBB", "latin1"));
    expect(byteRangeIssue(sinAbrir, [0, 9, 15, 4])).toMatch(/Contents/);
    expect(byteRangeIssue(sinCerrar, [0, 9, 15, 4])).toMatch(/Contents/);
  });

  it("acepta cada extremo de los rangos hexadecimales y rechaza el carácter vecino de cada uno", () => {
    const conHueco = (hex: string) => new Uint8Array(Buffer.from(`%PDF-AAAA<${hex}>BBBB`, "latin1"));
    const br = (hex: string): [number, number, number, number] => [0, 9, 11 + hex.length, 4];
    for (const ok of ["09", "AF", "af", "0aF9"]) expect(byteRangeIssue(conHueco(ok), br(ok)), ok).toBeNull();
    // '/' y ':' rodean a 0-9; '@' y 'G' a A-F; '`' y 'g' a a-f.
    for (const bad of ["/0", "9:", "@A", "FG", "`a", "fg"]) expect(byteRangeIssue(conHueco(bad), br(bad)), bad).toMatch(/algo más/);
  });

  it("con la firma: rechaza un hueco de largo impar y uno más corto que la firma; acepta el relleno con ceros", () => {
    const conHueco = (hex: string) => new Uint8Array(Buffer.from(`%PDF-AAAA<${hex}>BBBB`, "latin1"));
    const br = (hex: string): [number, number, number, number] => [0, 9, 11 + hex.length, 4];
    const firma = new Uint8Array([0x30, 0x82]);
    expect(byteRangeIssue(conHueco("3082000"), br("3082000"), firma)).toMatch(/no es el valor/);
    expect(byteRangeIssue(conHueco("30"), br("30"), firma)).toMatch(/no corresponde/);
    // El /Contents reservado es más largo que la firma y se rellena con ceros: es lo normal.
    expect(byteRangeIssue(conHueco("30820000"), br("30820000"), firma)).toBeNull();
    expect(byteRangeIssue(conHueco("3082"), br("3082"), firma)).toBeNull();
  });
});
