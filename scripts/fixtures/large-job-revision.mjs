// Synthetic fixture matching a full renovation's shape; never uses customer data.
import {randomUUID} from 'node:crypto';
import {revisionFixture} from '../../lib/revisions/fixture.ts';
export function largeRevisionFixture(){
 const frozen=revisionFixture(),p=frozen.payload;
 const trade=p.sections[0],line=trade.lines[0],item=p.items[0],scope=p.scope.sections[0],scopeLine=scope.lines[0];
 const padding='Synthetic specification detail for performance coverage. '.repeat(14);
 p.sections=Array.from({length:20},(_,n)=>{
  const id=randomUUID();return {...trade,id,name:`Synthetic trade ${n}`,sort:n,lines:Array.from({length:n<18?6:5},(_,j)=>({...line,id:randomUUID(),section_id:id,description:`Synthetic cost ${n}/${j}`,notes:padding,measurement_id:null,item_id:null}))};
 });
 p.items=Array.from({length:99},(_,n)=>({...item,id:randomUUID(),name:`Synthetic item ${n}`,description:padding,measurement_id:null}));
 p.scope.sections=Array.from({length:19},(_,n)=>{
  const id=randomUUID();return {...scope,id,heading:`Synthetic room scope ${n}`,sort:n,lines:Array.from({length:n<14?21:20},(_,j)=>({...scopeLine,id:randomUUID(),section_id:id,text:`Synthetic scope ${n}/${j}. ${padding}`,sort:j}))};
 });
 p.item_rooms=Array.from({length:101},(_,n)=>({...p.item_rooms[0],id:randomUUID(),item_id:p.items[n%99].id}));
 p.item_components[0].item_id=p.items[0].id;
 return frozen;
}
