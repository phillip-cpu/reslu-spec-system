import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {createRequire} from 'node:module';
import {cloneElement} from 'react';
import * as renderer from '@react-pdf/renderer';
import {PDFDocument} from 'pdf-lib';
const require=createRequire(import.meta.url);
const exports={};
const code=ts.transpileModule(fs.readFileSync(process.env.DOC_INDEX_SOURCE??'components/pdf/DocBundlePages.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true,jsx:ts.JsxEmit.ReactJSX}}).outputText;
new Function('require','exports',code)(name=>name==='@react-pdf/renderer'?renderer:require(name),exports);
const rows=Array.from({length:48},(_,i)=>({itemCode:'Proposed',itemName:`Product ${i+1}: Indicating emergency release escutcheon with accessible turn and satin stainless steel finish — S7014SSS`,note:i%2?'Spec sheet — source link only; see product library':'Installation manual: stored PDF unavailable; see product library. Exact model applicability remains unconfirmed.'}));
let layout;
const document=cloneElement(exports.DocsIndexPage({rows}),{onRender:info=>{layout=info._INTERNAL__LAYOUT__DATA_;}});
const bytes=await renderer.renderToBuffer(document);
fs.mkdirSync('../export-verification',{recursive:true});
fs.writeFileSync('../export-verification/document-index-long-names.pdf',bytes);
const pdf=await PDFDocument.load(bytes);assert(pdf.getPageCount()>1);
const rendered=[];
for(const page of layout.children){
 const pageRows=page.children.filter(c=>c.type==='VIEW'&&!c.props.fixed);
 let bottom=page.box.paddingTop;
 for(const row of pageRows){
  assert(row.box.top>=bottom-0.1,'rows must not overlap vertically');
  assert(row.box.top+row.box.height<=page.box.height-page.box.paddingBottom+0.1,'whole row stays inside page');
  const [label,note]=row.children;
  for(const line of label.lines)assert(label.box.left+line.box.x+line.xAdvance<=note.box.left-5,'name must not enter status column');
  for(const line of note.lines)assert(note.box.left+line.box.x+line.xAdvance-line.overflowRight<=row.box.width+0.1,'status stays inside page width');
  const text=t=>t.lines.map(l=>l.string).join('').replace(/\s+/g,' ').trim();
  rendered.push({label:text(label),note:text(note)});
  bottom=row.box.top+row.box.height;
 }
 const headings=page.children.flatMap(c=>c.props.fixed?c.children:[c]);
 assert(headings.some(t=>t.lines?.some(l=>l.string==='Documents index')),'repeat heading on continuation page');
}
assert.equal(rendered.length,rows.length,'no missing or split rows');
rows.forEach((row,i)=>{
 assert.equal(rendered[i].label,[row.itemCode,row.itemName].join(' — '));
 assert.equal(rendered[i].note,row.note,'source-only/unavailable wording retained verbatim');
});
console.log(`PASS: ${rows.length} long-name rows across ${pdf.getPageCount()} pages; nonoverlapping columns, complete rows, repeated headings, unchanged document status text`);
