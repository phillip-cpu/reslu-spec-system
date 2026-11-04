// Manufacturer digital references, never an approved product, coating or sheen.
const jasper = {
  colour: 'Jasper', brand: 'COLORBOND', hex: '#6C6153',
  reference: 'COLORBOND Jasper Classic colour reference',
  source: 'https://colorbond.com/colours/jasper',
  company: 'BlueScope / COLORBOND', phone: '1800 022 999',
  contactUrl: 'https://colorbond.com/contact',
};
const grain = {
  colour: 'Natural Grain', brand: 'Dulux', hex: '#D6CDC2',
  reference: 'Dulux Natural Grain · Atlas SN3D2',
  source: 'https://www.dulux.com.au/specifier/colour/naturals-sn3/natural-grain/',
  company: 'Dulux Help & Advice', phone: '13 25 25',
  contactUrl: 'https://www.dulux.com.au/contact-us/',
};
const references: Record<string, typeof jasper> = {
  '23303bed-85a1-46a8-a732-c92135ca32f9': jasper,
  '8621dd28-0a6d-464d-8b68-e2d5a2cb12d4': jasper,
  '59703871-a632-4ebf-88b7-248ac4c1433c': jasper,
  '806c6447-7886-4eff-b69c-2024a6a4729f': jasper,
  '0ea76bcd-4db7-4b0c-8004-b1f0757c6563': grain,
};
export function scheduleColourReference(item: {
  id?: string; library_item_id?: string | null; colour: string | null; brand?: string | null;
}) {
  const reference = references[item.library_item_id || item.id || ''];
  return reference && item.colour?.trim().toLowerCase() === reference.colour.toLowerCase()
    && item.brand?.trim().toLowerCase() === reference.brand.toLowerCase() ? reference : null;
}
