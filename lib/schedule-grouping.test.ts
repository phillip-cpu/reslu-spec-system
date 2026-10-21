import test from 'node:test';
import assert from 'node:assert/strict';
import {groupSchedule} from './schedule-grouping.ts';
test('room grouping ignores reference locations and occurrences; grouping switches retain all 22 references unchanged',()=>{
 const rows=Array.from({length:22},(_,i)=>({id:String(i),category:i<5?'SW':'TW',reference_rooms:['Kitchen'],location:'Historical room',reference_appearance_count:9,quantity:null}));
 const before=JSON.stringify(rows);
 const room=groupSchedule(rows,'room');assert.equal(room.length,1);assert.equal(room[0].label,'Room TBC');
 const types=groupSchedule(rows,'type',[{prefix:'SW',name:'Sanitaryware',sort_order:20},{prefix:'TW',name:'Tapware & Accessories',sort_order:80}]);
 assert.deepEqual(types.map(g=>[g.label,g.items.length]),[['Sanitaryware',5],['Tapware & Accessories',17]]);
 for(const mode of ['room','type','room','type'] as const){const grouped=groupSchedule(rows,mode).flatMap(g=>g.items);assert.equal(grouped.length,22);assert.equal(new Set(grouped.map(i=>i.id)).size,22)}
 assert.equal(JSON.stringify(rows),before);
});
test('actual multi-room allocation appears once, unallocated last, with no per-room quantity inference',()=>{
 const allocated={id:'a',category:'SW',quantity:2,rooms:[{id:'k',name:'Kitchen'},{id:'l',name:'Laundry'},{id:'k',name:'Kitchen'}]};
 const groups=groupSchedule([{id:'b',category:'TW'},allocated],'room');
 assert.deepEqual(groups.map(g=>g.label),['Kitchen / Laundry','Room TBC']);
 assert.equal(groups.flatMap(g=>g.items).length,2);assert.equal(groups[0].items[0],allocated);assert.equal(allocated.quantity,2);
});
