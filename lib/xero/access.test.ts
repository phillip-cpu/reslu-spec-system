import assert from "node:assert/strict";
import test from "node:test";
import { hasXeroAccess, xeroAllowedEmails } from "./access.ts";

const originalAllowlist = process.env.XERO_ALLOWED_EMAILS;

function restoreAllowlist() {
  if (originalAllowlist === undefined) delete process.env.XERO_ALLOWED_EMAILS;
  else process.env.XERO_ALLOWED_EMAILS = originalAllowlist;
}

test("Xero access allows Phillip by default but blocks another admin such as Aria", () => {
  try {
    delete process.env.XERO_ALLOWED_EMAILS;
    assert.equal(hasXeroAccess({ role: "admin", email: "phillip@reslu.com.au" }), true);
    assert.equal(hasXeroAccess({ role: "admin", email: "aria@reslu.com.au" }), false);
  } finally {
    restoreAllowlist();
  }
});

test("Xero access still blocks a non-admin whose email is allowlisted", () => {
  assert.equal(hasXeroAccess({ role: "designer", email: "phillip@reslu.com.au" }), false);
});

test("Xero access supports an explicit comma-separated allowlist", () => {
  try {
    process.env.XERO_ALLOWED_EMAILS = "accounts@reslu.com.au, finance@reslu.com.au";
    assert.deepEqual(xeroAllowedEmails(), ["accounts@reslu.com.au", "finance@reslu.com.au"]);
    assert.equal(hasXeroAccess({ role: "admin", email: "accounts@reslu.com.au" }), true);
    assert.equal(hasXeroAccess({ role: "admin", email: "phillip@reslu.com.au" }), false);
  } finally {
    restoreAllowlist();
  }
});
