// Indicative digital references, never an approved product, coating or sheen.
const colorbondSupport = {
  kind: 'manufacturer' as const, brand: 'COLORBOND', company: 'BlueScope / COLORBOND', phone: '1800 022 999',
  contactUrl: 'https://colorbond.com/contact',
};
// Classic palette digital values only; these do not nominate a product finish.
const surfmist = {
  ...colorbondSupport,
  colour: 'Surfmist', hex: '#E4E2D5',
  reference: 'COLORBOND Surfmist Classic palette colour reference',
  source: 'https://colorbond.com/colours/surfmist',
};
const gully = {
  ...colorbondSupport,
  colour: 'Gully', hex: '#857E73',
  reference: 'COLORBOND Gully Classic palette colour reference',
  source: 'https://colorbond.com/colours/gully',
};
const grain = {
  kind: 'manufacturer' as const, colour: 'Natural Grain', brand: 'Dulux', hex: '#D6CDC2',
  reference: 'Dulux Natural Grain · Atlas SN3D2',
  source: 'https://www.dulux.com.au/specifier/colour/naturals-sn3/natural-grain/',
  company: 'Dulux Help & Advice', phone: '13 25 25',
  contactUrl: 'https://www.dulux.com.au/contact-us/',
};
const white = {
  kind: 'generic' as const, colour: 'White', hex: '#FFFFFF',
  reference: 'Indicative white; exact shade TBC',
};
const references: Record<string, typeof surfmist | typeof white> = {
  '23303bed-85a1-46a8-a732-c92135ca32f9': surfmist,
  '8621dd28-0a6d-464d-8b68-e2d5a2cb12d4': gully,
  '59703871-a632-4ebf-88b7-248ac4c1433c': gully,
  '806c6447-7886-4eff-b69c-2024a6a4729f': gully,
  '0ea76bcd-4db7-4b0c-8004-b1f0757c6563': grain,
  '3499dbf9-1b87-403a-ba15-282372c644f2': white,
};
export function scheduleColourReference(item: {
  id?: string; library_item_id?: string | null; colour: string | null; brand?: string | null;
}) {
  const reference = references[item.library_item_id || item.id || ''];
  return reference && item.colour?.trim().toLowerCase() === reference.colour.toLowerCase()
    && (reference.kind === 'generic' ? !item.brand?.trim()
      : item.brand?.trim().toLowerCase() === reference.brand.toLowerCase()) ? reference : null;
}
