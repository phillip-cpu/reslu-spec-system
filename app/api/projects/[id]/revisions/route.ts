import { NextRequest, NextResponse } from 'next/server';
import { revisionAccess } from '@/lib/revisions/access';
export async function GET(_req:NextRequest,{params}:{params:Promise<{id:string}>}){
 const access=await revisionAccess();if(access.error)return access.error;
 const {id}=await params;
 const [versions,workspaces]=await Promise.all([
  access.db.from('estimate_versions').select('id,label,frozen_job_hash,created_at').eq('project_id',id).not('frozen_job_hash','is',null).order('created_at'),
  access.db.from('job_revision_workspaces').select('id,label,source_version_id,source_hash,lock_version,updated_at').eq('project_id',id).order('created_at')]);
 if(versions.error||workspaces.error)return NextResponse.json({error:'Could not load revision workspaces.'},{status:500});
 return NextResponse.json({versions:versions.data,workspaces:workspaces.data},{headers:{'Cache-Control':'private, no-store'}});
}
export async function POST(req:NextRequest,{params}:{params:Promise<{id:string}>}){
 const access=await revisionAccess();if(access.error)return access.error;
 try{const {id}=await params,body=await req.json();
 if(typeof body.label!=='string'||!body.label.trim()||!body.source_version_id||!body.source_hash||!body.request_id)return NextResponse.json({error:'A frozen source, label and request identity are required.'},{status:400});
 const {data,error}=await access.db.rpc('fork_job_revision',{project:id,source:body.source_version_id,source_hash:body.source_hash,label:body.label.trim(),request:body.request_id});
 if(error)return NextResponse.json({error:'Could not fork: source changed, label conflict, or release unavailable.'},{status:409});
 return NextResponse.json({workspace:data},{headers:{'Cache-Control':'private, no-store'}});
 }catch{return NextResponse.json({error:'Invalid revision request.'},{status:400});}
}
