import { NextRequest, NextResponse } from 'next/server';
import { revisionAccess } from '@/lib/revisions/access';
import { validatePayload } from '@/lib/revisions/model';
type Context={params:Promise<{id:string;revisionId:string}>};
export async function GET(_req:NextRequest,{params}:Context){
 const access=await revisionAccess();if(access.error)return access.error;
 const {id,revisionId}=await params;
 const {data:workspace,error}=await access.db.from('job_revision_workspaces').select('*').eq('project_id',id).eq('id',revisionId).maybeSingle();
 if(error)return NextResponse.json({error:'Could not load workspace.'},{status:500});
 const source=workspace?.source_version_id??revisionId;
 const {data:version}=await access.db.from('estimate_versions').select('*').eq('project_id',id).eq('id',source).not('frozen_job_hash','is',null).maybeSingle();
 if(!version?.snapshot?.full_job_revision)return NextResponse.json({error:'Frozen job not found.'},{status:404});
 return NextResponse.json({workspace,version},{headers:{'Cache-Control':'private, no-store'}});
}
export async function PATCH(req:NextRequest,{params}:Context){
 const access=await revisionAccess();if(access.error)return access.error;
 try{
 const {id,revisionId}=await params,body=await req.json();
 validatePayload(body.payload);
 if(body.payload.project_id!==id||!Number.isInteger(body.expected_version)||!body.source_hash||!body.request_id)throw new Error('Invalid revision save.');
 const {data,error}=await access.db.rpc('save_job_revision',{project:id,workspace:revisionId,source_hash:body.source_hash,expected_version:body.expected_version,payload:body.payload,request:body.request_id});
 if(error)return NextResponse.json({error:'Revision conflict or invalid save. Reload before saving; your draft has been retained.'},{status:409});
 return NextResponse.json({workspace:data},{headers:{'Cache-Control':'private, no-store'}});
 }catch(error){return NextResponse.json({error:error instanceof Error?error.message:'Invalid revision save.'},{status:400});}
}
