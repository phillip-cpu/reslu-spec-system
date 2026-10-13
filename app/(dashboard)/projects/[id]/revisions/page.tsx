import { notFound } from 'next/navigation';
import { revisionAccess } from '@/lib/revisions/access';
import { Header } from '@/components/layout/Header';
import { RevisionWorkspaceView } from '@/components/revisions/RevisionWorkspaceView';
export default async function Page({params}:{params:Promise<{id:string}>}){
 const access=await revisionAccess();if(access.error)notFound();
 const {id}=await params;
 return <><Header title="Job revisions" subtitle="Frozen baseline and independent working estimates"/><main className="flex-1 p-8"><RevisionWorkspaceView projectId={id}/></main></>;
}
