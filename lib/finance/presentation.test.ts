import assert from "node:assert/strict";
import test from "node:test";
import { dollarsInputToMinor, formatMinorCurrency } from "./presentation.ts";

test("money presentation preserves cent-exact user input", () => {
  assert.equal(dollarsInputToMinor("$1,234.56"), 123456);
  assert.equal(dollarsInputToMinor("-42.10"), -4210);
  assert.equal(dollarsInputToMinor("12.345"), null);
  assert.equal(dollarsInputToMinor(""), null);
  assert.match(formatMinorCurrency(123456), /1,235/);
  assert.equal(formatMinorCurrency(-0), "$0");
});
