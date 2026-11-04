import {scheduleColourReference} from './schedule-colour-references';

// Exact product identity and destination pairs, populated only from verified
// sources. A safe URL or a matching host alone is not product verification.
const productReferences: Record<string, string> = {
  'bc1b56f5-ce34-4dbb-8748-5d878a133cfd': 'https://artusi.com.au/product/60cm-built-in-electric-oven-stainless-steel-4/',
  '49720001-efb4-4415-b36a-0215ab545311': 'https://www.fisherpaykel.com/au/dishwashing/built-under/series-7-contemporary-double-dishdrawer-dishwasher-dd60d2nx9-82878.html',
  '728d045f-d533-4d1b-bbc6-338f2df35db5': 'https://www.reece.com.au/product/memo-hugo-compact-sink-1-taphole-stainless-steel-2402710',
  '29cfffb0-5fc4-4115-9e23-e7907c235058': 'https://www.reece.com.au/product/posh-b150000/domaine-b150016/posh-domaine-semi-inset-overflow-basin-1-taphole-9508855',
  '4b077d08-999d-419a-aae2-d811ebff9032': 'https://www.reece.com.au/product/posh-solus-care-single-bowl-sink-with-drainer-no-42062',
  '08871b7b-8a2c-4071-b0c3-9d88195627b5': 'https://www.reece.com.au/product/posh-solus-care-single-bowl-sink-with-drainer-one-42063',
  'c302a8b9-6c4a-4aef-81e9-fd7d1419936f': 'https://www.reece.com.au/product/-26791',
  '71cc60be-ead8-407f-9656-46170503fcfe': 'https://www.reece.com.au/product/grohe-tempesta-250mm-round-overhead-shower-chrome-9507802',
  'e8712130-6755-476b-bb46-c8ecae36c5bb': 'https://www.reece.com.au/product/mizu-bloc-wall-straight-shower-arm-chrome-29686',
  'c1fc6dd1-2662-4de8-ae5f-ff391b3bcab9': 'https://www.reece.com.au/product/mizu-drift-basin-mixer-straight-spout-with-2267416',
  'cac3cdf4-c4b7-4ba7-b6cc-fcf675198edc': 'https://www.reece.com.au/product/mizu-drift-basin-mixer-tap-straight-spout-chrome-2267195',
  'b6896b2f-af13-4a6c-ad9d-d9ec581020e5': 'https://www.reece.com.au/product/mizu-drift-bottle-trap-40mm-chrome-2262546',
  'd1837aad-43e0-405c-aa86-91f802448a55': 'https://www.reece.com.au/product/mizu-drift-reversible-toilet-roll-holder-chrome-2265139',
  '3d287a79-4eff-40f8-a507-d933f68d875a': 'https://www.reece.com.au/product/mizu-drift-shower-mixer-kit-chrome-lead-free-2267361',
  'bd2d5da1-a463-4847-8e28-0276d77062df': 'https://www.reece.com.au/product/mizu-drift-single-towel-rail-700mm-chrome-2202017',
  '8b9349f6-ea9e-4b91-b113-01c6ba9ee0ca': 'https://www.reece.com.au/product/mizu-drift-sink-mixer-extended-lever-with-red-36317',
  '5579744c-0667-479b-aed9-bca089d294da': 'https://www.reece.com.au/product/mizu-drift-straight-toilet-roll-holder-chrome-9504247',
  '9e8f572b-12db-4c6e-a79d-ec9519a788ab': 'https://www.reece.com.au/product/mizu-drift-universal-40mm-pop-up-plug-waste-2263197',
  '09b90158-fab3-449b-865d-86cb94a69bd7': 'https://www.reece.com.au/product/mobi-32-x-450mm-grab-rail-polished-stainless-steel-9502622',
  '004eb8ba-1b3a-4fd4-8987-8bb45d25b395': 'https://www.reece.com.au/product/mobi-32-x-600mm-grab-rail-polished-stainless-steel-9502623',
  'bc6f4e05-dfde-4555-9b6d-71a517f66a69': 'https://www.reece.com.au/product/posh-bristol-mk2-sink-mixer-with-extended-lever-22691',
  '914877b6-fbe0-4c23-930c-a6afaf37bb7a': 'https://www.reece.com.au/product/posh-solus-mk2-robe-hook-chrome-9506577',
  '9c8b3080-f51a-48f8-b41e-2c99c1f90f5a': 'https://www.reece.com.au/product/posh-solus-mk3-single-grab-rail-shower-1-function-2213368',
};

export function safePdfHttpsUrl(value: string | null | undefined): string | null {
  if (!value || value !== value.trim()) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash
      ? url.href : null;
  } catch {
    return null;
  }
}

export function schedulePdfReference(item: {
  id?: string;
  library_item_id?: string | null;
  product_url?: string | null;
  colour: string | null;
  brand?: string | null;
}): {url: string; label: 'Product reference' | 'Colour reference'} | null {
  const url = safePdfHttpsUrl(item.product_url);
  if (!url) return null;
  const colour = scheduleColourReference(item);
  if (colour?.kind === 'manufacturer' && url === colour.source) {
    return {url, label: 'Colour reference'};
  }
  const expected = productReferences[item.library_item_id || item.id || ''];
  return expected && url === expected ? {url, label: 'Product reference'} : null;
}
