import test from 'node:test';
import assert from 'node:assert/strict';
import {projectLots,resolveLotSchedule,projectCandidates,withProjectCandidates} from './builder-workspaces.ts';
test('lot overrides replace only the same slot, preserving the shared scheme and canonical identity',()=>{
 const items=[{id:'wall',library_item_id:'lib-wall',selection_scope:'shared',selection_key:'wall'}, {id:'masonry',library_item_id:'lib-a',selection_scope:'shared',selection_key:'masonry'}, {id:'lot58',library_item_id:'lib-b',selection_scope:'lot58',selection_key:'masonry'}, {id:'lot59',library_item_id:'lib-c',selection_scope:'lot59',selection_key:'masonry'}];
 assert.deepEqual(resolveLotSchedule(items,'lot58').map(i=>i.id),['wall','lot58']);
 assert.deepEqual(resolveLotSchedule(items,'lot59').map(i=>i.id),['wall','lot59']);
 assert.deepEqual(resolveLotSchedule(items,'shared').map(i=>i.id),['wall','masonry']);
 assert.equal(resolveLotSchedule(items,'lot58')[0].library_item_id,'lib-wall');
 assert.equal(items.length,4);
});
test('unassigned legacy items stay shared; malformed lot metadata is ignored',()=>{
 assert.deepEqual(resolveLotSchedule([{id:'legacy'}],'lot58'),[{id:'legacy'}]);
 assert.deepEqual(projectLots({builder_workspace:{lots:[{key:'lot58',label:'Lot 58'},null,{key:'shared',label:'Bad'},{key:'not valid',label:'Bad'}]}}),[{key:'lot58',label:'Lot 58'}]);
 assert.deepEqual(projectLots(null),[]);
});

test('unconfirmed candidates preserve project settings and cannot carry costable quantities, prices, or approvals',()=>{
 const original={unrelated:{keep:true},builder_workspace:{lots:[{key:'lot58',label:'Lot 58'}],template:'Paired homes'}};
 const candidate={id:'candidate',library_item_id:'canonical',selection_scope:'shared',selection_key:null,quantity:999,price_trade:123,client_approved:true};
 const cleaned=projectCandidates({builder_workspace:{candidates:[candidate]}});
 assert.deepEqual(Object.keys(cleaned[0]).sort(),['id','library_item_id','selection_key','selection_scope']);
 const next=withProjectCandidates(original,cleaned);
 assert.deepEqual(next.unrelated,{keep:true});assert.equal(next.builder_workspace.template,'Paired homes');
 assert.deepEqual(projectCandidates(original),[]);assert.equal(projectCandidates(next)[0].library_item_id,'canonical');
});
