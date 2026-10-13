import {createRequire} from 'node:module';import {execFileSync} from 'node:child_process';import {writeFile,rm} from 'node:fs/promises';import {resolve} from 'node:path';
const target=resolve('.heading-review-qa.cjs');
try{
 execFileSync('/tmp/reslu-construction-test-deps/node_modules/esbuild/bin/esbuild',['--bundle','--packages=external','--platform=node','--format=cjs','--jsx=automatic','--loader=tsx',`--outfile=${target}`],{input:'export {SowPdf} from "./components/pdf/SowPdf";',stdio:['pipe','inherit','inherit']});
 const {SowPdf}=createRequire(import.meta.url)(target);const {renderToBuffer}=await import('@react-pdf/renderer');const trade='Timber Floor Laying & Sanding';
 const section=(id,heading,overrides)=>({id,heading,trade_heading_overrides:overrides,lines:[{id:id+'-line',text:'Install timber flooring as specified in the synthetic scope.',kind:'inclusion',trade,sort:0}],sort:0});
 const args={project:{name:'Synthetic heading review',client_name:'Synthetic Client',address:null},sections:[section('front','Front Door & Hallway',{[trade]:'Timber Floor Laying'}),section('other','Other room',{})],revisionLabel:'SYNTHETIC',status:'draft',issuedAt:null,projectNo:'LOCAL-ONLY',generatedAt:'13 October 2026'};
 for(const extract of [false,true])await writeFile(resolve('../evidence/'+(extract?'heading-trade-extract.pdf':'heading-room-review.pdf')),await renderToBuffer(SowPdf({...args,extractTrade:extract?trade:null})));
 console.log('Rendered full SOW and trade extract using existing SowPdf. Synthetic rooms only.');
}finally{await rm(target,{force:true});}
