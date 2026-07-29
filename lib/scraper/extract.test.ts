import assert from "node:assert/strict";
import test from "node:test";
import { extractFromHtml } from "./extract.ts";

test("extracts Bunnings Trade price, content, specifications and mixed-unit dimensions", () => {
  const nextData = {
    props: {
      pageProps: {
        dehydratedState: {
          queries: [
            {
              queryKey: ["product-retail-price", "0617678", "2010"],
              state: { data: { value: 42.74 } },
            },
            {
              queryKey: ["trade-product", "0617678", "2010"],
              state: {
                data: {
                  code: "0617678",
                  name: "90 x 45mm 5.4m SMART10 LVL H2S",
                  brand: { name: "Tilling SmartFrame" },
                  unitofprice: "EA",
                  feature: {
                    description: "Engineered timber framing.",
                    pointers: ["Straight and strong", "H2S termite treated"],
                  },
                  classifications: [
                    {
                      features: [
                        {
                          name: "Model Number",
                          featureValues: [{ value: "SL109045H2S" }],
                        },
                      ],
                    },
                  ],
                  dimension: {
                    product: [{ width: "90", height: "45", depth: "5400" }],
                  },
                  images: [{ url: "https://media.bunnings.com.au/product.png" }],
                },
              },
            },
          ],
        },
      },
    },
  };
  const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    nextData
  )}</script><h1>90 x 45mm 5.4m SMART10 LVL H2S</h1></html>`;

  const result = extractFromHtml(
    html,
    "https://trade.bunnings.com.au/90-x-45mm-5-4m-smart10-lvl-h2s_p0617678"
  );

  assert.equal(result.price, 42.74);
  assert.equal(result.brand, "Tilling SmartFrame");
  assert.equal(result.description, "Engineered timber framing.");
  assert.deepEqual(result.dimensions, {
    width_mm: 90,
    height_mm: 45,
    length_mm: 5400,
    depth_mm: undefined,
  });
  assert.ok(result.images.includes("https://media.bunnings.com.au/product.png"));
  assert.ok(
    result.details.some(
      (detail) => detail.label === "Model Number" && detail.value === "SL109045H2S"
    )
  );
  assert.ok(
    result.details.some(
      (detail) =>
        detail.label === "Features" &&
        detail.value.includes("H2S termite treated")
    )
  );
});

test("extracts generic JSON-LD product details without requiring an image", () => {
  const html = `
    <script type="application/ld+json">
      {
        "@type": "Product",
        "name": "Sample tap",
        "description": "A wall-mounted mixer.",
        "brand": {"name": "Sample Brand"},
        "additionalProperty": [
          {"name": "Finish", "value": "Antique Brass"},
          {"name": "Material", "value": "Brass"}
        ],
        "width": {"value": 12, "unitCode": "CMT"}
      }
    </script>
    <table>
      <tr><th>Model Number</th><td>WM-100</td></tr>
      <tr><th>Delivery suburb</th><td>Adelaide</td></tr>
    </table>
  `;

  const result = extractFromHtml(html, "https://supplier.example/products/sample");

  assert.equal(result.title, "Sample tap");
  assert.equal(result.description, "A wall-mounted mixer.");
  assert.equal(result.brand, "Sample Brand");
  assert.equal(result.dimensions.width_mm, 120);
  assert.deepEqual(result.details, [
    { label: "Finish", value: "Antique Brass" },
    { label: "Material", value: "Brass" },
    { label: "Model Number", value: "WM-100" },
  ]);
});
