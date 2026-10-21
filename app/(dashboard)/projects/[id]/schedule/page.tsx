import Link from 'next/link';
import {notFound} from 'next/navigation';
import {createClient} from '@/lib/supabase/server';
import {Header} from '@/components/layout/Header';
import {LotSchedule} from '@/components/builders/LotSchedule';
import {projectLots} from '@/lib/builder-workspaces';
export default async function SchedulePage({params}:{params:Promise<{id:string}>}) {
 const {id}=await params;const db=await createClient();
 const {data:project}=await db.from('projects').select('id,name,settings,builder_id,builder_profiles(slug,name)').eq('id',id).is('deleted_at',null).single();
 if(!project?.builder_id)notFound();
 const {data,error}=await db.from('items').select('id,item_code,name,category,description,library_item_id,selection_scope,selection_key,colour,finish,product_url,client_approved,scraped_documents,library_items(spec_sheet_url,install_manual_url)').eq('project_id',id).is('deleted_at',null).order('category').order('item_code');
 const {data:products}=await db.from('library_items').select('id,name,category').order('name').limit(1000);
 const builder=project.builder_profiles as unknown as {slug:string;name:string};
 return <><Header title={project.name} subtitle={builder.name} subtitleHref={`/builders/${builder.slug}`}/><main className="px-4 md:px-8 py-8"><div className="flex flex-wrap gap-5 text-body mb-7"><Link href={`/builders/${builder.slug}`} className="underline">Back to builder jobs</Link><Link href={`/projects/${id}?tab=ffe`} className="underline">FF&amp;E register</Link><Link href="/library" className="underline">Fixtures &amp; Fittings library</Link><Link href={`/projects/${id}`} className="underline">Project overview</Link></div>{error?<p role="alert">Could not load selections. Please reload.</p>:<LotSchedule projectId={id} lots={projectLots(project.settings)} items={(data??[]) as unknown as Parameters<typeof LotSchedule>[0]['items']} products={products??[]}/>}</main></>;
}
