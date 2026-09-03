import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./morning-brief-notify.ts", import.meta.url), "utf8");

test("morning brief delivery is private, date-deduped and uses exact notification ids", () => {
  assert.match(source, /`morning_brief:\$\{briefDate\}`/);
  assert.match(source, /user_id:\s*adminId/);
  assert.match(source, /\.eq\("kind", kind\)[\s\S]*\.in\("user_id", adminIds\)/);
  assert.match(source, /sendPushToUsers\(\[adminId\], notification\.id/);
  assert.doesNotMatch(source, /sendPushToAdmins\(/);
});

test("morning brief rows cannot resurface through legacy latest-unread push delivery", () => {
  assert.match(source, /read_at:\s*now\.toISOString\(\)/);
});
