import {createHash} from 'node:crypto';
import {NextRequest,NextResponse} from 'next/server';
import {revisionAccess} from '@/lib/revisions/access';
import {ASSET_BUCKET} from '@/lib/storage';
/** Serve the preserved ORIGINAL bytes, never regenerate a sent proposal. */
export async function GET(_req:NextRequest,{params}:{params:Promise<{id:string;revisionId:string}>}){
 const access=await revisionAccess();if(access.error)return access.error;
 const {id,revisionId}=await params;
 const {data:workspace}=await access.db.from('job_revision_workspaces').select('source_version_id').eq('project_id',id).eq('id',revisionId).maybeSingle();
 const {data:version}=await access.db.from('estimate_versions').select('snapshot').eq('project_id',id).eq('id',workspace?.source_version_id??revisionId).not('frozen_job_hash','is',null).maybeSingle();
 const artifact=version?.snapshot?.full_job_revision?.sent_pdf;
 if(!artifact)return NextResponse.json({error:'Frozen artifact not found.'},{status:404});
 if(typeof artifact.storage_path!=='string'||!artifact.storage_path.startsWith(`projects/${id}/files/`))return NextResponse.json({error:'Exact sent PDF has not yet been registered in approved private storage.'},{status:409});
 const {data,error}=await access.db.storage.from(ASSET_BUCKET).download(artifact.storage_path);
 if(error||!data)return NextResponse.json({error:'Preserved artifact unavailable.'},{status:404});
 const bytes=Buffer.from(await data.arrayBuffer());
 if(bytes.length!==artifact.bytes||createHash('sha256').update(bytes).digest('hex')!==artifact.sha256)return NextResponse.json({error:'Artifact integrity check failed. The frozen reference has not been changed.'},{status:409});
 return new NextResponse(bytes,{headers:{'Content-Type':'application/pdf','Content-Disposition':'inline; filename="frozen-sent-proposal.pdf"','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
}
