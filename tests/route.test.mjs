import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createHash, randomBytes } from "node:crypto";
const calls = [];
let data = [];
globalThis.__partnerTestClient = () => {
  calls.push(["client"]);
  const query = Object.fromEntries(
    ["from","select","is","in","gte"].map(k => [k, (...args) => { calls.push([k,...args]); return query; }]),
  );
  query.limit = (n) => { calls.push(["limit",n]); return { data, error: null }; };
  return query;
};
const stub = (code) => "data:text/javascript," + encodeURIComponent(code);
registerHooks({resolve(specifier, context, nextResolve) {
  if (specifier === "@/lib/supabase/server") return {url:stub("export const createServiceRoleClient = globalThis.__partnerTestClient"),shortCircuit:true};
  if (specifier === "@/lib/rate-limit") return {url:stub("export const rateLimit = () => ({ok:true})"),shortCircuit:true};
  if (specifier === "@/lib/partner-lead-access") return {url:new URL("../lib/partner-lead-access.ts",import.meta.url).href,shortCircuit:true};
  return nextResolve(specifier,context);
}});
const { GET, POST } = await import("../app/partner/leads/route.ts");
const key = randomBytes(32).toString("base64url");
process.env.PARTNER_REPORT_KEY_SHA256 = createHash("sha256").update(key).digest("hex");
process.env.PARTNER_REPORT_EXPIRES_AT = new Date(Date.now()+3600000).toISOString();
process.env.PARTNER_REPORT_SINCE = "2026-01-01T00:00:00Z";
process.env.PARTNER_REPORT_CAMPAIGNS = "partner_ad";
const address = "https://example.org/partner/leads";
function req(body, origin = "https://example.org") {
  return Object.assign(new Request(address, {method:"POST",body,headers:{origin,"Content-Type":"application/x-www-form-urlencoded"}}), {nextUrl:new URL(address)});
}
test("GET is only the private uncached access form", async () => {
  assert.equal(GET().headers.get("cache-control"), "private, no-store, max-age=0");
  assert.ok((await GET().text()).includes('type="password"'));
  assert.equal(calls.length,0);
});
test("invalid key, origin and oversize never hit the database", async () => {
  assert.equal((await POST(req("key=bad"))).status,401);
  assert.equal((await POST(req("key="+key,"https://not-reslu.example"))).status,403);
  assert.equal((await POST(req("key="+key+"x".repeat(70)))).status,400);
  assert.equal(calls.length,0);
});
test("scoped lookup excludes unrelated campaigns and only returns stage counts", async () => {
  data = [{utm_campaign:"partner_ad",stage:"Proposal Sent",email:"hidden@example.org"},{utm_campaign:"internal",stage:"Lead Lost"}];
  const response = await POST(req("key="+key));
  assert.equal(response.status,200);
  const html = await response.text();
  assert.match(html,/partner_ad.*Proposal Sent.*1/);
  assert.doesNotMatch(html,/internal|hidden@example\.org/);
  assert.deepEqual(calls,[["client"],["from","leads"],["select","utm_campaign,stage"],["is","deleted_at",null],["in","utm_campaign",["partner_ad"]],["gte","received_at","2026-01-01T00:00:00.000Z"],["limit",1000]]);
});
