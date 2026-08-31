import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { applySitePatch, replaceSiteText, resolveSitePath, summarizeTrackingRequests, trackingSourceStatus } from "./reslu-site-core.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reslu-site-core-"));
  fs.mkdirSync(path.join(root, "src/components"), { recursive: true });
  fs.mkdirSync(path.join(root, "src/layouts"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/components/BeginForm.astro"), "window.gtag('event', 'generate_lead');\nwindow.gtag('event', 'conversion', {send_to: 'AW-16784006257/hL8XCIOVl9gcEPG4nsM-'});\nwindow.fbq('track', 'Lead');\n");
  fs.writeFileSync(path.join(root, "src/layouts/Base.astro"), "window.gtag = gtag;\ngtag('config', 'AW-16784006257');\n");
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"], { cwd: root, stdio: "ignore" });
  return root;
}

test("paths stay inside the site repo and secret files are blocked", () => {
  const root = fixture();
  assert.equal(resolveSitePath(root, "src/components/BeginForm.astro").relative, "src/components/BeginForm.astro");
  assert.throws(() => resolveSitePath(root, "../secret.txt"), /stay inside/);
  assert.throws(() => resolveSitePath(root, ".env.local"), /not available/);
  assert.throws(() => resolveSitePath(root, ".git/config"), /not available/);
});

test("tracking source status distinguishes the correct conversion label", () => {
  const status = trackingSourceStatus(fixture());
  assert.equal(status.beginFormCompletedLabelPresent, true);
  assert.equal(status.obsoleteContactSubmitLabelPresent, false);
  assert.equal(status.generateLeadEventPresent, true);
  assert.equal(status.metaLeadEventPresent, true);
  assert.equal(status.globalAdsConfigPresent, true);
  assert.equal(status.globalGtagExposed, true);
});

test("patch application is checked and scoped", () => {
  const root = fixture();
  const patch = [
    "diff --git a/src/components/BeginForm.astro b/src/components/BeginForm.astro",
    "index 5e341c7..04c58c1 100644",
    "--- a/src/components/BeginForm.astro",
    "+++ b/src/components/BeginForm.astro",
    "@@ -1,3 +1,4 @@",
    " window.gtag('event', 'generate_lead');",
    "+// verified",
    " window.gtag('event', 'conversion', {send_to: 'AW-16784006257/hL8XCIOVl9gcEPG4nsM-'});",
    " window.fbq('track', 'Lead');",
    "",
  ].join("\n");
  const result = applySitePatch(patch, root);
  assert.deepEqual(result.changedPaths, ["src/components/BeginForm.astro"]);
  assert.match(fs.readFileSync(path.join(root, "src/components/BeginForm.astro"), "utf8"), /verified/);
});

test("exact text replacement is deterministic and rejects stale or ambiguous input", () => {
  const root = fixture();
  const file = "src/components/BeginForm.astro";
  const oldText = "window.fbq('track', 'Lead');";
  const newText = "window.fbq('track', 'QualifiedLead');";
  const result = replaceSiteText({ path: file, oldText, newText, expectedOccurrences: 1 }, root);
  assert.deepEqual(result.changedPaths, [file]);
  assert.equal(result.replacements, 1);
  assert.match(fs.readFileSync(path.join(root, file), "utf8"), /QualifiedLead/);
  assert.throws(
    () => replaceSiteText({ path: file, oldText, newText, expectedOccurrences: 1 }, root),
    /expected 1, found 0/,
  );
});

test("exact text replacement refuses multiple matches unless explicitly expected", () => {
  const root = fixture();
  const file = "src/components/BeginForm.astro";
  fs.appendFileSync(path.join(root, file), "window.fbq('track', 'Lead');\n");
  assert.throws(
    () => replaceSiteText({ path: file, oldText: "window.fbq('track', 'Lead');", newText: "changed" }, root),
    /expected 1, found 2/,
  );
});

test("live request summaries distinguish page-load traffic from a form conversion", () => {
  const pageLoad = summarizeTrackingRequests([
    { method: "GET", url: "https://googleads.g.doubleclick.net/pagead/viewthroughconversion/16784006257/?en=gtag.config", status: 200, ok: true },
    { method: "POST", url: "https://www.google.com/ccm/collect?tid=AW-16784006257&en=page_view", status: 200, ok: true },
  ]);
  assert.equal(pageLoad.pageLoadTagTrafficObserved, true);
  assert.equal(pageLoad.conversionEventObserved, false);
  assert.equal(pageLoad.beginFormCompletedObserved, false);

  const completed = summarizeTrackingRequests([
    { method: "GET", url: "https://www.googleadservices.com/pagead/conversion/16784006257/?label=hL8XCIOVl9gcEPG4nsM-", status: 200, ok: true },
  ]);
  assert.equal(completed.conversionEventObserved, true);
  assert.equal(completed.beginFormCompletedObserved, true);
});
