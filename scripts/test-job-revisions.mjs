import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { revisionFixture } from '../lib/revisions/fixture.ts';
import { cloneRevision, editRevision, ownedRows, revisionEstimate, paymentValidation, validatePayload } from '../lib/revisions/model.ts';
import { createRevisionTransport } from '../lib/revisions/adapter.ts';
let checks=0;const test=async(name,fn)=>{await fn();checks++;console.log('PASS',name)};
const frozen=revisionFixture(),source=JSON.stringify(frozen),p=frozen.payload;
let draft=cloneRevision(p,randomUUID);
await test('complete clone has independent IDs, source identities, room links and trade headings',()=>{
 const originals=new Set(ownedRows(p).map(r=>r.id));for(const r of ownedRows(draft)){assert(!originals.has(r.id));assert(originals.has(r.origin_id));}
 assert.equal(draft.sections[0].lines[0].item_id,draft.items[0].id);assert.equal(draft.items[0].measurement_id,draft.measurement_groups[0].measurements[0].id);
 assert.deepEqual(draft.rooms,p.rooms);assert.deepEqual(draft.scope.sections[0].trade_heading_overrides,p.scope.sections[0].trade_heading_overrides);assert.equal(draft.scope.sections[0].source_room_id,p.rooms[0].id);
 assert.equal(draft.item_rooms[0].item_id,draft.items[0].id);assert.equal(draft.item_rooms[0].room_id,p.rooms[0].id);
});
await test('existing estimate and FF&E math gives identical selling totals; actuals are not cloned',()=>{
 const a=revisionEstimate(p),b=revisionEstimate(draft);assert.equal(a.wholeJob.combinedIncGst,b.wholeJob.combinedIncGst);assert.equal(b.rollup.actualExGst,0);
 assert.equal(draft.sections[0].lines[0].actual_paid_ex_gst,null);assert.deepEqual(draft.sections[0].lines[0].source_payments,[]);assert.equal(draft.items[0].ordered_at,null);
});
await test('FF&E cost/quantity/markup, measurement and scope edits never touch source',()=>{
 draft=editRevision(draft,{entity:'items',action:'patch',id:draft.items[0].id,values:{price_trade:90,quantity:9,markup_pct:.4}}).payload;
 draft=editRevision(draft,{entity:'measurements',action:'patch',id:draft.measurement_groups[0].measurements[0].id,values:{value:7}}).payload;
 draft=editRevision(draft,{entity:'scope_lines',action:'patch',id:draft.scope.sections[0].lines[0].id,values:{text:'Changed only V3'}}).payload;
 assert.notEqual(revisionEstimate(draft).wholeJob.combinedIncGst,revisionEstimate(p).wholeJob.combinedIncGst);assert.equal(JSON.stringify(frozen),source);
});
await test('95.5% payment draft is preserved and reported incomplete, no guessed reallocation',()=>{
 const bad=structuredClone(draft);bad.payments[1].percent=90.5;assert.deepEqual(paymentValidation(bad),{total:95.5,remaining:4.5,valid:false});assert.equal(paymentValidation(draft).valid,true);
});
await test('invalid relationships and non-finite financial values roll back atomically',()=>{
 const before=JSON.stringify(draft);assert.throws(()=>editRevision(draft,{entity:'items',action:'patch',id:draft.items[0].id,values:{measurement_id:randomUUID()}}),/relationship|measurement/);
 assert.throws(()=>editRevision(draft,{entity:'markup',action:'patch',values:{markup_pct:NaN}}));assert.equal(JSON.stringify(draft),before);
 assert.throws(()=>editRevision(draft,{entity:'lines',action:'patch',id:draft.sections[0].lines[0].id,values:{actual_paid_ex_gst:99}}),/Cannot edit/);
});
await test('existing editor transport handles edits and denies ALL live fallback/accounting/issue endpoints',async()=>{
 const transport=createRevisionTransport(()=>draft,e=>{const r=editRevision(draft,e);draft=r.payload;return r;});
 let r=await transport(`/api/estimate/lines/${draft.sections[0].lines[0].id}`,{method:'PATCH',body:JSON.stringify({description:'Adapter edit',cost_ex_gst:400,actual_paid_ex_gst:null,gst_treatment:'gst',forecast_fx_rate:null})});assert.equal(r.status,200);
 for(const url of ['/api/email/send','/api/projects/other/items',`/api/estimate/lines/${draft.sections[0].lines[0].id}/source-payments`,`/api/projects/${draft.project_id}/sow/${draft.scope.document.id}/issue`])assert.equal((await transport(url,{method:'POST',body:'{}'})).status,409);
 assert.equal((await transport(`/api/projects/${draft.project_id}/items`)).status,200);
 const ro=createRevisionTransport(()=>p,()=>{throw Error('must not mutate')},true);assert.equal((await ro('/api/estimate/lines/x',{method:'DELETE'})).status,409);
});
await test('snapshot round-trip preserves every editable field and relationship',()=>{const restored=JSON.parse(JSON.stringify(draft));validatePayload(restored);assert.deepEqual(restored,draft);assert.deepEqual(revisionEstimate(restored),revisionEstimate(draft));});

const {priceRevisionVariation}=await import('../lib/revisions/variation-pricing.ts');
await test('removing a $5,000 window preserves the original $80,000 profit; additions add 20% profit',()=>{
 const base=revisionFixture().payload;base.items=[];base.item_rooms=[];base.item_components=[];base.markup_pct=.2;
 base.sections[0].lines=[{id:randomUUID(),section_id:base.sections[0].id,description:'Remaining job',cost_ex_gst:395000,quoted_to_client_ex_gst:null,measurement_id:null,item_id:null},{id:randomUUID(),section_id:base.sections[0].id,description:'Window',cost_ex_gst:5000,quoted_to_client_ex_gst:null,measurement_id:null,item_id:null}];
 const revised=cloneRevision(base,randomUUID);revised.sections[0].lines.pop();
 let quote=priceRevisionVariation(base,revised);assert.equal(quote.baseline_profit_ex_gst,80000);assert.equal(quote.profit_ex_gst,80000);assert.equal(quote.selling_delta_ex_gst,-5000);assert.equal(quote.selling_ex_gst,475000);assert.equal(quote.total_inc_gst,522500);
 revised.sections[0].lines.push({id:randomUUID(),section_id:revised.sections[0].id,description:'Added door',cost_ex_gst:2000,quoted_to_client_ex_gst:null});quote=priceRevisionVariation(base,revised);
 assert.equal(quote.profit_added_ex_gst,400);assert.equal(quote.profit_ex_gst,80400);assert.equal(quote.selling_delta_ex_gst,-2600);
});
await test('partial quantity reductions preserve profit; FF&E additions use percentage units',()=>{
 const base=revisionFixture().payload,copy=cloneRevision(base,randomUUID);copy.measurement_groups[0].measurements[0].value=1;
 const q=priceRevisionVariation(base,copy);assert.equal(q.profit_added_ex_gst,0);assert.equal(q.profit_ex_gst,q.baseline_profit_ex_gst);
 copy.items.push({...copy.items[0],id:randomUUID(),origin_id:undefined,measurement_id:null,quantity:1,price_trade:100,markup_pct:30});
 assert.equal(priceRevisionVariation(base,copy).profit_added_ex_gst,30);
});

const {revisionChangeSummary}=await import('../lib/revisions/change-summary.ts');
await test('change summary ignores cloned identities/actuals but exposes scope, pricing and payment edits',()=>{
 const baseline=revisionFixture().payload,copy=cloneRevision(baseline,randomUUID);assert.deepEqual(revisionChangeSummary(baseline,copy),[]);
 copy.scope.sections[0].lines[0].text='New scope wording';copy.payments[0].percent=6;copy.items[0].price_trade=150;
 const changes=revisionChangeSummary(baseline,copy);assert.equal(changes.length,3);assert(changes.some(c=>c.group==='Scope lines'&&c.fields[0].before==='Synthetic build scope'));
});
console.log(`${checks} revision model/adapter/pricing checks passed.`);
