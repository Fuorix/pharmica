import { describe, expect, it } from "vitest";
import { gtinCheckDigitValid, parseGs1 } from "./gs1";

const GS = "\u001d";
// GTIN 08964000000014 has a valid check digit (4).
const GTIN = "08964000000014";

describe("parseGs1", () => {
  it("reads the bracketed form", () => {
    expect(parseGs1(`(01)${GTIN}(17)271231(10)AB1234(21)SN000987`)).toEqual({
      gtin: GTIN, barcode: "8964000000014", expiryDate: "2027-12-31", batchNo: "AB1234", serialNumber: "SN000987", complete: true, warnings: []
    });
  });

  it("reads raw scanner output with group separators, in any field order", () => {
    expect(parseGs1(`]d201${GTIN}10AB-12/3${GS}21XYZ998${GS}17280600`)).toMatchObject({ batchNo: "AB-12/3", serialNumber: "XYZ998", expiryDate: "2028-06-30", complete: true });
  });

  it("treats day 00 as the end of the month, including leap years", () => {
    expect(parseGs1(`(01)${GTIN}(17)280200(10)B1`).expiryDate).toBe("2028-02-29");
  });

  it("asks for a check when the scanner dropped the separator between batch and serial", () => {
    const scan = parseGs1(`01${GTIN}17271231` + `10AB1234` + `21SN000987`);
    expect(scan.complete).toBe(false);
    expect(scan.warnings.join(" ")).toContain("run together");
  });

  it("flags a bad GTIN and an impossible expiry", () => {
    const scan = parseGs1("(01)08964000000017(17)271340(10)B1");
    expect(scan.complete).toBe(false);
    expect(scan.warnings).toEqual(expect.arrayContaining([expect.stringContaining("GTIN"), expect.stringContaining("expiry")]));
  });

  it("recognises a plain 1D barcode and asks for batch and expiry", () => {
    expect(parseGs1("8964000000014")).toMatchObject({ barcode: "8964000000014", complete: false });
    expect(parseGs1("8964000000014").warnings[0]).toContain("1D barcode");
  });

  it("validates check digits", () => {
    expect(gtinCheckDigitValid("2000000000015")).toBe(true);
    expect(gtinCheckDigitValid("2000000000016")).toBe(false);
  });
});
