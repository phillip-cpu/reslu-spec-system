import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
const service = read("./xero-customer-invoices.ts");
const route = read("../../app/api/stuart/xero-customer-invoices/route.ts");
const migration = read("../../supabase/migrations/20260908082157_stuart_customer_invoice_capability.sql");
test("direct API calls require Stuart identity and an exact approved payload-bound action", () => {
  assert.match(route, /!user \|\| !isStuartUser\(user\)/);
  assert.match(route, /const \{ _authority, \.\.\.invoice \} = body/);
  assert.match(service, /validateCustomerInvoiceApproval\(approval\.data, digest, input\.invoice_number, authority\)/);
  assert.match(service, /eq\("slug", "stuart"\)\.eq\("active", true\)\.eq\("auth_profile_id", actorId\)/);
  assert.doesNotMatch(service, /begin_aria_action|finish_aria_action|current_actor_is_aria/);
  assert.match(service, /sha256 !== input\.source_sha256/);
});
test("the external write follows an atomic one-shot claim and records uncertainty instead of retrying", () => {
  const claim = service.indexOf('from("aria_action_runs").insert');
  const write = service.indexOf('const created = await xeroPostJson');
  assert.ok(claim > 0 && write > claim);
  assert.match(service, /idempotency_key: customerInvoiceKey\(input\.invoice_number\)/);
  assert.match(service, /state: "verifying"/);
  assert.match(service, /previous\.payload_sha256 !== digest \|\| previous\.actor_profile_id !== actorId/);
  assert.match(service, /from\("aria_action_receipts"\)\.insert/);
  assert.match(service, /inspect_before_retry/);
  assert.match(service, /!Array\.isArray\(duplicate\.Invoices\)/);
  assert.match(service, /verifyCustomerInvoiceReadback/);
  assert.match(service, /file\.FileName === filename && Number\(file\.ContentLength\) === bytes\.length/);
  assert.doesNotMatch(service, /Status: "AUTHORISED"|\/Email|\/Payments/);
});
test("Stuart's direct connector path exposes the approval envelope without enabling Aria's broader handler", () => {
  const mcp = read("../../mcp/src/index.mjs");
  assert.match(mcp, /AGENT_ROLE !== "aria"[\s\S]*tool\.name === "create_stuart_xero_draft_customer_invoice"[\s\S]*decorateAriaTool\(tool, \{ risk_tier: "R2", action_class: "commit" \}\)/);
});
test("customer capability preserves exact-owner R2 and is not granted to other agents", () => {
  assert.match(migration, /'commit','R2','exact-owner','provider_readback','provider-key','manual-recovery',true,array\['stuart'\]/);
  assert.doesNotMatch(migration, /grant |security definer|create table/i);
});
test("the source-bound approval and pre-write audit retain the issued-invoice reconciliation on success and uncertainty", () => {
  assert.match(service, /const \{ input, reconciliation \} = prepareCustomerInvoice\(raw\)/);
  assert.match(service, /const digest = payloadSha256\(raw\)/);
  assert.match(service, /metadata: \{ transport: "stuart-customer-invoice", reconciliation, resulting_payload_sha256:/);
  assert.match(service, /provider_readback_verified: true, reconciliation/);
  assert.match(service, /finish\("partial", \{ xero_invoice_id: xeroInvoiceId, stage: "inspect_before_retry", reconciliation \}/);
  assert.match(service, /xeroPutBytes\(connection, [^\n]*bytes, "application\/pdf"\)/);
  const instructions = read("../../openclaw/stuart-workspace/AGENTS.md");
  assert.match(instructions, /invoice already sent to the client is gospel/);
  assert.match(read("../workroom-review.ts"), /request\.tool_args\.issued_to_client === true/);
});
