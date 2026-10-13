import {accountingKeys,ownedRows,type JobRevisionPayload,type Row} from './model.ts';
const ignored=new Set(['id','origin_id','created_at','updated_at','created_by','issued_at','revision_label','status','lines','measurements',...accountingKeys]);
export function revisionChangeSummary(baseline:JobRevisionPayload,working:JobRevisionPayload){
 const ids=new Map(ownedRows(working).map(r=>[r.id,String(r.origin_id??r.id)]));
 const normalize=(value:unknown):unknown=>{
  if(typeof value==='string')return ids.get(value)??value;
  if(Array.isArray(value))return value.map(normalize);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,normalize(v)]));
  return value;
 };
 const describe=(r:Row)=>String(r.description??r.name??r.heading??r.text??r.label??r.id);
 const groups=(p:JobRevisionPayload):[string,Row[]][]=>[
  ['Estimate sections',p.sections],['Estimate lines',p.sections.flatMap(s=>s.lines)],['FF&E',p.items],['Measurement groups',p.measurement_groups],['Measurements',p.measurement_groups.flatMap(g=>g.measurements)],['Scope sections',p.scope.sections],['Scope lines',p.scope.sections.flatMap(s=>s.lines)],['Room allocations',p.item_rooms],['Components',p.item_components],['Allowances',p.allowances],['Options',p.options],['Payment drafts',p.payments]
 ];
 const result:{group:string;description:string;action:'added'|'removed'|'changed';fields:{name:string;before:unknown;after:unknown}[]}[]=[];
 const afterGroups=new Map(groups(working));
 for(const [group,oldRows] of groups(baseline)){
  const nextRows=new Map(afterGroups.get(group)!.map(r=>[String(r.origin_id??r.id),r]));
  for(const old of oldRows){
   const next=nextRows.get(old.id);nextRows.delete(old.id);
   if(!next){result.push({group,description:describe(old),action:'removed',fields:[]});continue;}
   const fields=[...new Set([...Object.keys(old),...Object.keys(next)])].filter(k=>!ignored.has(k)).filter(k=>JSON.stringify(normalize(old[k]??null))!==JSON.stringify(normalize(next[k]??null))).map(name=>({name,before:old[name]??null,after:next[name]??null}));
   if(fields.length)result.push({group,description:describe(next),action:'changed',fields});
  }
  for(const row of nextRows.values())result.push({group,description:describe(row),action:'added',fields:[]});
 }
 if(baseline.markup_pct!==working.markup_pct)result.unshift({group:'Pricing',description:'Default trade markup',action:'changed',fields:[{name:'markup_pct',before:baseline.markup_pct,after:working.markup_pct}]});
 return result;
}
