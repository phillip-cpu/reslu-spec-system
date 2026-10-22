import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveCandidateRoomNames,parseCandidateAllocations,projectCandidates,withProjectCandidates,patchCandidate,candidateRooms,candidateAllocationsForScope,resolveLotSchedule} from './builder-workspaces.ts';
import {groupSchedule} from './schedule-grouping.ts';
const allocation={room:'Entry',lot_key:'lot59',quantity:4,unit:'ea',lot_basis:'per_lot',status:'preliminary',source_reference:'Hardware schedule p3',source_revision:'May',note:'Handing TBC',quantity_basis:'preliminary_schedule'} as const;
const candidate={id:'c',library_item_id:'canonical',selection_scope:'shared_internal',selection_key:'door'};
test('43 candidate round trip preserves provenance, workspace metadata and image references without exposing costing fields',()=>{
 const rows=Array.from({length:43},(_,i)=>({...candidate,id:String(i),source:{page:3},provenance:['audit'],image_reference:'canonical-image',quantity:99,price_trade:100,client_approved:true}));
 const settings={other:'keep',builder_workspace:{lots:[{key:'lot59',label:'Lot 59'}],candidates:rows}};
 const parsed=projectCandidates(settings).map((c,i)=>i===0?patchCandidate(c,{preliminary_allocations:[allocation]}):c);
 const next=withProjectCandidates(settings,parsed);
 assert.equal(next.builder_workspace.candidates.length,43);
 assert.deepEqual(next.builder_workspace.candidates[1],rows[1]);
 assert.deepEqual((next.builder_workspace.candidates[0] as unknown as typeof rows[0]).source,{page:3});
 const reread=projectCandidates(JSON.parse(JSON.stringify(next)));
 assert.deepEqual(reread[0].preliminary_allocations,[allocation]);
 assert.equal('quantity' in reread[0],false);assert.equal('price_trade' in reread[0],false);assert.equal('client_approved' in reread[0],false);
 assert.equal(next.other,'keep');assert.equal(reread[0].selection_scope,'shared_internal');
 assert.deepEqual(patchCandidate(reread[0],{selection_key:' revised '}).preliminary_allocations,[allocation]);
});
test('unknown is null, zero remains explicit, invalid quantities/units/bases and oversized sources are rejected',()=>{
 assert.equal(parseCandidateAllocations([{...allocation,quantity:null,unit:null,lot_basis:'unknown'}])[0].quantity,null);
 assert.equal(parseCandidateAllocations([{...allocation,quantity:0}])[0].quantity,0);
 for(const quantity of [-1,NaN,Infinity,'4',undefined])assert.throws(()=>parseCandidateAllocations([{...allocation,quantity}]));
 for(const patch of [{unit:''},{unit:null},{lot_basis:'unknown'},{status:'approved'},{room:''},{source_reference:'x'.repeat(1001)}])assert.throws(()=>parseCandidateAllocations([{...allocation,...patch}]));
 assert.deepEqual(parseCandidateAllocations([]),[]);
});
test('Lot59-only evidence never becomes a Lot58/shared count; multiple rooms group once by room or type',()=>{
 const allocations=parseCandidateAllocations([allocation,{...allocation,room:'Laundry',quantity:null}]);
 assert.equal(candidateAllocationsForScope(allocations,'lot58').length,0);
 assert.equal(candidateAllocationsForScope(allocations,'shared').length,0);
 assert.equal(candidateAllocationsForScope(allocations,'lot59').length,2);
 const row={...candidate,category:'HW',preliminary_allocations:allocations,rooms:candidateRooms({preliminary_allocations:allocations})};
 assert.equal(resolveLotSchedule([row],'shared').length,1);
 assert.equal(groupSchedule([row],'room')[0].label,'Entry / Laundry');
 assert.equal(groupSchedule([row],'type')[0].items.length,1);
 assert.deepEqual(allocations.map(a=>a.quantity),[4,null]);
});

test('linked room renames display current names without mutating source snapshots',()=>{
 const rows=parseCandidateAllocations([{...allocation,room_id:'room-1'}]);
 assert.equal(resolveCandidateRoomNames(rows,[{id:'room-1',name:'Front entry'}])?.[0].room,'Front entry');
 assert.equal(rows[0].room,'Entry');
});
