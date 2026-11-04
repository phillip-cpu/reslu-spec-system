import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import ts from 'typescript';

const require=createRequire(import.meta.url);
const renderer=await import('@react-pdf/renderer');
function load(file,mocks={}) {
  const exports={};
  const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  new Function('require','exports',code)(name=>mocks[name]??require(name),exports);
  return exports;
}
const grouping=load('lib/schedule-grouping.ts');
const references=load('lib/schedule-pdf-references.ts',{'./schedule-colour-references':load('lib/schedule-colour-references.ts')});
const {SchedulePdf}=load('components/pdf/SchedulePdf.tsx',{'@react-pdf/renderer':renderer,'@/lib/schedule-grouping':grouping,'@/lib/schedule-pdf-references':references});
const categories=[['SW','Sanitaryware'],['TW','Tapware & Accessories'],['PF','Paint'],['DR','Doors'],['HD','Cabinet Hardware'],['TL','Tiles'],['EL','Electrical']].map(([prefix,name],sort_order)=>({prefix,name,sort_order}));
const items=[];
function add(room,category,name,note='',extra={}) {
  const id=`fixture-${items.length}`;
  items.push({id,category,name,item_code:'Proposed',rooms:room?[{id:room,name:room}]:[],location:room??'Room TBC',quantity:null,quantityLabel:'QTY TBC\nper lot\nPROPOSED / PRELIMINARY',displayNote:note,selected_image_url:null,...extra});
}
for(const lot of ['58','59']) {
  add(`Lot ${lot} · BATH`,'TW','Mizu Drift basin mixer - synthetic fixture','Final specification and procurement approval unconfirmed.',{finish:'Polished Chrome',library_item_id:'cac3cdf4-c4b7-4ba7-b6cc-fcf675198edc',product_url:'https://www.reece.com.au/product/mizu-drift-basin-mixer-tap-straight-spout-chrome-2267195'});
  add(`Lot ${lot} · BATH`,'PF','Ceiling paint — colour / finish TBC');
  add(`Lot ${lot} · BATH`,'SW','Posh Domaine semi-inset basin - synthetic fixture','Quantity remains TBC.',{finish:'White'});
  add(`Lot ${lot} · BATH`,'TL','Wall tiles — selection / finish TBC');
  add(`Lot ${lot} · BATH`,'TW','Synthetic long-name fixture: Mizu Drift Sink Mixer Extended Lever with Red & Blue Indicators Chrome (5 Star) Lead Free, with a deliberately extended product applicability title to exercise wrapping alongside notes, dimensions, quantity labels and its exact reference link.',
    'Quantity, final specification and procurement approval unconfirmed. '.repeat(5)+'\nFinal note marker.',
    {width_mm:900,height_mm:519,length_mm:1000,depth_mm:430,finish:'Polished Chrome',library_item_id:'8b9349f6-ea9e-4b91-b113-01c6ba9ee0ca',product_url:'https://www.reece.com.au/product/mizu-drift-sink-mixer-extended-lever-with-red-36317'});
  for(let i=0;i<12;i++)add(`Lot ${lot} · Entry`,'DR',`Door hardware fixture ${i+1} - satin stainless steel`,'Historical preliminary source; handing and specification require confirmation before ordering. Not procurement approval.',{finish:'Satin stainless steel'});
  // Name deliberately mentions a door: the actual code HD still maps to Cabinet Hardware.
  add(`Lot ${lot} · Entry`,'HD','Cabinet door handle - category HD fixture');
  add(`Lot ${lot} · Laundry external`,'DR','Laundry external door hardware - unchanged label fixture');
  add(`Lot ${lot} · LIVING 1`,'PF','Cornice finish — colour / finish TBC');
  add(`Lot ${lot} · LIVING 1`,'TW','Mizu Drift sink mixer - synthetic fixture');
  add(`Lot ${lot} · LIVING 1`,'SW','Kitchenette sink - synthetic fixture');
  for(let i=0;i<14;i++)add(`Lot ${lot} · LIVING 2`,'TW',`Long category tapware fixture ${i+1}`,'Quantity, final specification and procurement approval unconfirmed. Sink mixer follows the living kitchenette, not the ensuite.');
  add(`Lot ${lot} · LIVING 2`,'PF','Skirting finish — colour / finish TBC');
  add(`Lot ${lot} · LIVING 3`,'TL','Floor tiles — selection / finish TBC');
  add(`Lot ${lot} · LIVING 3`,'EL','Clipsal switchgear - synthetic fixture');
}
add(null,'ZZ','Unknown category fixture - retain code');
add(null,'','Missing category fixture - Type TBC');
const props={project:{name:'Cara hierarchy review',client_name:'Synthetic fixtures - not a live export'},items,categories,generatedAt:'04/11/2026',scheduleSubtitle:'LOCAL FIXTURE - proposed / preliminary'};
const snapshot=JSON.stringify(props);
function flatten(node) {
  if(node==null||typeof node==='boolean')return [];
  if(Array.isArray(node))return node.flatMap(flatten);
  return [node,...(typeof node==='object'?flatten(node.props?.children):[])];
}
const text=node=>flatten(node).filter(value=>typeof value==='string'||typeof value==='number').join('');
const pages=document=>flatten(document.props.children).filter(node=>node?.type===renderer.Page).slice(1);
const sections=page=>flatten(page).filter(node=>typeof node==='object'&&node.key?.match(/-(start|continued)$/));
const inputById=new Map(items.map(item=>[item.id,item]));
const rows=node=>flatten(node).filter(child=>inputById.has(child?.key));
const document=SchedulePdf({...props,grouping:'room'});
const seen=[];
let previousRoom=null;
const seenRooms=new Set();
for(const page of pages(document)) {
  const roomTitles=flatten(page).filter(node=>node?.type===renderer.Text&&node.props.style.fontSize===22);
  assert.equal(roomTitles.length,1,'one dominant room heading per page');
  const pageRows=rows(page);
  assert.ok(pageRows.length,'no blank continuation page');
  const roomNames=new Set(pageRows.map(node=>inputById.get(node.key).rooms[0]?.name??'Room TBC'));
  assert.equal(roomNames.size,1,'different rooms never share a page');
  const room=[...roomNames][0];
  assert.equal(text(roomTitles[0]),room+(previousRoom===room?' - Continued':''),'room context repeats on every continuation page');
  if(previousRoom!==room)assert.ok(!seenRooms.has(room),'room pages remain contiguous');
  previousRoom=room;seenRooms.add(room);
  let lastOrder=-1;
  for(const section of sections(page)) {
    const sectionRows=rows(section);
    assert.ok(sectionRows.length,'category heading is never orphaned');
    const codes=new Set(sectionRows.map(node=>inputById.get(node.key).category));
    assert.equal(codes.size,1,'one actual category per subheading');
    const code=[...codes][0];
    const metadata=categories.find(category=>category.prefix===code);
    const label=metadata?.name||code||'Type TBC';
    const heading=section.props.children[0];
    assert.equal(text(heading),label+(section.key.endsWith('-continued')?'  ·  Continued':''));
    assert.ok(heading.props.style.fontSize<roomTitles[0].props.style.fontSize,'room heading dominates subheading');
    assert.ok((metadata?.sort_order??999)>=lastOrder,'catalogue order used within room');
    lastOrder=metadata?.sort_order??999;
    seen.push(...sectionRows.map(row=>row.key));
  }
}
assert.deepEqual(seen.toSorted(),items.map(item=>item.id).toSorted(),'all rows preserved exactly once');
assert.equal(JSON.stringify(props),snapshot,'inputs, scopes, quantities and status are unchanged');
assert.ok(seenRooms.has('Lot 58 · Laundry external')&&seenRooms.has('Lot 59 · Laundry external'),'Laundry external label preserved');
assert.ok(sections(pages(document).at(-1)).some(section=>text(section).includes('Type TBC')),'empty category remains explicit');
assert.ok(pages(document).some(page=>sections(page).some(section=>text(section.props.children[0])==='ZZ')),'unknown category code retained');

// Boundary: a near-full category must move the next category and its first row together.
const boundary=Array.from({length:9},(_,i)=>({...items[0],id:`boundary-${i}`,category:i<8?'SW':'TW',rooms:[{id:'boundary',name:'Boundary room'}],displayNote:undefined,product_url:null}));
const boundaryPages=pages(SchedulePdf({...props,items:boundary,grouping:'room'}));
assert.equal(boundaryPages.length,2);
assert.equal(sections(boundaryPages[1])[0].props.children[0].props.children[0],'Tapware & Accessories');
assert.equal(flatten(boundaryPages[1]).filter(node=>typeof node==='object'&&node.key?.startsWith('boundary-')).length,1);
assert.equal(pages(SchedulePdf({...props,items:[],grouping:'room'})).length,1,'empty schedule behavior retained');
const longName='Lot 58 · Combined allocation with a long room name / Living Dining Kitchen and adjacent circulation';
const longRoom=SchedulePdf({...props,items:items.slice(0,2).map(item=>({...item,rooms:[{id:'long-name',name:longName}]})),grouping:'room'});
assert.equal(pages(longRoom).length,1,'wrapped room heading fits with contents');
const noMetadata=SchedulePdf({...props,categories:[],items:items.slice(0,2),grouping:'room'});
assert.deepEqual(sections(pages(noMetadata)[0]).map(section=>text(section.props.children[0])),['PF','TW'],'missing metadata retains actual codes');

const output=path.resolve(process.env.PDF_HIERARCHY_OUTPUT??'../pdf-hierarchy-review');
fs.mkdirSync(output,{recursive:true});
for(const [mode,doc] of [['room',document],['type',SchedulePdf({...props,grouping:'type'})]]) {
  const file=path.join(output,`hierarchy-${mode}.pdf`);
  fs.writeFileSync(file,await renderer.renderToBuffer(doc));
  const extracted=execFileSync('pdftotext',['-layout',file,'-'],{encoding:'utf8'});
  assert.equal(extracted.split('\f').filter(page=>page.trim()).length,pages(doc).length+1,'no unplanned renderer overflow pages');
  assert.equal((extracted.match(/PROPOSED \/ PRELIMINARY/g)??[]).length,items.length,'all preliminary labels survive rendering');
  assert.ok(extracted.includes('colour / finish TBC')&&extracted.includes('selection / finish TBC'),'placeholder text retained');
  if(mode==='type')assert.ok(!flatten(doc).some(node=>node?.props?.style?.fontSize===22),'type mode has no room headings');
  console.log(`${mode}: ${pages(doc).length+1} pages, ${items.length} unchanged rows - ${file}`);
}
console.log('PASS: room/category hierarchy, metadata mapping, continuation, boundaries, placeholders, unknown/empty categories and exact row preservation');
