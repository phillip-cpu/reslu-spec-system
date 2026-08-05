import assert from "node:assert/strict";
import test from "node:test";
import {
  importedFieldValues,
  isSupportedBrowserImportUrl,
  validateBrowserProductImport,
} from "./browser-product-import.ts";

const payload = {
  version: 1,
  source: {
    provider: "bunnings",
    pageUrl: "https://trade.bunnings.com.au/example-product_p123#reviews",
    pageKind: "trade",
    extractedAt: "2026-08-05T01:00:00.000Z",
  },
  product: {
    name: " Example product ",
    description: "Product description",
    brand: "Example Brand",
    supplier: "Bunnings",
    priceRrp: 42.74,
    widthMm: 90,
    heightMm: 45,
    lengthMm: 5400,
    depthMm: null,
    colour: null,
    material: "Timber",
    finish: null,
    details: [
      { label: "Model Number", value: "ABC123" },
      { label: "model number", value: "duplicate ignored" },
    ],
    images: ["https://media.bunnings.com.au/product.png"],
  },
};

test("accepts normalized Bunnings browser imports and removes URL fragments", () => {
  const result = validateBrowserProductImport(payload);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.payload.product.name, "Example product");
  assert.equal(result.payload.source.pageKind, "trade");
  assert.equal(result.payload.source.pageUrl.includes("#"), false);
  assert.equal(result.payload.product.details.length, 1);
  assert.equal(importedFieldValues(result.payload).price_rrp, 42.74);
});

test("rejects unsupported hosts and non-HTTPS source URLs", () => {
  assert.equal(isSupportedBrowserImportUrl("https://www.bunnings.com.au/product"), true);
  assert.equal(isSupportedBrowserImportUrl("https://evil.example/product"), false);
  assert.equal(isSupportedBrowserImportUrl("http://www.bunnings.com.au/product"), false);
  const result = validateBrowserProductImport({
    ...payload,
    source: { ...payload.source, pageUrl: "https://example.com/product" },
  });
  assert.equal(result.ok, false);
});

test("does not accept an empty product payload", () => {
  const result = validateBrowserProductImport({
    ...payload,
    product: { details: [], images: [] },
  });
  assert.deepEqual(result, {
    ok: false,
    error: "No usable product information was found on this page.",
  });
});
