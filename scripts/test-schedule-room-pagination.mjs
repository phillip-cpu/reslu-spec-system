import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import ts from 'typescript';

const require=createRequire(import.meta.url);
function load(file,mocks={}) {
  const exports={};
  const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  new Function('require','exports',code)(name=>mocks[name]??require(name),exports);
  return exports;
}
const renderer=await import('@react-pdf/renderer');
const grouping=load('lib/schedule-grouping.ts');
const references=load('lib/schedule-pdf-references.ts',{'./schedule-colour-references':load('lib/schedule-colour-references.ts')});
const {SchedulePdf}=load('components/pdf/SchedulePdf.tsx',{'@react-pdf/renderer':renderer,'@/lib/schedule-grouping':grouping,'@/lib/schedule-pdf-references':references});
const output=path.resolve(process.env.PDF_PAGINATION_OUTPUT??'../pdf-pagination-review');
fs.mkdirSync(output,{recursive:true});
const items=[];
for(const lot of ['58','59']) {
  for(const room of ['LIVING 1','LIVING 2','LIVING 3']) {
    // Living 2 is deliberately long enough to need continuation pages.
    for(let index=0;index<(room==='LIVING 2'?13:2);index++) {
      const label=`Lot ${lot} · ${room}`;
      items.push({id:`${lot}-${room}-${index}`,category:index%2?'SW':'TW',item_code:'Proposed',name:`${index%2?'Posh Solus Care Single Bowl Sink':'Mizu Drift Sink Mixer Extended Lever'} - fixture ${lot}-${room}-${index}`,rooms:[{id:label,name:label}],location:`${label} / Lot ${lot}`,brand:index%2?'Posh':'Mizu',finish:index%2?'Stainless Steel':'Polished Chrome',quantity:null,quantityLabel:'QTY TBC\nper lot\nPROPOSED / PRELIMINARY',displayNote:'Quantity, final specification and procurement approval unconfirmed. This is a synthetic pagination fixture, not a project selection.',selected_image_url:null});
    }
  }
}
const props={project:{name:'Cara pagination verification',client_name:'Synthetic fixture - local review only'},items,categories:[{prefix:'TW',name:'Tapware',sort_order:1},{prefix:'SW',name:'Sanitaryware',sort_order:2}],generatedAt:'04/11/2026',scheduleSubtitle:'Local synthetic fixture - proposed quantities are preliminary'};
function flatten(node) {
  if(node==null||typeof node==='boolean')return [];
  if(Array.isArray(node))return node.flatMap(flatten);
  return [node,...(typeof node==='object'?flatten(node.props?.children):[])];
}
function pages(document) {return flatten(document.props.children).filter(node=>node?.type===renderer.Page);}
function sections(page) {return flatten(page).filter(node=>typeof node==='object'&&node.key?.match(/-(start|continued)$/));}
const roomDocument=SchedulePdf({...props,grouping:'room'});
const roomPages=pages(roomDocument).slice(1);
assert.ok(roomPages.length>6,'long rooms continue across pages');
assert.ok(roomPages.every(page=>{
  const rows=flatten(page).filter(node=>items.some(item=>node?.key===item.id));
  return new Set(rows.map(node=>items.find(item=>item.id===node.key).rooms[0].id)).size===1;
}),'each room occupies its own pages');
const renderedItems=roomPages.flatMap(page=>flatten(page).filter(node=>items.some(item=>node?.key===item.id)).map(node=>node.key));
assert.deepEqual(renderedItems.toSorted(),items.map(item=>item.id).toSorted(),'every input row retained exactly once');
const typeDocument=SchedulePdf({...props,grouping:'type'});
assert.ok(pages(typeDocument).length<pages(roomDocument).length,'type grouping retains compact packing');
const smallProps={...props,items:items.filter(item=>item.rooms[0].name==='Lot 58 · LIVING 1')};
const smallType=pages(SchedulePdf({...smallProps,grouping:'type'}));
assert.equal(smallType.length,2,'short type groups share a schedule page');
assert.equal(sections(smallType[1]).length,2);
assert.equal(pages(SchedulePdf(smallProps)).length,smallType.length,'default type behavior unchanged');
assert.equal(pages(SchedulePdf({...props,items:[],grouping:'room'})).length,2,'empty schedule has no extra blank room pages');

for(const [mode,document] of [['room',roomDocument],['type',typeDocument]]) {
  const file=path.join(output,`pagination-${mode}.pdf`);
  fs.writeFileSync(file,await renderer.renderToBuffer(document));
  const text=execFileSync('pdftotext',['-layout',file,'-'],{encoding:'utf8'});
  const physical=text.split('\f').filter(page=>page.trim());
  assert.equal(physical.length,pages(document).length,'renderer adds no unexpected overflow pages');
  assert.equal((text.match(/PROPOSED \/ PRELIMINARY/g)??[]).length,items.length,'quantity/status labels retained');
  if(mode==='room') {
    for(const lot of ['58','59'])for(const room of ['LIVING 1','LIVING 2','LIVING 3']) {
      const label=`Lot ${lot} · ${room}`;
      const found=physical.map((page,index)=>({page,index})).filter(({page})=>page.includes(label));
      assert.ok(found.length>=1,`${label} retained`);
      assert.ok(found[0].page.split('\n').slice(0,12).some(line=>line.trim()===label),`${label} starts at top of a new page`);
      assert.ok(found.every(({page})=>!page.includes(`LOT ${lot} · LIVING ${room==='LIVING 3'?1:3}`)),'room pages do not mix');
      if(room==='LIVING 2')assert.ok(found.slice(1).every(({page})=>page.includes('Continued')),'long-room continuation labels retained');
      console.log(`${label}: physical pages ${found.map(({index})=>index+1).join(', ')}`);
    }
  }
  console.log(`${mode}: ${physical.length} pages, ${items.length} rows preserved - ${file}`);
}
console.log('PASS: separate room starts, continuation, content/status preservation, compact/default type behavior and empty schedule');
