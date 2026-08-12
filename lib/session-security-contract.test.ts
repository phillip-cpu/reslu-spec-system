import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const route = read("app/api/me/sessions/revoke-others/route.ts");
const settings = read("components/settings/SessionSecuritySettings.tsx");
const page = read("app/(dashboard)/settings/page.tsx");

test("other-device revocation is authenticated and retains the current session", () => {
  assert.match(route, /supabase\.auth\.getUser\(\)/);
  assert.match(route, /supabase\.auth\.signOut\(\{ scope: "others" \}\)/);
  assert.doesNotMatch(route, /scope: "global"/);
  assert.match(route, /current_session_retained: true/);
});

test("revoked devices lose only the caller-owned remote push routes", () => {
  assert.match(route, /from\("push_subscriptions"\)[\s\S]*\.eq\("user_id", user\.id\)/);
  assert.match(route, /\.neq\("endpoint", currentPushEndpoint\)/);
  assert.match(route, /current_push_endpoint/);
  assert.match(route, /new URL\(currentPushEndpoint\)\.protocol !== "https:"/);
  assert.match(route, /sessions_revoked: true/);
});

test("Settings discloses the access-token and remote-wipe boundaries", () => {
  assert.match(page, /<SessionSecuritySettings \/>/);
  assert.match(settings, /Sign out other devices/);
  assert.match(settings, /short-lived access token expires/i);
  assert.match(settings, /not a remote erase/i);
  assert.match(settings, /role="status" aria-live="polite"/);
});
