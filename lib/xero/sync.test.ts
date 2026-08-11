import assert from "node:assert/strict";
import test from "node:test";
import { xeroDate, xeroTimestamp } from "./normalise.ts";

test("Xero date parser accepts ISO and legacy JSON dates", () => {
  assert.equal(xeroDate("2026-08-10T00:00:00"), "2026-08-10");
  assert.equal(xeroDate("/Date(1786320000000+0000)/"), "2026-08-10");
  assert.equal(xeroDate(null), null);
});

test("Xero timestamp parser prefers the 2026 ISO field", () => {
  assert.equal(
    xeroTimestamp({ UpdatedDateUTCString: "2026-08-10T01:02:03Z" }),
    "2026-08-10T01:02:03.000Z"
  );
});
