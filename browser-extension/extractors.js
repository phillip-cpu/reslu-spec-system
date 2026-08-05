(function installResluProductExtractor(root) {
  "use strict";

  const MAX_DETAILS = 40;
  const MAX_IMAGES = 12;

  function cleanText(value, max = 1000) {
    if (typeof value !== "string") return null;
    const cleaned = value.replace(/\s+/g, " ").trim().slice(0, max);
    return cleaned || null;
  }

  function cleanNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.round(number * 100) / 100 : null;
  }

  function readNextData(document) {
    const script = document.querySelector("script#__NEXT_DATA__");
    if (!script?.textContent) return [];
    try {
      const parsed = JSON.parse(script.textContent);
      const queries = parsed?.props?.pageProps?.dehydratedState?.queries;
      return Array.isArray(queries) ? queries : [];
    } catch {
      return [];
    }
  }

  function addDetail(details, label, value) {
    const cleanLabel = cleanText(label, 120);
    const values = Array.isArray(value) ? value.map((entry) => cleanText(entry)).filter(Boolean) : [cleanText(value)];
    const cleanValue = values.filter(Boolean).join(", ");
    if (!cleanLabel || !cleanValue) return;
    if (details.some((entry) => entry.label.toLowerCase() === cleanLabel.toLowerCase())) return;
    if (details.length < MAX_DETAILS) details.push({ label: cleanLabel, value: cleanValue.slice(0, 1000) });
  }

  function readJsonLd(document) {
    const nodes = [];
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(script.textContent || "null");
        const candidates = Array.isArray(parsed) ? parsed : parsed?.["@graph"] || [parsed];
        for (const candidate of candidates) {
          const types = Array.isArray(candidate?.["@type"]) ? candidate["@type"] : [candidate?.["@type"]];
          if (types.some((type) => String(type).toLowerCase() === "product")) nodes.push(candidate);
        }
      } catch {
        // One malformed structured-data block must not stop the import.
      }
    }
    return nodes[0] || null;
  }

  function absoluteImage(value, pageUrl) {
    const raw = typeof value === "string" ? value : value?.url;
    if (!raw) return null;
    try {
      const url = new URL(raw, pageUrl);
      return url.protocol === "https:" ? url.toString() : null;
    } catch {
      return null;
    }
  }

  function inferDimensionsFromTitle(title) {
    const dimensions = {};
    if (!title) return dimensions;
    const timber = /(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*mm[^\d]{0,20}(\d+(?:\.\d+)?)\s*m\b/i.exec(title);
    if (timber) {
      dimensions.widthMm = cleanNumber(timber[1]);
      dimensions.heightMm = cleanNumber(timber[2]);
      dimensions.lengthMm = cleanNumber(Number(timber[3]) * 1000);
      return dimensions;
    }
    const millimetres = /(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)(?:\s*[x×]\s*(\d+(?:\.\d+)?))?\s*mm\b/i.exec(title);
    if (!millimetres) return dimensions;
    const first = cleanNumber(millimetres[1]);
    const second = cleanNumber(millimetres[2]);
    const third = cleanNumber(millimetres[3]);
    if (/\bdoor\b/i.test(title) && first && second && first > second) {
      dimensions.heightMm = first;
      dimensions.widthMm = second;
      if (third) dimensions.depthMm = third;
    } else {
      dimensions.widthMm = first;
      dimensions.heightMm = second;
      if (third) dimensions.depthMm = third;
    }
    return dimensions;
  }

  function dimensionsFromProduct(product, title) {
    const result = {};
    const explicit = Array.isArray(product?.dimension?.product)
      ? product.dimension.product[0]
      : product?.dimension?.product;
    if (explicit && typeof explicit === "object") {
      const width = cleanNumber(explicit.width);
      const height = cleanNumber(explicit.height);
      const depth = cleanNumber(explicit.depth);
      const length = cleanNumber(explicit.length);
      if (width !== null) result.widthMm = width;
      if (height !== null) result.heightMm = height;
      if (depth !== null) result.depthMm = depth;
      if (length !== null) result.lengthMm = length;
    }
    const inferred = inferDimensionsFromTitle(title);
    for (const [key, value] of Object.entries(inferred)) {
      if (result[key] === undefined && value !== null) result[key] = value;
    }
    return result;
  }

  function detailValue(details, labels) {
    const match = details.find((entry) => labels.some((label) => entry.label.toLowerCase().includes(label)));
    return match?.value || null;
  }

  function extractBunnings(document, pageUrl) {
    const url = new URL(pageUrl);
    if (!/(^|\.)bunnings\.com\.au$/i.test(url.hostname)) {
      return { ok: false, error: "This supplier page is not supported yet." };
    }

    let product = null;
    let price = null;
    const queries = readNextData(document);
    for (const query of queries) {
      const key = Array.isArray(query?.queryKey) ? query.queryKey[0] : null;
      const data = query?.state?.data;
      if (key === "product-retail-price") price = cleanNumber(data?.value);
      if ((key === "retail-product" || key === "trade-product") && data && typeof data === "object") product = data;
    }

    const jsonLd = readJsonLd(document);
    const title = cleanText(product?.name, 300) || cleanText(jsonLd?.name, 300) || cleanText(document.querySelector("h1")?.textContent, 300);
    const description =
      cleanText(product?.feature?.description, 5000) ||
      cleanText(product?.summary, 5000) ||
      cleanText(jsonLd?.description, 5000) ||
      cleanText(document.querySelector('meta[name="description"]')?.content, 5000);
    const brand = cleanText(product?.brand?.name, 200) || cleanText(jsonLd?.brand?.name || jsonLd?.brand, 200);
    if (price === null) {
      const offer = Array.isArray(jsonLd?.offers) ? jsonLd.offers[0] : jsonLd?.offers;
      price = cleanNumber(offer?.price);
    }

    const details = [];
    addDetail(details, "Item number", product?.itemNumber || product?.code || jsonLd?.sku);
    addDetail(details, "Unit of sale", product?.unitofprice);
    if (Array.isArray(product?.feature?.pointers)) addDetail(details, "Features", product.feature.pointers);
    if (Array.isArray(product?.classifications)) {
      for (const classification of product.classifications) {
        if (!Array.isArray(classification?.features)) continue;
        for (const feature of classification.features) {
          const values = Array.isArray(feature?.featureValues)
            ? feature.featureValues.map((entry) => entry?.value)
            : [];
          addDetail(details, feature?.name, values);
        }
      }
    }

    const rawImages = [];
    if (Array.isArray(product?.images)) rawImages.push(...product.images);
    const ldImages = Array.isArray(jsonLd?.image) ? jsonLd.image : jsonLd?.image ? [jsonLd.image] : [];
    rawImages.push(...ldImages);
    const ogImage = document.querySelector('meta[property="og:image"]')?.content;
    if (ogImage) rawImages.push(ogImage);
    const images = [...new Set(rawImages.map((image) => absoluteImage(image, pageUrl)).filter(Boolean))].slice(0, MAX_IMAGES);
    const dimensions = dimensionsFromProduct(product, title);
    const cleanUrl = new URL(pageUrl);
    cleanUrl.hash = "";

    if (!title && price === null && details.length === 0) {
      return {
        ok: false,
        error: "This looks like a Bunnings page, but no product details were exposed on it. Check that it is a product page and has finished loading.",
      };
    }

    return {
      ok: true,
      payload: {
        version: 1,
        source: {
          provider: "bunnings",
          pageUrl: cleanUrl.toString(),
          pageKind: url.hostname.toLowerCase().startsWith("trade.") ? "trade" : "retail",
          extractedAt: new Date().toISOString(),
        },
        product: {
          name: title,
          description,
          brand,
          supplier: "Bunnings",
          priceRrp: price,
          widthMm: dimensions.widthMm ?? null,
          heightMm: dimensions.heightMm ?? null,
          lengthMm: dimensions.lengthMm ?? null,
          depthMm: dimensions.depthMm ?? null,
          colour: detailValue(details, ["colour", "color"]),
          material: detailValue(details, ["material"]),
          finish: detailValue(details, ["finish"]),
          details,
          images,
        },
      },
    };
  }

  root.ResluProductExtractor = { extractBunnings, inferDimensionsFromTitle };
})(globalThis);
