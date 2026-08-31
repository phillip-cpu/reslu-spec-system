import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./xero-contacts.ts", import.meta.url), "utf8");
const route = readFileSync(new URL("../../app/api/stuart/xero-contacts/route.ts", import.meta.url), "utf8");
const mcp = readFileSync(new URL("../../mcp/src/index.mjs", import.meta.url), "utf8");

test("Stuart contact search is read-only and bounded", () => {
  assert.match(source, /xeroGet/);
  assert.doesNotMatch(source, /xeroPostJson|xeroPutBytes/);
  assert.match(source, /\.slice\(0, 25\)/);
  assert.match(source, /accounting\.contacts\.read/);
});

test("contact search is Stuart-authenticated and available to his MCP role", () => {
  assert.match(route, /isStuartUser/);
  assert.match(mcp, /search_stuart_xero_contacts/);
  assert.match(mcp, /encodeURIComponent\(query\)/);
});
