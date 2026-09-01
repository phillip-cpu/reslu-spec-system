import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const route = readFileSync(
  resolve(process.cwd(), "app/api/projects/[id]/items/route.ts"),
  "utf8"
);

test("quick-add returns the non-financial spec projection", () => {
  assert.match(
    route,
    /return NextResponse\.json\(\{ item: toSpecViewItem\(item\) \}, \{ status: 201 \}\)/
  );
  assert.match(
    route,
    /SPEC_VIEW_COLUMN_NAMES\.map\(\(column\) => \[column, item\[column\]\]\)/
  );
});

test("the public spec projection excludes negotiated pricing fields", () => {
  const projectionStart = route.indexOf("const SPEC_VIEW_COLUMN_NAMES = [");
  const projectionEnd = route.indexOf("] as const;", projectionStart);
  const projection = route.slice(projectionStart, projectionEnd);

  assert.notEqual(projectionStart, -1);
  assert.notEqual(projectionEnd, -1);
  assert.doesNotMatch(projection, /"price_trade"/);
  assert.doesNotMatch(projection, /"markup_pct"/);
  assert.doesNotMatch(projection, /"price_rrp"/);
});
