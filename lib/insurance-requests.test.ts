import assert from "node:assert/strict";
import test from "node:test";
import {
  allRequestedKindsUploaded,
  isInsuranceRequestAvailable,
  normaliseInsuranceRequestKinds,
  renderInsuranceRequestEmail,
} from "./insurance-requests.ts";

test("normaliseInsuranceRequestKinds defaults, filters and de-duplicates", () => {
  assert.deepEqual(normaliseInsuranceRequestKinds(undefined), [
    "public_liability",
    "workers_comp",
  ]);
  assert.deepEqual(
    normaliseInsuranceRequestKinds([
      "licence",
      "other",
      "professional_indemnity",
      "licence",
      "public_liability",
    ]),
    ["licence", "professional_indemnity", "public_liability"]
  );
});

test("allRequestedKindsUploaded requires every requested kind", () => {
  assert.equal(
    allRequestedKindsUploaded(
      ["public_liability", "workers_comp"],
      ["public_liability"]
    ),
    false
  );
  assert.equal(
    allRequestedKindsUploaded(
      ["public_liability", "workers_comp"],
      ["workers_comp", "public_liability"]
    ),
    true
  );
  assert.equal(allRequestedKindsUploaded([], []), false);
});

test("isInsuranceRequestAvailable respects status and expiry", () => {
  const now = new Date("2026-07-23T00:00:00Z");
  assert.equal(isInsuranceRequestAvailable("requested", "2026-07-24T00:00:00Z", now), true);
  assert.equal(isInsuranceRequestAvailable("opened", "2026-07-22T00:00:00Z", now), false);
  assert.equal(isInsuranceRequestAvailable("completed", "2026-07-24T00:00:00Z", now), false);
});

test("request email escapes contact values and contains each requested document", () => {
  const html = renderInsuranceRequestEmail({
    greetingName: "<Alex>",
    company: "A & B",
    kinds: ["public_liability", "professional_indemnity", "licence"],
    uploadUrl: "https://spec.reslu.com.au/insurance/token",
    expiresLabel: "22 August 2026",
  });
  assert.match(html, /&lt;Alex&gt;/);
  assert.match(html, /A &amp; B/);
  assert.match(html, /Public liability insurance/);
  assert.match(html, /Professional indemnity insurance/);
  assert.match(html, /Trade licence/);
  assert.doesNotMatch(html, /Workers compensation insurance/);
});
