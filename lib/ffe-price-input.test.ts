import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFfePriceInput } from "./ffe-price-input.ts";

test("normalizes a GST-inclusive supplier price to the ex-GST estimate basis", () => {
  assert.deepEqual(normalizeFfePriceInput("110.00", true), {
    priceRrpExGst: 100,
    error: null,
  });
});

test("keeps an explicitly ex-GST price unchanged", () => {
  assert.deepEqual(normalizeFfePriceInput("123.45", false), {
    priceRrpExGst: 123.45,
    error: null,
  });
});

test("distinguishes a deliberate blank from an invalid non-positive price", () => {
  assert.deepEqual(normalizeFfePriceInput("", true), {
    priceRrpExGst: null,
    error: null,
  });
  assert.match(normalizeFfePriceInput("0", true).error ?? "", /greater than \$0/i);
  assert.match(normalizeFfePriceInput("not money", true).error ?? "", /greater than \$0/i);
});
