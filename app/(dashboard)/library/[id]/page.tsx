import Link from 'next/link';
import {notFound} from 'next/navigation';
import {Header} from '@/components/layout/Header';
import {createClient} from '@/lib/supabase/server';
import {ProductDocuments} from '@/components/library/ProductDocuments';
export default async function LibraryProductPage({params}:{params:Promise<{id:string}>}){
 const {id}=await params;const db=await createClient();
 const {data:product}=await db.from('library_items').select('id,name,brand,description,colour,finish,product_url,spec_sheet_url,install_manual_url').eq('id',id).single();
 if(!product)notFound();
 const {data:documents,error}=await db.from('library_product_documents').select('*').eq('library_item_id',id).order('created_at',{ascending:false});
 return <><Header title={product.name} subtitle="Fixtures & Fittings library" subtitleHref="/library"/><main className="px-4 md:px-8 py-8 max-w-5xl"><Link href="/library" className="text-body underline">Back to shared library</Link><p className="text-body mt-6">{[product.brand,product.colour,product.finish].filter(Boolean).join(' / ')}</p><p className="text-body text-charcoal/60 my-4">{product.description}</p><h2 className="font-display text-2xl mt-7 mb-4">Product documentation</h2><p className="text-body text-charcoal/60 mb-5">Owned by this canonical product and reused by every linked job. Document revisions do not approve or replace job selections.</p>{error&&<p role="alert">Could not load documentation.</p>}{[{label:'Existing specification sheet',url:product.spec_sheet_url},{label:'Existing installation manual',url:product.install_manual_url}].filter(d=>d.url&&/^https:\/\//.test(d.url)).map(d=><a key={d.label} href={d.url!} className="block underline text-body my-3" target="_blank" rel="noreferrer">{d.label}</a>)}{documents?.map(d=><article key={d.id} className="border-t border-[#dcd6cc] py-4 text-body"><a className="underline" href={d.url} target="_blank" rel="noreferrer">{d.label}</a><p className="text-charcoal/60 mt-2">{d.kind.replaceAll('_',' ')} / {d.version_note||'Revision not specified'}</p><p className="text-charcoal/40 mt-1">Added {d.created_at.slice(0,10)}</p></article>)}{!documents?.length&&!product.spec_sheet_url&&!product.install_manual_url&&<p className="text-body">No documentation recorded yet.</p>}<ProductDocuments id={id}/></main></>;
}
