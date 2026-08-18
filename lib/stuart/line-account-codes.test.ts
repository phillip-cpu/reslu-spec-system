import assert from "node:assert/strict";
import test from "node:test";
import { resolveLineAccountCodes } from "./line-account-codes.ts";

test("requires an exact account mapping for every supplier source line", () => {
  const result = resolveLineAccountCodes(
    [{ sort: 0 }, { sort: 1 }, { sort: 2 }],
    undefined,
    [
      { line_sort: 0, account_code: "310" },
      { line_sort: 1, account_code: "310" },
      { line_sort: 2, account_code: "445" },
    ],
  );
  assert.deepEqual(result.auditMappings, [
    { line_sort: 0, account_code: "310" },
    { line_sort: 1, account_code: "310" },
    { line_sort: 2, account_code: "445" },
  ]);
  assert.equal(result.auditAccountCode, "310,445");
  assert.equal(result.accountCodeBySort.get(2), "445");
});

test("rejects partial, duplicate and mixed account strategies", () => {
  assert.throws(
    () => resolveLineAccountCodes([{ sort: 0 }, { sort: 1 }], undefined, [{ line_sort: 0, account_code: "310" }]),
    /exactly one account code/,
  );
  assert.throws(
    () => resolveLineAccountCodes([{ sort: 0 }], "310", [{ line_sort: 0, account_code: "445" }]),
    /either one account code or a line-by-line/,
  );
});

test("retains the single-code path for ordinary supplier invoices", () => {
  const result = resolveLineAccountCodes([{ sort: 0 }, { sort: 1 }], "310");
  assert.deepEqual(result.auditMappings, [
    { line_sort: 0, account_code: "310" },
    { line_sort: 1, account_code: "310" },
  ]);
});
