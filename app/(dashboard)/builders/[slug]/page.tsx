import {notFound} from 'next/navigation';
import {createClient} from '@/lib/supabase/server';
import {Header} from '@/components/layout/Header';
import {WorkspaceSelector} from '@/components/builders/WorkspaceSelector';
import {BuilderProfile} from '@/components/builders/BuilderProfile';
export default async function BuilderPage({params}:{params:Promise<{slug:string}>}) {
 const {slug}=await params;const db=await createClient();
 const {data:builder}=await db.from('builder_profiles').select('*,contacts(contact_name,email)').eq('slug',slug).single();
 if(!builder)notFound();
 const [builders,projects,selections,products]=await Promise.all([
 db.from('builder_profiles').select('slug,name').order('name'),
 db.from('projects').select('id,name,settings').eq('builder_id',builder.id).is('deleted_at',null).neq('status','archived').order('updated_at',{ascending:false}),
 db.from('builder_library_selections').select('relationship,approval,library_items(id,name,category)').eq('builder_id',builder.id),
 db.from('library_items').select('id,name,category').order('name').limit(1000)]);
 const error=projects.error||selections.error||products.error;
 return <><Header title={builder.name} subtitle="Selections and schedules for repeat builder work" actions={<WorkspaceSelector builders={builders.data??[]} selected={slug}/>}/><main className="flex-1 px-4 md:px-8 py-8">{error?<p role="alert">Could not load builder workspace. Please reload.</p>:<BuilderProfile slug={slug} projects={projects.data??[]} selections={(selections.data??[]) as unknown as Parameters<typeof BuilderProfile>[0]['selections']} products={products.data??[]} contact={builder.contacts} templates={builder.schedule_templates}/>}</main></>;
}
