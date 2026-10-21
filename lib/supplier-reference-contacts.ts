// Verified source-package relationship, shared by library products; never a
// project appointment or an Address Book record. Explicit links take precedence.
const reeceHarvardReference = {
  name: 'Georgia Temple',
  branch: 'Reece Plumbing St Agnes',
  phone: '(08) 8397 5210',
  email: 'StAgnes.Showroom.SA@reece.com.au',
  provenance: 'Source-package contact: Reece quote 422108411, Lindsay Court, 19 March 2026, slides 1 and 67. Supplied by David as a selections reference; not independently confirmed for Cara.',
};
export function supplierReferenceContact(product: {supplier?: string | null; tags?: string[] | null}) {
  return product.supplier?.trim().toLowerCase() === 'reece' && product.tags?.includes('reece-reference')
    ? reeceHarvardReference : null;
}
