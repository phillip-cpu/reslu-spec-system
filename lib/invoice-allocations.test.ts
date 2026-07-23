import assert from "node:assert/strict";
import test from "node:test";
import {
  invoiceAllocationBalance,
  validateInvoiceAllocations,
} from "./invoice-allocations.ts";

test("accepts a split that exactly matches the invoice in cents", () => {
  const result = validateInvoiceAllocations(
    [
      { match_type: "cost_line", match_id: "floor", amount_ex_gst: 260 },
      { match_type: "cost_line", match_id: "jamb", amount_ex_gst: 108 },
      { match_type: "cost_line", match_id: "tarp", amount_ex_gst: 50 },
      { match_type: "cost_line", match_id: "consumables", amount_ex_gst: 186.65 },
    ],
    604.65
  );

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.allocated_cents, 60_465);
});

test("rejects under- and over-allocation", () => {
  const under = validateInvoiceAllocations(
    [{ match_type: "cost_line", match_id: "floor", amount_ex_gst: 604.64 }],
    604.65
  );
  const over = validateInvoiceAllocations(
    [{ match_type: "cost_line", match_id: "floor", amount_ex_gst: 604.66 }],
    604.65
  );

  assert.deepEqual(under, {
    ok: false,
    error: "Allocations are under the invoice total by $0.01",
  });
  assert.deepEqual(over, {
    ok: false,
    error: "Allocations are over the invoice total by $0.01",
  });
});

test("rejects duplicate matches and invalid zero amounts", () => {
  const duplicate = validateInvoiceAllocations(
    [
      { match_type: "cost_line", match_id: "same", amount_ex_gst: 300 },
      { match_type: "cost_line", match_id: "same", amount_ex_gst: 304.65 },
    ],
    604.65
  );
  const zero = validateInvoiceAllocations(
    [{ match_type: "item", match_id: "item", amount_ex_gst: 0 }],
    604.65
  );

  assert.equal(duplicate.ok, false);
  assert.equal(zero.ok, false);
});

test("allows separate supplier lines to share a project target", () => {
  const result = validateInvoiceAllocations(
    [
      { source_line_id: "tape", match_type: "cost_line", match_id: "consumables", amount_ex_gst: 36.79 },
      { source_line_id: "film", match_type: "cost_line", match_id: "consumables", amount_ex_gst: 88.62 },
    ],
    125.41
  );

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.allocations[1].source_line_id, "film");
});

test("accepts assembly components as invoice destinations", () => {
  const result = validateInvoiceAllocations(
    [
      {
        source_line_id: "source-trim",
        match_type: "item_component",
        match_id: "component-trim",
        amount_ex_gst: 79.55,
        apply_to_library_cost: true,
      },
      {
        source_line_id: "source-body",
        match_type: "item_component",
        match_id: "component-body",
        amount_ex_gst: 54.09,
        apply_to_library_cost: true,
      },
    ],
    133.64
  );
  assert.equal(result.ok, true);
});

test("rejects allocating the same supplier line twice", () => {
  const result = validateInvoiceAllocations(
    [
      { source_line_id: "same", match_type: "cost_line", match_id: "one", amount_ex_gst: 40 },
      { source_line_id: "same", match_type: "cost_line", match_id: "two", amount_ex_gst: 60 },
    ],
    100
  );
  assert.equal(result.ok, false);
});

test("reports the live allocation balance without floating point drift", () => {
  assert.equal(
    invoiceAllocationBalance(604.65, [
      { amount_ex_gst: 260 },
      { amount_ex_gst: 108 },
      { amount_ex_gst: 50 },
    ]),
    186.65
  );
});

test("allows an explicit empty allocation set only when clearing a draft", () => {
  assert.equal(validateInvoiceAllocations([], 604.65).ok, false);
  assert.deepEqual(validateInvoiceAllocations([], 604.65, { allowEmpty: true }), {
    ok: true,
    allocations: [],
    allocated_cents: 0,
  });
});
