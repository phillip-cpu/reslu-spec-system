'use client';
import type {CandidateAllocation} from '@/lib/builder-workspaces';
import {scheduleColourReference} from '@/lib/schedule-colour-references';
import {useState} from 'react';
/* Mirrors SchedulePdf's image / product details / dimensions and quantity row. */
type Summary = {
  application_note?: string | null; brand?: string | null; supplier?: string | null; default_image_url?: string | null;
  width_mm?: number | null; height_mm?: number | null; length_mm?: number | null; depth_mm?: number | null;
};
type Item = Summary & {
  id?: string; library_item_id?: string | null; name: string; category: string; colour: string | null; finish: string | null;
  selected_image_url?: string | null; is_candidate?: boolean; client_approved: boolean;
  quantity?: number | null; unit?: string; preliminary_allocations?: CandidateAllocation[];
};
export function ScheduleProductRow({item, product, supplier, contact, contactPhone, contactEmail, contactCompany, contactNote, contactsUnavailable=false, scopeLabel}: {
  item: Item; product: Summary; supplier?: string | null; contact: string | null;
  contactPhone?: string | null; contactEmail?: string | null; contactCompany?: string | null;
  contactsUnavailable?: boolean; contactNote?: string; scopeLabel: string;
}) {
  const [failedImage,setFailedImage] = useState<string|null>(null);
  const colourReference = scheduleColourReference({...item, brand: product.brand ?? item.brand});
  const image = product.default_image_url ?? item.selected_image_url;
  const dimensions = ([['W', product.width_mm], ['H', product.height_mm], ['L', product.length_mm], ['D', product.depth_mm]] as const)
    .filter(([, value]) => value != null).map(([label, value]) => `${label}${value}`).join(' × ');
  return <div className="grid grid-cols-[88px_minmax(0,1fr)] md:grid-cols-[112px_minmax(0,1fr)_180px] gap-4 md:gap-6 items-start">
    <div><div className="aspect-square bg-white border border-[#e2dcd1] flex items-center justify-center overflow-hidden">
      {/* Canonical supplier images use arbitrary domains, matching the existing register. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {colourReference ? <div role="img" aria-label={`${colourReference.reference}, indicative digital swatch ${colourReference.hex}`} className="w-full h-full" style={{backgroundColor:colourReference.hex}}/> : image && failedImage !== image && /^https?:\/\//.test(image) ? <img src={image} alt={item.name} className="w-full h-full object-contain" loading="lazy" width={112} height={112} onError={()=>setFailedImage(image)}/> : <span className="text-caption text-charcoal/40">{image ? 'Image unavailable' : 'No image'}</span>}
    </div>{colourReference && <p className="text-caption text-charcoal/60 mt-2">Indicative digital colour. Check a physical sample.</p>}</div>
    <div className="min-w-0"><p className="label-caps text-charcoal/50">{item.category} · {scopeLabel}</p>
      <h4 className="font-display text-xl leading-tight mt-1">{item.name}</h4>
      <p className="text-body text-charcoal/65 mt-2">{[product.brand ?? item.brand, item.colour].filter(Boolean).join(' · ') || 'Brand TBC'}</p>
      <dl className="text-body mt-3 grid grid-cols-1 sm:grid-cols-[80px_minmax(0,1fr)] gap-x-2 gap-y-1">
        <dt className="text-charcoal/50">Finish / sheen</dt><dd className="break-words">{item.finish?.trim() || 'TBC'}</dd>
        <dt className="text-charcoal/50">Supplier</dt><dd className="break-words">{supplier || 'TBC'}</dd>
        <dt className="text-charcoal/50">Contact</dt><dd className="min-w-0 break-words">{contact || (contactsUnavailable ? 'Unavailable' : 'TBC')}{contactCompany && contactCompany !== supplier && <span className="block">{contactCompany}</span>}{contactPhone && <a className="block underline" href={`tel:${contactPhone.replace(/[^+\d]/g,'')}`}>{contactPhone}</a>}{contactEmail && <a className="block underline break-all" href={`mailto:${contactEmail}`}>{contactEmail}</a>}{contactNote && <p className="text-charcoal/60 mt-1">{contactNote}</p>}</dd>
      </dl>
      {colourReference && <div className="text-caption text-charcoal/65 mt-3 space-y-1">
        <p><a className="underline" href={colourReference.source} target="_blank" rel="noreferrer">{colourReference.reference}</a></p>
        <p>Manufacturer support · {colourReference.company}: <a className="underline" href={`tel:${colourReference.phone.replace(/ /g,'')}`}>{colourReference.phone}</a> · <a className="underline" href={colourReference.contactUrl} target="_blank" rel="noreferrer">Contact manufacturer</a></p>
        <p>Project supplier and representative remain unassigned unless listed above. Colour reference only; product and finish / sheen remain to be confirmed.</p>
      </div>}
    </div>
    <div className="col-start-2 md:col-start-auto text-body md:text-right space-y-2">
      <p className="text-charcoal/70">{dimensions ? `${dimensions} mm` : product.application_note ? 'See drawing' : 'Dimensions TBC'}</p>
      {item.is_candidate && item.preliminary_allocations?.length ? item.preliminary_allocations.map((a,index)=><p key={index}>{a.room}{a.lot_key?` (${a.lot_key})`:''}: {a.quantity === null ? 'Qty TBC' : `${a.quantity} ${a.unit}`} · {a.lot_basis === 'per_lot' ? 'per lot' : a.lot_basis === 'project_total' ? 'project total' : 'basis TBC'}</p>) : <p>Qty {item.is_candidate || item.quantity == null ? 'TBC' : `${item.quantity} ${item.unit ?? ''}`}</p>}
      <p className="label-caps text-charcoal/50">{item.is_candidate ? 'Proposed · preliminary' : item.client_approved ? 'Approved' : 'To confirm'}</p>
    </div>
  </div>;
}
