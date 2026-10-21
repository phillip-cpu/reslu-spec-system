'use client';
import { useRouter } from 'next/navigation';
export function WorkspaceSelector({ builders, selected = '' }: { builders: {slug:string;name:string}[]; selected?:string }) {
 const router=useRouter();
 return <label className="block text-body"><span className="block label-caps mb-2">Project workspace</span><select aria-label="Project workspace" value={selected} onChange={e=>router.push(e.target.value ? `/builders/${e.target.value}` : '/')} className="border border-[#c9c2b4] bg-offwhite px-3 py-2 min-w-[200px]"><option value="">RESLU projects</option>{builders.map(b=><option key={b.slug} value={b.slug}>{b.name}</option>)}</select></label>;
}
