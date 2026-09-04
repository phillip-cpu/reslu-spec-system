import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const createRoute = readFileSync(
  new URL("../app/api/projects/[id]/quote-requests/route.ts", import.meta.url),
  "utf8",
);
const attachmentRoute = readFileSync(
  new URL("../app/api/quote-requests/[id]/attachments/route.ts", import.meta.url),
  "utf8",
);
const panel = readFileSync(
  new URL("../components/estimate/QuoteRequestsPanel.tsx", import.meta.url),
  "utf8",
);

test("staff can record a received quote against both estimate and FF&E targets", () => {
  assert.match(createRoute, /source === "manual"/);
  assert.match(createRoute, /status: "quote_received"/);
  assert.match(createRoute, /supplier_quote_response_lines/);
  assert.match(createRoute, /supplier_quote_response_items/);
  assert.match(createRoute, /cost_lines"\)\.update\(\{ quote_status: "Q" \}\)/);
});

test("received quote documents are admin-gated response evidence", () => {
  assert.match(attachmentRoute, /info\.role !== "admin"/);
  assert.match(attachmentRoute, /kind: "response"/);
  assert.match(attachmentRoute, /validateUploadBytes/);
  assert.match(attachmentRoute, /MAX_FILE_BYTES = 20 \* 1024 \* 1024/);
});

test("the estimate quote workflow exposes all three staff entry paths", () => {
  assert.match(panel, /Record received quote/);
  assert.match(panel, /Link existing email/);
  assert.match(panel, /Send new RFQ/);
  assert.match(panel, /Current estimate costs are prefilled/);
  assert.match(panel, /Attach document/);
});
