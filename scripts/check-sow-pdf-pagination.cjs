// Run from repo root: node scripts/check-sow-pdf-pagination.cjs
// Requires installed dependencies and Poppler pdftotext. Outputs disposable PDFs in tmp/pdfs.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const Module = require('node:module');
const resolve = Module._resolveFilename;
Module._resolveFilename = function(name, ...args) {
  if(name.startsWith('@/')) name = path.join(process.cwd(), name.slice(2));
  return resolve.call(this, name, ...args);
};
for (const ext of ['.ts', '.tsx']) require.extensions[ext] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop:true, target:ts.ScriptTarget.ES2020}
  }).outputText, filename);
};
const {renderToBuffer} = require('@react-pdf/renderer');
const {SowPdf: after} = require('../components/pdf/SowPdf.tsx');
const {execFileSync} = require('node:child_process');
const props={project:{name:'Pagination verification',client_name:'Test client',address:'Test address'},revisionLabel:'D1',status:'draft',issuedAt:null,projectNo:'TEST',generatedAt:'30 September 2026'};
const line=(id,text,trade=null,kind='inclusion')=>({id,text,trade,kind,sort:1});
const section=(id,heading,lines,source_room_id=null)=>({id,heading,lines,source_room_id});
const previous=n=>section('previous','Previous room',Array.from({length:n},(_,i)=>line('p'+i,`Previous clause ${i+1}. `+'Coordinate construction with the issued drawings and check dimensions on site. '.repeat(2))));
function assertFreshHeading(file, headingWord) {
 const xml=execFileSync('pdftotext',['-bbox',file,'-'],{encoding:'utf8'});
 const atTop=[...xml.matchAll(/<word[^>]*yMin="([0-9.]+)"[^>]*>([^<]+)<\/word>/g)]
  .filter(match=>Math.abs(Number(match[1])-89.365)<1)
  .map(match=>match[2]).join('').replace(/\s/g,'');
 if(!atTop.includes(headingWord)) throw Error('Area heading is not at page top: '+headingWord+' '+file);
}
async function render(component, sections, file, extractTrade=null){
 fs.writeFileSync(file,await renderToBuffer(component({...props,sections,extractTrade})));
 return execFileSync('pdftotext',['-layout',file,'-'],{encoding:'utf8'}).split('\f').filter(x=>x.trim());
}
(async()=>{
 // This boundary reproduces the original orphan with a multi-line first row.
 const boundary=17;
 fs.mkdirSync("tmp/pdfs", {recursive:true});
 const cases=[
 ['long-first', [line('first','FIRST ALFRESCO CLAUSE. '+'Coordinate external works and verify dimensions with the issued drawings. '.repeat(7),'Carpenter'),line('second','Second Alfresco clause.','Carpenter')]],
 ['short-first', [line('first','FIRST ALFRESCO CLAUSE. Short content.','Carpenter')]],
 ['untagged', [line('first','FIRST ALFRESCO CLAUSE. '+'Coordinate site works with issued drawings. '.repeat(9))]],
 ['note-first', [line('first','FIRST ALFRESCO CLAUSE. '+'Confirm requirements before construction. '.repeat(10),null,'note')]],
 ['exclusions-first', [line('first','FIRST ALFRESCO CLAUSE. Excluded unless separately instructed.',null,'exclusion')]],
 ['long-section', [line('first','FIRST ALFRESCO CLAUSE. Coordinate external works.','Carpenter'),...Array.from({length:65},(_,i)=>line('a'+i,`Alfresco continued clause ${i}. `+'Check dimensions and coordinate construction with issued drawings. '.repeat(3),'Carpenter'))]],
 ['mixed-trades', [line('first','FIRST ALFRESCO CLAUSE. Coordinate external works.','Carpenter'),line('g','GENERAL FIRST CLAUSE. '+'Check dimensions on site. '.repeat(8)),line('r','ROOFING FIRST CLAUSE. '+'Check roof details and confirm flashings. '.repeat(8),'Roofing')]],
 ];
 for(const [name,lines] of cases){
  for(const offset of [-1,0,1]){
   const sections=[previous(boundary+offset),section('alfresco','Alfresco',lines),section('management','Site Management',[line('m','MANAGEMENT CLAUSE.')]),section('exclusions','Exclusions',[line('e','CLOSING EXCLUSION.',null,'exclusion')]),section('assumptions','Assumptions',[line('a','ASSUMPTIONS CLAUSE.')])];
   const file=`tmp/pdfs/after-${name}-${offset+1}.pdf`;
   const pages=await render(after,sections,file);
   const h=pages.findIndex(x=>x.includes('ALFRESCO'));
   assertFreshHeading(file,'ALFRESCO');
   if(pages[h].includes('Previous clause')) throw Error('Area shares preceding section page');
   if(h<0 || !pages[h].includes('FIRST ALFRESCO CLAUSE'))throw Error(`Orphan: ${name} ${offset}`);
   for(const page of pages.slice(1)) if(!/clause|CLAUSE|EXCLUSION|Confirm requirements/.test(page))throw Error('Blank body page '+file);
   const all=pages.join('\n');
   if(all.indexOf('SITE MANAGEMENT')>all.indexOf('CLOSING EXCLUSION'))throw Error('Closing order changed');
   for(const [heading, marker] of [['GENERAL','GENERAL FIRST CLAUSE'], ['ROOFING','ROOFING FIRST CLAUSE']]) {
    if(name==='mixed-trades') {
     const page=pages.find(x=>x.includes(heading));
     if(!page?.includes(marker)) throw Error('Trade heading orphan: '+heading);
    }
   }
   if(name==='long-section' && !all.includes('Alfresco continued clause 64.')) throw Error('Missing final clause');
   console.log('PASS',name,offset,'pages',pages.length,'Alfresco page',h+1);
  }
 }
 const extract=await render(after,[previous(boundary),section('alfresco','Alfresco',cases[0][1])],'tmp/pdfs/after-extract.pdf','Carpenter');
 const hp=extract.findIndex(x=>x.includes('ALFRESCO'));
 if(!extract[hp].includes('FIRST ALFRESCO CLAUSE'))throw Error('Extract orphan');
 assertFreshHeading('tmp/pdfs/after-extract.pdf','ALFRESCO');
 console.log('PASS trade extract');
 const rooms=[['front','Front Door & Hallway','FRONT'],['envelope','External Envelope','EXTERNAL'],['alfresco','Alfresco','ALFRESCO'],['yard','Backyard','BACKYARD'],['kitchen','Kitchen','KITCHEN'],['living','Living','LIVING']];
 const intros=[section('prelim','General / Preliminaries',[line('p','INTRO PRELIMINARIES CLAUSE.')]),section('overview','Project Overview',[line('o','INTRO OVERVIEW CLAUSE.')]), section('notes','General Notes — Compliance',[line('n','INTRO NOTES CLAUSE.')])];
 const closing=[section('management','Site Management & Handover',[line('m','MANAGEMENT CLAUSE.')]),section('exclusions','Exclusions',[line('e','CLOSING EXCLUSION.',null,'exclusion')]),section('assumptions','Assumptions',[line('a','ASSUMPTIONS CLAUSE.')])];
 for(const count of [1,17,22,45,65]) {
  const sections=[...intros,...rooms.map(([id,heading],index)=>section(id,heading,Array.from({length:index===0?count:1},(_,i)=>line(id+i,`${id.toUpperCase()} CLAUSE ${i}. `+'Coordinate construction with issued drawings. '.repeat(3),'Carpenter')),id)),...closing];
  const file=`tmp/pdfs/areas-${count}.pdf`;
  const pages=await render(after,sections,file);
  for(const [, ,word] of rooms) assertFreshHeading(file,word);
  const roomPages=rooms.map(([id])=>pages.findIndex(x=>x.includes(id.toUpperCase()+' CLAUSE 0.')));
  if(new Set(roomPages).size!==rooms.length || roomPages.some(x=>x<2)) throw Error('Room page boundaries wrong');
  if(!pages[1].includes('INTRO OVERVIEW CLAUSE') || !pages[1].includes('INTRO NOTES CLAUSE')) throw Error('Intro flow changed');
  if(!pages.at(-1).includes('MANAGEMENT CLAUSE') || !pages.at(-1).includes('CLOSING EXCLUSION')) throw Error('Closing flow changed');
  for(const page of pages.slice(1)) if(!page.includes('CLAUSE') && !page.includes('EXCLUSION')) throw Error('Empty body page');
  console.log('PASS ordered areas, first room clauses',count,'pages',pages.length);
 }
 const firstRoom=await render(after,[section('kitchen','Kitchen',[line('k','FIRST ROOM CLAUSE.')],'kitchen')],'tmp/pdfs/first-room.pdf');
 if(firstRoom.length!==2 || !firstRoom[1].includes('FIRST ROOM CLAUSE'))throw Error('Blank first body page');
 assertFreshHeading('tmp/pdfs/first-room.pdf','KITCHEN');
 console.log('PASS first room without introduction');
 const emptyRoom=await render(after,[...intros,section('empty','Backyard',[],'yard'),section('kitchen','Kitchen',[line('k','KITCHEN CLAUSE.')],'kitchen')],'tmp/pdfs/empty-room.pdf');
 if(emptyRoom.length!==4)throw Error('Unexpected empty-area page count');
 assertFreshHeading('tmp/pdfs/empty-room.pdf','BACKYARD');
 assertFreshHeading('tmp/pdfs/empty-room.pdf','KITCHEN');
 console.log('PASS empty area heading, no extra blank pages');
})();
