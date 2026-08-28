import assert from "node:assert/strict";
import test from "node:test";
import {
  assertItemCanBeLinked,
  chooseExactEmailContact,
  mergeVerifiedContactNotes,
  normalizeContactItemLinkInput,
} from "./contact-item-link.mjs";

const input = normalizeContactItemLinkInput({
  project_id: "hone-project",
  item_id: "cp-01-item",
  item_code: "cp-01",
  company: "Zappia Flooring",
  contact_name: "Michael Zanker",
  email: " Michael@ZappiaFlooring.com.au ",
  phone: "08 8373 1414",
  mobile: "0466 440 028",
  address: "182 Goodwood Rd, Millswood SA 5034",
});

test("normalises the verified Hone supplier details", () => {
  assert.equal(input.email, "michael@zappiaflooring.com.au");
  assert.equal(input.item_code, "CP-01");
  assert.equal(input.category, "Flooring");
});

test("reuses exactly one active email match and rejects duplicates", () => {
  assert.equal(chooseExactEmailContact([{ id: "c1", email: input.email, deleted_at: null }], input.email).id, "c1");
  assert.throws(() => chooseExactEmailContact([
    { id: "c1", email: input.email, deleted_at: null },
    { id: "c2", email: input.email.toUpperCase(), deleted_at: null },
  ], input.email), /Multiple active contacts/);
});

test("keeps unrelated notes while refreshing structured mobile and address lines", () => {
  assert.equal(
    mergeVerifiedContactNotes("Preferred supplier\nMobile: old\nAddress: old", input),
    "Preferred supplier\nMobile: 0466 440 028\nAddress: 182 Goodwood Rd, Millswood SA 5034",
  );
});

test("allows a missing or matching link but never silently replaces another supplier", () => {
  assert.doesNotThrow(() => assertItemCanBeLinked({ project_id: input.project_id, item_code: input.item_code, supplier_contact_id: null }, input, "c1"));
  assert.doesNotThrow(() => assertItemCanBeLinked({ project_id: input.project_id, item_code: input.item_code, supplier_contact_id: "c1" }, input, "c1"));
  assert.throws(() => assertItemCanBeLinked({ project_id: input.project_id, item_code: input.item_code, supplier_contact_id: "other" }, input, "c1"), /different supplier/);
});
