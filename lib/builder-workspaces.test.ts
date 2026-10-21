import test from 'node:test';
import assert from 'node:assert/strict';
import {projectLots,resolveLotSchedule} from './builder-workspaces.ts';
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
