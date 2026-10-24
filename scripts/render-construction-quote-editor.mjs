/** Actual editor component, synthetic data, isolated headless browser; no live services. */
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,rmSync} from 'node:fs';
const require=createRequire(import.meta.url), bundle='.quote-preview.cjs';
const out='../evidence/quote-first';
try {
 execFileSync('/tmp/reslu-quote-test-tools/node_modules/esbuild/bin/esbuild',['--bundle','--packages=external','--platform=node','--format=cjs','--jsx=automatic','--loader=tsx',`--outfile=${bundle}`],{input:'export {ConstructionQuoteEditor} from "./components/proposals/ConstructionQuoteEditor";export {quoteContent,emptyQuote} from "./lib/construction-quotes";'});
 execFileSync('node_modules/.bin/tailwindcss',['-i','app/globals.css','-o',`${out}/editor.css`]);
 const {ConstructionQuoteEditor,quoteContent,emptyQuote}=require('../'+bundle);
 const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
 const content=quoteContent({...emptyQuote(),introduction:'Thank you for the opportunity to prepare this construction quote.',scope_summary:'Renovation works to the referenced plans. Detailed scope to follow price agreement.',price_ex_gst:125000,payment_terms:'Payment stages to be agreed before contract issue.',assumptions:'Existing structure suitable, subject to inspection.',exclusions:'Landscaping and unselected options.',terms:'Draft terms for review only. No work is authorised by this draft.',drawing_references:'A100 — Site plan — T1 — 20 October 2026\nA102 — Proposed plan — T2 — 22 October 2026'});
 const html=`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${readFileSync(`${out}/editor.css`,'utf8')}</style><div style="padding:18px 32px;background:#1a1a1a;color:white;font-size:12px;letter-spacing:2px">RESLU SPEC · SYNTHETIC EDITOR PREVIEW · NOT A LIVE JOB</div><main style="padding:32px">${renderToStaticMarkup(React.createElement(ConstructionQuoteEditor,{proposal:{id:'synthetic',status:'draft',updated_at:'v1',content}}))}</main>`;
 writeFileSync(`${out}/Synthetic-Construction-Quote-Editor.html`,html);
 const {chromium}=require('/Users/phillip/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
 const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 try {const page=await browser.newPage({viewport:{width:1280,height:1000},deviceScaleFactor:1});await page.route('**/*',r=>r.abort());await page.setContent(html);await page.screenshot({path:`${out}/Synthetic-Construction-Quote-Editor.png`,fullPage:true});await page.setViewportSize({width:390,height:844});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Mobile overflow');await page.screenshot({path:`${out}/Synthetic-Construction-Quote-Editor-Mobile.png`,fullPage:true});console.log('PASS: real editor rendered desktop/mobile without overflow; network disabled. Interactions covered by DOM tests.');}finally{await browser.close();}
}finally{rmSync(bundle,{force:true});}
