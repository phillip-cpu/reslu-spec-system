import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import ts from 'typescript';
import {PDFDocument,PDFName,PDFDict,PDFArray,PDFString,PDFHexString} from 'pdf-lib';

const require=createRequire(import.meta.url);
function load(file,mocks={}) {
  const exports={};
  const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  new Function('require','exports',code)(name=>mocks[name]??require(name),exports);
  return exports;
}
const references=load('lib/schedule-pdf-references.ts',{'./schedule-colour-references':load('lib/schedule-colour-references.ts')});
const {schedulePdfReference:reference,safePdfHttpsUrl:safe}=references;
const sink={id:'8b9349f6-ea9e-4b91-b113-01c6ba9ee0ca',name:'Mizu Drift Sink Mixer Extended Lever - verified identity fixture',product_url:'https://www.reece.com.au/product/mizu-drift-sink-mixer-extended-lever-with-red-36317',colour:null,brand:'Mizu'};
const oven={id:'bc1b56f5-ce34-4dbb-8748-5d878a133cfd',name:'Artusi CAOS610X - verified identity fixture',product_url:'https://artusi.com.au/product/60cm-built-in-electric-oven-stainless-steel-4/',colour:null};
const dishwasher={id:'49720001-efb4-4415-b36a-0215ab545311',name:'Fisher & Paykel DD60D2NX9 - verified identity fixture',product_url:'https://www.fisherpaykel.com/au/dishwashing/built-under/series-7-contemporary-double-dishdrawer-dishwasher-dd60d2nx9-82878.html',colour:null};
const colourItems=[
  ['23303bed-85a1-46a8-a732-c92135ca32f9','Roof colour','Surfmist','COLORBOND','https://colorbond.com/colours/surfmist'],
  ['8621dd28-0a6d-464d-8b68-e2d5a2cb12d4','Gutter colour','Gully','COLORBOND','https://colorbond.com/colours/gully'],
  ['59703871-a632-4ebf-88b7-248ac4c1433c','Fascia colour','Gully','COLORBOND','https://colorbond.com/colours/gully'],
  ['806c6447-7886-4eff-b69c-2024a6a4729f','Downpipe colour','Gully','COLORBOND','https://colorbond.com/colours/gully'],
  ['0ea76bcd-4db7-4b0c-8004-b1f0757c6563','Exterior wall colour','Natural Grain','Dulux','https://www.dulux.com.au/specifier/colour/naturals-sn3/natural-grain/'],
].map(([id,name,colour,brand,product_url])=>({id,name,colour,brand,product_url,finish:null}));
for(const item of [sink,oven,dishwasher])assert.deepEqual(reference(item),{url:item.product_url,label:'Product reference'});
for(const item of colourItems)assert.deepEqual(reference(item),{url:item.product_url,label:'Colour reference'});
assert.equal(reference({...sink,id:'unknown'}),null,'safe exact URL alone does not verify identity');
assert.equal(reference({...sink,product_url:oven.product_url}),null,'different verified product destination rejected');
assert.equal(reference({...sink,product_url:sink.product_url+'?redirect=elsewhere'}),null);
assert.equal(reference({...sink,id:'allocated-row',library_item_id:sink.id})?.url,sink.product_url,'allocation rows retain canonical identity');
assert.equal(reference({...sink,library_item_id:'unknown'}),null,'explicit library identity takes precedence');
assert.equal(reference({...colourItems[0],colour:'Jasper'}),null,'superseded colour rejected');
assert.equal(reference({...colourItems[0],brand:'Unknown'}),null);
for(const url of ['http://www.reece.com.au/product/test','javascript:alert(1)','data:text/html,test','//www.reece.com.au/product/test','https://user:pass@www.reece.com.au/product/test','https://www.reece.com.au/product/test#fragment',' https://www.reece.com.au/product/test','not a URL'])assert.equal(safe(url),null);
const unlinked=[
  {...sink,id:'placeholder',name:'Ceiling paint - colour / finish TBC'},
  {...sink,id:'http',product_url:sink.product_url.replace('https:','http:')},
  {...sink,id:'different-product',product_url:oven.product_url},
  {id:'3499dbf9-1b87-403a-ba15-282372c644f2',name:'Window colour - exact shade TBC',colour:'White',brand:null,product_url:colourItems[0].product_url},
];
for(const item of unlinked)assert.equal(reference(item),null);

const renderer=await import('@react-pdf/renderer');
const {SchedulePdf}=load('components/pdf/SchedulePdf.tsx',{'@react-pdf/renderer':renderer,'@/lib/schedule-grouping':load('lib/schedule-grouping.ts'),'@/lib/schedule-pdf-references':references});
const items=[{...sink,category:'TW'},{...oven,category:'AP'},{...dishwasher,category:'AP'},...colourItems.map(item=>({...item,category:'MF'})),...unlinked.map(item=>({...item,category:item.id==='placeholder'?'PF':'TW'}))].map(item=>({...item,item_code:'Proposed',rooms:[{id:'review',name:'Reference review fixtures'}],location:'Reference review fixtures',quantity:null,quantityLabel:'QTY TBC\nPROPOSED / PRELIMINARY',selected_image_url:null}));
const before=JSON.stringify(items);
const bytes=await renderer.renderToBuffer(SchedulePdf({project:{name:'Cara link review',client_name:'Synthetic fixture - not a live export'},items,categories:[{prefix:'TW',name:'Tapware & Accessories',sort_order:1},{prefix:'AP',name:'Appliances',sort_order:2},{prefix:'MF',name:'Metal Finish',sort_order:3},{prefix:'PF',name:'Paint',sort_order:4}],generatedAt:'04/11/2026',grouping:'room'}));
assert.equal(JSON.stringify(items),before,'links do not nominate finishes or change selections');
const pdf=await PDFDocument.load(bytes);
const uris=[];
for(const page of pdf.getPages()) {
  const annotations=page.node.lookupMaybe(PDFName.of('Annots'),PDFArray);
  for(let i=0;i<(annotations?.size()??0);i++) {
    const annotation=annotations.lookup(i,PDFDict);
    const action=annotation.lookupMaybe(PDFName.of('A'),PDFDict);
    if(!action)continue;
    assert.equal(action.get(PDFName.of('S')).toString(),'/URI');
    const uri=action.lookup(PDFName.of('URI'));
    assert.ok(uri instanceof PDFString||uri instanceof PDFHexString);
    uris.push(uri.decodeText());
    assert.ok(annotation.has(PDFName.of('Rect')),'link has a clickable rectangle');
  }
}
assert.deepEqual(uris.toSorted(),[sink,oven,dishwasher,...colourItems].map(item=>item.product_url).toSorted(),'actual PDF annotations contain only exact verified destinations');
const output=path.resolve(process.env.PDF_HIERARCHY_OUTPUT??'../pdf-hierarchy-review');
fs.mkdirSync(output,{recursive:true});
const file=path.join(output,'verified-reference-links.pdf');
fs.writeFileSync(file,bytes);
const extracted=execFileSync('pdftotext',['-layout',file,'-'],{encoding:'utf8'});
assert.equal((extracted.match(/Product reference/g)??[]).length,3);
assert.equal((extracted.match(/Colour reference/g)??[]).length,5);
assert.ok(!extracted.includes('https://'),'compact link labels, no raw URL clutter');
console.log(`PASS: identity/destination/colour guards, unsafe and placeholder exclusion; actual PDF has ${uris.length} verified URI annotations - ${file}`);
