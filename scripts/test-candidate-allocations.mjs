import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
function load(file,mocks={}){const exports={};const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;new Function('require','exports',code)(n=>mocks[n]??require(n),exports);return exports;}
const model=load('lib/builder-workspaces.ts');
const allocation={room:'Entry',lot_key:'lot59',quantity:4,unit:'ea',lot_basis:'per_lot',status:'preliminary',source_reference:'p3'};
const original={id:'c',library_item_id:'lib',selection_scope:'shared_internal',selection_key:'door',source:{audit:'unchanged'},preliminary_allocations:[allocation]};
let settings,updates,conflict,authenticated;
function reset(){settings={other:'keep',builder_workspace:{lots:[{key:'lot59',label:'Lot 59'}],candidates:[structuredClone(original),{...original,id:'untouched'}]}};updates=[];conflict=false;authenticated=true;}
const db={auth:{getUser:async()=>({data:{user:authenticated?{id:'u'}:null}})},from(table){let update;const filters=[];const chain={select(){return chain},eq(...args){filters.push(args);return chain},is(){return chain},update(value){update=value;return chain},async single(){if(update){updates.push({table,update,filters});if(conflict)return {error:{message:'stale'}};settings=update.settings;return {data:{id:'project'}}}return {data:{id:'project',builder_id:'builder',settings,updated_at:'version'}}}};return chain}};
const {PATCH}=load('app/api/projects/[id]/schedule/route.ts',{'@/lib/builder-workspaces':model,'@/lib/supabase/server':{createClient:async()=>db},'next/server':{NextResponse:{json:(body,options)=>({body,status:options?.status??200})}}});
const patch=body=>PATCH({json:async()=>body},{params:Promise.resolve({id:'project'})});
reset();let response=await patch({item_id:'c',is_candidate:true,preliminary_allocations:[{...allocation,quantity:null}]});
assert.equal(response.status,200);assert.equal(updates.length,1);assert.equal(updates[0].table,'projects');assert.deepEqual(Object.keys(updates[0].update),['settings']);assert.deepEqual(updates[0].filters,[['id','project'],['updated_at','version']]);
assert.equal(settings.builder_workspace.candidates[0].selection_scope,'shared_internal');assert.deepEqual(settings.builder_workspace.candidates[0].source,original.source);assert.deepEqual(settings.builder_workspace.candidates[1],{...original,id:'untouched'});assert.equal(settings.builder_workspace.candidates[0].preliminary_allocations[0].quantity,null);
response=await patch({item_id:'c',is_candidate:true,selection_scope:'lot59',selection_key:'new'});assert.equal(response.status,200);assert.equal(settings.builder_workspace.candidates[0].preliminary_allocations[0].quantity,null);
for(const body of [{preliminary_allocations:[{...allocation,lot_key:'lot99'}]},{preliminary_allocations:[{...allocation,quantity:-1}]},{preliminary_allocations:[{...allocation,unit:''}]},{selection_scope:'invalid'},{selection_scope:'lot58'}]){reset();response=await patch({item_id:'c',is_candidate:true,...body});assert.equal(response.status,400);assert.equal(updates.length,0)}
reset();response=await patch({item_id:'missing',is_candidate:true,preliminary_allocations:[]});assert.equal(response.status,404);assert.equal(updates.length,0);
reset();response=await patch({item_id:'c',selection_scope:'shared',preliminary_allocations:[]});assert.equal(response.status,400);assert.equal(updates.length,0);
reset();conflict=true;assert.equal((await patch({item_id:'c',is_candidate:true,preliminary_allocations:[]})).status,409);
reset();authenticated=false;assert.equal((await patch({item_id:'c',is_candidate:true,preliminary_allocations:[]})).status,401);assert.equal(updates.length,0);
// Render to static HTML only: no browser, network, app or production access.
const {renderToStaticMarkup}=require('react-dom/server');const React=require('react');
const {ScheduleProductRow}=load('components/builders/ScheduleProductRow.tsx');
const markup=renderToStaticMarkup(React.createElement(ScheduleProductRow,{item:{name:'Door hardware',category:'HW',is_candidate:true,quantity:999,preliminary_allocations:[allocation,{...allocation,room:'Laundry',quantity:null}]},product:{default_image_url:'https://example.test/product.jpg'},contact:null,scopeLabel:'Shared'}));
for(const expected of ['Entry (lot59)','4 ea','Qty TBC','per lot','Proposed · preliminary','product.jpg'])assert.ok(markup.includes(expected),expected);
assert.ok(!markup.includes('999'));assert.ok(!markup.includes('Approved'));
console.log('PASS: PATCH round-trip, scope/provenance preservation, invalid input, auth, optimistic conflict, no item/cost/order writes, static proposed quantity/image rendering');
