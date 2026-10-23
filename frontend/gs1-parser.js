/**
 * VaxPass Enterprise: GS1 2D DataMatrix Pharmaceutical Barcode Parser
 *
 * Implements parsing for FDA DSCSA (Drug Supply Chain Security Act)
 * and EU FMD (Falsified Medicines Directive) packaging standards:
 * - AI (01): GTIN (Global Trade Item Number - 14 digits)
 * - AI (17): Expiration Date (YYMMDD)
 * - AI (10): Batch / Lot Number (variable length)
 * - AI (21): Serial Number (variable length)
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GS1Parser = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /**
   * Parses YYMMDD string into a JavaScript Date object and Unix timestamp.
   * Note: In GS1, day "00" represents the last day of the given month.
   */
  function parseGS1Date(yymmdd) {
    if (!yymmdd || yymmdd.length !== 6) return null;
    let year = 2000 + parseInt(yymmdd.slice(0, 2), 10);
    const month = parseInt(yymmdd.slice(2, 4), 10); // 1-12
    let day = parseInt(yymmdd.slice(4, 6), 10);

    if (day === 0) {
      // Day 00 = last day of month
      const lastDay = new Date(year, month, 0).getDate();
      day = lastDay;
    }

    const date = new Date(Date.UTC(year, month - 1, day, 23, 59, 59));
    return {
      iso: date.toISOString(),
      timestamp: Math.floor(date.getTime() / 1000),
      formatted: date.toLocaleDateString()
    };
  }

  /**
   * Parses raw barcode string (with or without brackets or GS delimiters \x1d).
   */
  function parseBarcode(rawText) {
    if (!rawText || typeof rawText !== "string") {
      return { success: false, error: "Empty or invalid barcode string" };
    }

    const text = rawText.trim();
    const result = {
      raw: text,
      gtin: null,
      lotNumber: null,
      expiryDate: null,
      serialNumber: null,
      isGS1: false
    };

    // 1. Bracket format: (01)00312345678906(17)261231(10)LOT-001(21)SN123
    if (text.includes("(") && text.includes(")")) {
      const gtinMatch = text.match(/\(01\)(\d{14})/);
      const expMatch = text.match(/\(17\)(\d{6})/);
      const lotMatch = text.match(/\(10\)([^\(\)]+)/);
      const snMatch = text.match(/\(21\)([^\(\)]+)/);

      if (gtinMatch) result.gtin = gtinMatch[1];
      if (expMatch) result.expiryDate = parseGS1Date(expMatch[1]);
      if (lotMatch) result.lotNumber = lotMatch[1].trim();
      if (snMatch) result.serialNumber = snMatch[1].trim();
      result.isGS1 = Boolean(result.gtin || result.lotNumber || result.expiryDate);
    }
    // 2. FNC1 delimiter format (ASCII 29 / \x1d)
    else if (text.startsWith("01") && text.length >= 16) {
      result.isGS1 = true;
      result.gtin = text.slice(2, 16);
      let remainder = text.slice(16);

      // Look for AI 17 (Expiry)
      if (remainder.startsWith("17") && remainder.length >= 8) {
        result.expiryDate = parseGS1Date(remainder.slice(2, 8));
        remainder = remainder.slice(8);
      }

      // Look for AI 10 (Lot)
      if (remainder.startsWith("10")) {
        const parts = remainder.slice(2).split(/\x1d/);
        result.lotNumber = parts[0];
      }
    }
    // 3. Fallback: Simple LOT or Batch ID string (e.g., "VX001" or "LOT-2026-01")
    else {
      result.lotNumber = text;
      result.isGS1 = false;
    }

    return {
      success: true,
      ...result,
      summary: result.isGS1
        ? `GS1 Validated · Lot: ${result.lotNumber || "N/A"} · Exp: ${result.expiryDate?.formatted || "N/A"}`
        : `Scanned Text: ${text}`
    };
  }

  /**
   * Helper to generate standard mock GS1 DataMatrix strings for testing.
   */
  function generateMockGS1({
    gtin = "00312345678906",
    lotNumber = "LOT-2026-COV01",
    expiryYYMMDD = "261231",
    serialNumber = "SN987654321"
  }) {
    return `(01)${gtin}(17)${expiryYYMMDD}(10)${lotNumber}(21)${serialNumber}`;
  }

  return {
    parseBarcode,
    parseGS1Date,
    generateMockGS1
  };
});
