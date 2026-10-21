export type ScheduleGrouping = 'room' | 'type';
export interface ScheduleCategory {prefix:string;name:string;sort_order?:number}
interface Groupable {id:string;category:string;rooms?:{id:string;name:string}[]}

/** Presentation only: read item_rooms or explicit preliminary candidate allocations, never reference-deck
 * locations, occurrence counts or quantities. Multi-room products appear once
 * under their combined allocation, preserving one canonical row per selection. */
export function groupSchedule<T extends Groupable>(items:T[], mode:ScheduleGrouping, categories:ScheduleCategory[]=[]) {
  const categoryMap=new Map(categories.map(c=>[c.prefix,c]));
  const groups=new Map<string,{key:string;label:string;items:T[]}>();
  for(const item of items){
    const rooms=[...new Map((item.rooms??[]).filter(r=>r.id&&r.name.trim()).map(r=>[r.id,r])).values()].sort((a,b)=>a.name.localeCompare(b.name));
    const key=mode==='type'?item.category||'type-tbc':rooms.length?rooms.map(r=>r.id).sort().join('|'):'room-tbc';
    const label=mode==='type'?categoryMap.get(item.category)?.name||item.category||'Type TBC':rooms.length?rooms.map(r=>r.name).join(' / '):'Room TBC';
    const group=groups.get(key)??{key,label,items:[]};
    group.items.push(item);groups.set(key,group);
  }
  return [...groups.values()].sort((a,b)=>mode==='type'
    ? (categoryMap.get(a.key)?.sort_order??999)-(categoryMap.get(b.key)?.sort_order??999)||a.label.localeCompare(b.label)
    : a.key==='room-tbc'?1:b.key==='room-tbc'?-1:a.label.localeCompare(b.label));
}
