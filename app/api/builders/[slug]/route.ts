import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
export async function GET(_r:NextRequest,{params}:{params:Promise<{slug:string}>}) {
 const {slug}=await params; const db=await createClient();
 if (!(await db.auth.getUser()).data.user) return NextResponse.json({error:'Unauthorized'},{status:401});
 const {data,error}=await db.from('builder_profiles').select('*, contacts(id,company,contact_name,email)').eq('slug',slug).single();
 return error ? NextResponse.json({error:'Builder not found'},{status:404}) : NextResponse.json({builder:data});
}
export async function POST(r:NextRequest,{params}:{params:Promise<{slug:string}>}) {
 const {slug}=await params; const db=await createClient();
 if (!(await db.auth.getUser()).data.user) return NextResponse.json({error:'Unauthorized'},{status:401});
 const {data:builder}=await db.from('builder_profiles').select('id').eq('slug',slug).single();
 if (!builder) return NextResponse.json({error:'Builder not found'},{status:404});
 let b;try{b=await r.json()}catch{return NextResponse.json({error:'Invalid JSON'},{status:400})}
 if (!b || typeof b.library_item_id!=='string' || !['standard','reference'].includes(b.relationship)) return NextResponse.json({error:'Choose a shared library product and relationship'},{status:400});
 // Proposals only. This operation never infers approval from a project selection.
 const {data,error}=await db.from('builder_library_selections').insert({builder_id:builder.id,library_item_id:b.library_item_id,relationship:b.relationship,approval:'proposed'}).select().single();
 if(error) return NextResponse.json({error:error.code==='23505'?'This library product is already linked to the builder':'Could not link product'},{status:409});
 return NextResponse.json({selection:data},{status:201});
}
export async function PATCH(r:NextRequest,{params}:{params:Promise<{slug:string}>}) {
 const {slug}=await params;const db=await createClient();
 if(!(await db.auth.getUser()).data.user)return NextResponse.json({error:'Unauthorized'},{status:401});
 let b;try{b=await r.json()}catch{return NextResponse.json({error:'Invalid JSON'},{status:400})}
 const {data:builder}=await db.from('builder_profiles').select('id,schedule_templates').eq('slug',slug).single();
 if(!builder)return NextResponse.json({error:'Builder not found'},{status:404});
 const template=Array.isArray(builder.schedule_templates)?builder.schedule_templates.find((t:{name:string})=>t.name===b.template_name):null;
 if(!template||typeof b.project_id!=='string')return NextResponse.json({error:'Choose a template and builder job'},{status:400});
 const {data:project}=await db.from('projects').select('id,settings,updated_at').eq('id',b.project_id).eq('builder_id',builder.id).is('deleted_at',null).single();
 if(!project)return NextResponse.json({error:'Builder job not found'},{status:404});
 const settings={...project.settings,builder_workspace:{...project.settings?.builder_workspace,template:template.name,sections:template.sections}};
 const {data,error}=await db.from('projects').update({settings}).eq('id',project.id).eq('updated_at',project.updated_at).select('id').single();
 return error?NextResponse.json({error:'Job changed. Reload and try again.'},{status:409}):NextResponse.json({project:data});
}
