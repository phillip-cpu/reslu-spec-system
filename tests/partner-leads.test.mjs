import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { partnerLeadScope, summarizePartnerLeads } from "../lib/partner-lead-access.ts";
const key = randomBytes(32).toString("base64url");
const env = {
  PARTNER_REPORT_KEY_SHA256: createHash("sha256").update(key).digest("hex"),
  PARTNER_REPORT_EXPIRES_AT: "2026-12-29T00:00:00Z",
  PARTNER_REPORT_SINCE: "2026-11-29T00:00:00Z",
  PARTNER_REPORT_CAMPAIGNS: "partner_renovations,partner_extensions,partner_renovations",
};
const today = Date.parse("2026-12-01T00:00:00Z");
test("valid key selects only configured scope", () => {
  assert.deepEqual(partnerLeadScope(key, env, today), { campaigns: ["partner_renovations","partner_extensions"], since: "2026-11-29T00:00:00.000Z" });
});
test("rejects missing, malformed, unrelated and expired credentials", () => {
  for (const value of [null, {}, "", "bad", randomBytes(32).toString("base64url")])
    assert.equal(partnerLeadScope(value, env, today), null);
  assert.equal(partnerLeadScope(key, {}, today), null);
  assert.equal(partnerLeadScope(key, env, Date.parse(env.PARTNER_REPORT_EXPIRES_AT)), null);
});
test("no report for missing, broad or malformed campaign scopes", () => {
  for (const value of ["", "*", "a,b)", "a,,b", 'x"<script>'])
    assert.equal(partnerLeadScope(key, { ...env, PARTNER_REPORT_CAMPAIGNS: value }, today), null);
});
test("counts selected leads only and emits no source-row PII or dynamic HTML", () => {
  const report = summarizePartnerLeads([
    {utm_campaign:"another_firm", stage:"Won", name:"ignored"},
    {utm_campaign:"partner_renovations",stage:"Qualified", email:"ignored@example.org"},
    {utm_campaign:"partner_renovations",stage:"Qualified", phone:"ignored"},
    {utm_campaign:"partner_renovations",stage:"<script>ignored</script>"},
    {utm_campaign:"<script>ignored</script>",stage:"Won"},
  ],["partner_renovations","<script>ignored</script>"]);
  assert.deepEqual(report, [
    {campaign:"partner_renovations",stage:"Other",count:1},
    {campaign:"partner_renovations",stage:"Qualified",count:2},
  ]);
});
