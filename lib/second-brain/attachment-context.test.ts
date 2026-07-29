import assert from "node:assert/strict";
import test from "node:test";
import { buildExtractedAttachmentTextBlocks } from "./attachment-context.ts";

test("passes readable PDF text to extraction even when vision is unnecessary", () => {
  const blocks = buildExtractedAttachmentTextBlocks([
    {
      id: "bunnings-pdf",
      filename: "INVOICE_W288707086-1_99886501.pdf",
      extracted_text:
        "Bunnings Group Limited\nTax Invoice W288707086-1\nTotal $665.11",
      extraction_method: "pdftotext",
    },
  ]);

  assert.equal(blocks.length, 1);
  assert.match(blocks[0].text, /attachment_text id="bunnings-pdf"/);
  assert.match(blocks[0].text, /Tax Invoice W288707086-1/);
  assert.match(blocks[0].text, /Total \$665\.11/);
});

test("ignores blank attachment text and escapes attachment metadata", () => {
  const blocks = buildExtractedAttachmentTextBlocks([
    {
      id: "blank",
      filename: "empty.pdf",
      extracted_text: "   ",
      extraction_method: "none",
    },
    {
      id: 'invoice-"2"',
      filename: 'Bunnings & "Trade".pdf',
      extracted_text: "Tax Invoice\nTotal $100.00",
      extraction_method: "ocrmypdf+pdftotext",
    },
  ]);

  assert.equal(blocks.length, 1);
  assert.match(blocks[0].text, /id="invoice-&quot;2&quot;"/);
  assert.match(blocks[0].text, /filename="Bunnings &amp; &quot;Trade&quot;\.pdf"/);
});

