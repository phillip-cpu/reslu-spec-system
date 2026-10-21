'use client';
import {useState} from 'react';
/* Mirrors SchedulePdf's image / product details / dimensions and quantity row. */
type Summary = {
  application_note?: string | null; brand?: string | null; supplier?: string | null; default_image_url?: string | null;
  width_mm?: number | null; height_mm?: number | null; length_mm?: number | null; depth_mm?: number | null;
};
type Item = Summary & {
  name: string; category: string; colour: string | null; finish: string | null;
  selected_image_url?: string | null; is_candidate?: boolean; client_approved: boolean;
  quantity?: number | null; unit?: string;
};
export function ScheduleProductRow({item, product, supplier, contact, contactsUnavailable=false, contactNote, scopeLabel}: {
  item: Item; product: Summary; supplier?: string | null; contact: string | null;
  contactsUnavailable?: boolean; contactNote?: string; scopeLabel: string;
}) {
  const [failedImage,setFailedImage] = useState<string|null>(null);
  const image = product.default_image_url ?? item.selected_image_url;
  const dimensions = ([['W', product.width_mm], ['H', product.height_mm], ['L', product.length_mm], ['D', product.depth_mm]] as const)
    .filter(([, value]) => value != null).map(([label, value]) => `${label}${value}`).join(' × ');
  return <div className="grid grid-cols-[88px_minmax(0,1fr)] md:grid-cols-[112px_minmax(0,1fr)_180px] gap-4 md:gap-6 items-start">
    <div className="aspect-square bg-white border border-[#e2dcd1] flex items-center justify-center overflow-hidden">
      {/* Canonical supplier images use arbitrary domains, matching the existing register. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {image && failedImage !== image && /^https?:\/\//.test(image) ? <img src={image} alt={item.name} className="w-full h-full object-contain" loading="lazy" width={112} height={112} onError={()=>setFailedImage(image)}/> : <span className="text-caption text-charcoal/40">{image ? 'Image unavailable' : 'No image'}</span>}
    </div>
    <div className="min-w-0"><p className="label-caps text-charcoal/50">{item.category} · {scopeLabel}</p>
      <h4 className="font-display text-xl leading-tight mt-1">{item.name}</h4>
      <p className="text-body text-charcoal/65 mt-2">{[product.brand ?? item.brand, item.colour, item.finish].filter(Boolean).join(' · ') || 'Brand TBC'}</p>
      <dl className="text-caption mt-3 grid grid-cols-[66px_minmax(0,1fr)] gap-x-2 gap-y-1">
        <dt className="text-charcoal/50">Supplier</dt><dd>{supplier || 'TBC'}</dd>
        <dt className="text-charcoal/50">Contact</dt><dd title={contactNote}>{contact}{contact && contactNote ? ' · source' : ''}{!contact && (contactsUnavailable ? 'Unavailable' : 'TBC')}</dd>
      </dl>
    </div>
    <div className="col-start-2 md:col-start-auto text-body md:text-right space-y-2">
      <p className="text-charcoal/70">{dimensions ? `${dimensions} mm` : product.application_note ? 'See drawing' : 'Dimensions TBC'}</p>
      <p>Qty {item.is_candidate || item.quantity == null ? 'TBC' : `${item.quantity} ${item.unit ?? ''}`}</p>
      <p className="label-caps text-charcoal/50">{item.is_candidate ? 'Proposed' : item.client_approved ? 'Approved' : 'To confirm'}</p>
    </div>
  </div>;
}
