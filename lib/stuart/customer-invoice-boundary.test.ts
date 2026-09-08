import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
const service = read("./xero-customer-invoices.ts");
const route = read("../../app/api/stuart/xero-customer-invoices/route.ts");
const migration = read("../../supabase/migrations/20260908082157_stuart_customer_invoice_capability.sql");
test("direct API calls require Stuart identity and an exact approved payload-bound action", () => {
  assert.match(route, /!user \|\| !isStuartUser\(user\)/);
  assert.match(route, /x-reslu-action-run-id/);
  assert.match(service, /validateCustomerInvoiceAuthority\(action, actorId, payloadSha256\(raw\)/);
  assert.match(service, /receipt\.revoked_at/);
  assert.match(service, /sha256 !== input\.source_sha256/);
});
test("the external write follows an atomic one-shot claim and records uncertainty instead of retrying", () => {
  const claim = service.indexOf('update({ state: "verifying" })');
  const write = service.indexOf('const created = await xeroPostJson');
  assert.ok(claim > 0 && write > claim);
  assert.match(service, /eq\("state", "executing"\)\.select\("id"\)\.maybeSingle/);
  assert.match(service, /inspect_before_retry/);
  assert.match(service, /!Array\.isArray\(duplicate\.Invoices\)/);
  assert.doesNotMatch(service, /update\(\{ state: "(?:partial|failed|verified)"/);
  assert.match(service, /verifyCustomerInvoiceReadback/);
  assert.match(service, /file\.FileName === filename && Number\(file\.ContentLength\) === bytes\.length/);
  assert.doesNotMatch(service, /Status: "AUTHORISED"|\/Email|\/Payments/);
});
test("customer capability preserves exact-owner R2 and is not granted to other agents", () => {
  assert.match(migration, /'commit','R2','exact-owner','provider_readback','provider-key','manual-recovery',true,array\['stuart'\]/);
  assert.doesNotMatch(migration, /grant |security definer|create table/i);
});
