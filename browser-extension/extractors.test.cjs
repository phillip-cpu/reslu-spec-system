const assert = require("node:assert/strict");
const test = require("node:test");

require("./extractors.js");

const { extractBunnings, inferDimensionsFromTitle } = globalThis.ResluProductExtractor;

function fakeDocument(nextData) {
  return {
    querySelector(selector) {
      if (selector === "script#__NEXT_DATA__") {
        return { textContent: JSON.stringify(nextData) };
      }
      if (selector === "h1") return { textContent: "90 x 45mm 5.4m SMART10 LVL H2S" };
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
}

test("extracts Bunnings data already exposed in the open page", () => {
  const nextData = {
    props: {
      pageProps: {
        dehydratedState: {
          queries: [
            { queryKey: ["product-retail-price"], state: { data: { value: 42.74 } } },
            {
              queryKey: ["trade-product"],
              state: {
                data: {
                  name: "90 x 45mm 5.4m SMART10 LVL H2S",
                  brand: { name: "Tilling SmartFrame" },
                  feature: { description: "Engineered framing.", pointers: ["H2S treated"] },
                  itemNumber: "0617678",
                  images: [{ url: "https://media.bunnings.com.au/product.png" }],
                  classifications: [
                    {
                      features: [
                        { name: "Material", featureValues: [{ value: "Timber" }] },
                      ],
                    },
                  ],
                },
              },
            },
          ],
        },
      },
    },
  };
  const result = extractBunnings(
    fakeDocument(nextData),
    "https://trade.bunnings.com.au/example_p0617678"
  );
  assert.equal(result.ok, true);
  assert.equal(result.payload.product.priceRrp, 42.74);
  assert.equal(result.payload.product.brand, "Tilling SmartFrame");
  assert.equal(result.payload.product.lengthMm, 5400);
  assert.equal(result.payload.product.material, "Timber");
});

test("interprets common door and timber title dimension order", () => {
  assert.deepEqual(inferDimensionsFromTitle("Hume 2340 x 820 x 40mm external door"), {
    heightMm: 2340,
    widthMm: 820,
    depthMm: 40,
  });
  assert.deepEqual(inferDimensionsFromTitle("90 x 45mm 5.4m SMART10 LVL"), {
    widthMm: 90,
    heightMm: 45,
    lengthMm: 5400,
  });
});

test("supports the Bunnings retail product query on the retail host", () => {
  const nextData = {
    props: {
      pageProps: {
        dehydratedState: {
          queries: [
            { queryKey: ["product-retail-price"], state: { data: { value: 760 } } },
            {
              queryKey: ["retail-product"],
              state: {
                data: {
                  name: "Hume 2340 x 820 x 40mm external door",
                  brand: { name: "Hume" },
                  itemNumber: "1234567",
                  images: [],
                },
              },
            },
          ],
        },
      },
    },
  };
  const result = extractBunnings(
    fakeDocument(nextData),
    "https://www.bunnings.com.au/hume-external-door_p1234567"
  );
  assert.equal(result.ok, true);
  assert.equal(result.payload.source.pageKind, "retail");
  assert.equal(result.payload.product.priceRrp, 760);
  assert.equal(result.payload.product.heightMm, 2340);
  assert.equal(result.payload.product.widthMm, 820);
  assert.equal(result.payload.product.depthMm, 40);
});

test("rejects suppliers outside the explicit allowlist", () => {
  assert.deepEqual(extractBunnings(fakeDocument({}), "https://example.com/product"), {
    ok: false,
    error: "This supplier page is not supported yet.",
  });
});
