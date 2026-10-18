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
});
