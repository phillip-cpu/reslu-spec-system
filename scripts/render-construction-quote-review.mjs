/** Synthetic review evidence using the existing proposal renderer. */
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,rmSync} from 'node:fs';
const require=createRequire(import.meta.url), file='.quote-pdf-test.cjs';
try {
 execFileSync(process.env.ESBUILD_BINARY || '/tmp/reslu-quote-test-tools/node_modules/esbuild/bin/esbuild',['--bundle','--packages=external','--platform=node','--format=cjs','--jsx=automatic','--loader=tsx',`--outfile=${file}`],{input:'export {ProposalPdf} from "./components/pdf/ProposalPdf";export {quoteContent,emptyQuote} from "./lib/construction-quotes";export {proposalTemplateContent} from "./lib/proposal-templates";export {buildConstructionContent} from "./lib/construction-proposals";export {fixture} from "./lib/construction-proposals.fixture";'});
 const {ProposalPdf,quoteContent,emptyQuote,proposalTemplateContent,buildConstructionContent,fixture}=require('../'+file);
 const {renderToBuffer}=await import('@react-pdf/renderer');
 const quote=quoteContent({...emptyQuote(),introduction:'Thank you for the opportunity to prepare this construction quote.',scope_summary:'Renovation works to the referenced plans.\nDetailed scope to follow price agreement.',price_ex_gst:125000,payment_terms:'Payment stages to be agreed before contract issue.',assumptions:'Existing structure suitable, subject to inspection.',exclusions:'Landscaping and unselected options.',terms:'Draft terms for review only. No work is authorised by this draft.',drawing_references:'A100 - Site plan - T1 - 20 October 2026\nA102 - Proposed plan - T2 - 22 October 2026'});
 mkdirSync('../evidence/quote-first',{recursive:true});
 for(const [name,content] of [['quote',quote],['design',proposalTemplateContent('renovation')],['construction',buildConstructionContent(fixture())]]) {
  const proposal={id:'synthetic-'+name,status:'draft',content,total_inc:content.fees.stages.reduce((s,x)=>s+x.total_inc,0),deposit_inc:0,signature:null};
  const bytes=await renderToBuffer(ProposalPdf({proposal,residence:'Synthetic Residence',address:'Example address',clientName:'Synthetic Client',coverDateLabel:'INTERNAL REVIEW - NOT ISSUED',signedDateLabel:''}));
  writeFileSync(`../evidence/quote-first/${name}.pdf`,bytes);console.log(`${name}: ${bytes.length} bytes`);
 }
} finally {rmSync(file,{force:true});}
