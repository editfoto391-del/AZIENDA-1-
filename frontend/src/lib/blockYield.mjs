const WHITE_BLOCK_EXPECTED_YIELD = Object.freeze({
  "910x100": 39,
  "1070x100": 26,
  "1070x120": 22,
  "760x100": 39,
});

const normalizeBlockSize = (size) => String(size || "")
  .trim()
  .replace(/\s+/g, "")
  .replace(/[×X]/g, "x");

export function expectedWhiteBlockYield(block, size) {
  if (String(block || "").trim().toLowerCase() !== "white") return null;
  return WHITE_BLOCK_EXPECTED_YIELD[normalizeBlockSize(size)] ?? null;
}

export function assessBlockYield(block, size, actualPieces) {
  const expectedPieces = expectedWhiteBlockYield(block, size);
  if (expectedPieces == null) {
    return { expectedPieces: null, actualPieces: Number(actualPieces) || 0, missingPieces: null, lossAlert: false };
  }
  const actual = Number(actualPieces);
  const validActual = Number.isFinite(actual) && actual >= 0 ? actual : 0;
  const missingPieces = Math.max(0, expectedPieces - validActual);
  return {
    expectedPieces,
    actualPieces: validActual,
    missingPieces,
    lossAlert: validActual < expectedPieces,
  };
}