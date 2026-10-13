import { createClient } from '@/lib/supabase/server';
import { getUserRole } from '@/lib/auth';
import { NextResponse } from 'next/server';
export const revisionsEnabled=()=>process.env.JOB_REVISION_WORKSPACES_ENABLED==='true';
export async function revisionAccess(){
  if(!revisionsEnabled())return {error:NextResponse.json({error:'Not found'},{status:404})} as const;
  const db=await createClient(), user=await getUserRole(db);
  if(!user)return {error:NextResponse.json({error:'Unauthorized'},{status:401})} as const;
  if(user.role!=='admin')return {error:NextResponse.json({error:'Restricted'},{status:403})} as const;
  return {db,user} as const;
}
