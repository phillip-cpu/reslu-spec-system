/** Synthetic DOM only: never starts or controls a browser. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {rmSync} from 'node:fs';
const require=createRequire(import.meta.url);
const {JSDOM}=require(process.env.JSDOM_PACKAGE || '/tmp/reslu-quote-test-tools/node_modules/jsdom');
const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost'});
globalThis.window=dom.window;globalThis.document=dom.window.document;Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=require('react');const {act}=React;const {createRoot}=require('react-dom/client');
const file='.quote-dom-test.cjs';
try {
 execFileSync(process.env.ESBUILD_BINARY || '/tmp/reslu-quote-test-tools/node_modules/esbuild/bin/esbuild',['--bundle','--packages=external','--platform=node','--format=cjs','--jsx=automatic','--loader=tsx',`--outfile=${file}`],{input:'export {ConstructionQuoteEditor} from "./components/proposals/ConstructionQuoteEditor";export {quoteContent,emptyQuote} from "./lib/construction-quotes";'});
 const {ConstructionQuoteEditor,quoteContent,emptyQuote}=require('../'+file);
 let saved={id:'synthetic',status:'draft',updated_at:'v1',content:quoteContent(emptyQuote()),total_inc:0,deposit_inc:0};let calls=[],release,fail=false;
 globalThis.fetch=async(url,options)=>{calls.push({url,...JSON.parse(options.body)});await new Promise(r=>release=r);if(fail)return {ok:false,json:async()=>({error:'Draft changed elsewhere'})};saved={...saved,content:JSON.parse(options.body).content,updated_at:'v2'};return {ok:true,json:async()=>({proposal:saved})};};
 const root=createRoot(document.getElementById('root'));await act(async()=>root.render(React.createElement(ConstructionQuoteEditor,{proposal:saved})));
 const button=s=>[...document.querySelectorAll('button')].find(b=>b.textContent===s);
 const input=async(label,value)=>{const el=[...document.querySelectorAll('label')].find(l=>l.textContent.includes(label)).querySelector('input,textarea');await act(async()=>{Object.getOwnPropertyDescriptor(el.tagName==='INPUT'?window.HTMLInputElement.prototype:window.HTMLTextAreaElement.prototype,'value').set.call(el,value);el.dispatchEvent(new window.Event('input',{bubbles:true}));});};
 await input('Scope summary','Discard me');await act(async()=>button('Discard unsaved edits').click());assert.equal(calls.length,0);assert.equal(document.querySelectorAll('textarea')[1].value,'');
 for(const [label,value] of [['Introduction','Synthetic introduction'],['Scope summary','Build as drawings'],['Drawing identifiers','A102 / T1'],['Payment breakdown','Payment terms pending review'],['Assumptions','Normal access'],['Exclusions','Landscaping'],['Terms and conditions','Draft terms'],['Selling price','1000']]) await input(label,value);
 assert.ok(!document.querySelector('a'));await act(async()=>{button('Save draft').click();button('Save draft')?.click();});assert.equal(calls.length,1);
 await act(async()=>release());assert.match(document.body.textContent,/Saved draft/);assert.equal(calls[0].content.fees.stages[0].total_inc,1100);assert.equal(calls[0].content.quote.drawing_references,'A102 / T1');assert.ok(document.querySelector('a').href.endsWith('/api/proposals/synthetic/pdf'));
 await input('Scope summary','Keep on conflict');fail=true;await act(async()=>button('Save draft').click());await act(async()=>release());assert.match(document.body.textContent,/Draft changed elsewhere/);assert.equal(document.querySelectorAll('textarea')[1].value,'Keep on conflict');assert.match(document.body.textContent,/Unsaved changes/);
 assert.ok(![...document.querySelectorAll('button')].some(b=>/Send|Accept|Issue/.test(b.textContent)));await act(async()=>root.unmount());assert.equal(calls.length,2);
 console.log('PASS: all quote fields editable; discard has no writes; double save locked; stale edits retained; preview only saved data; no release actions.');
} finally {rmSync(file,{force:true});dom.window.close();}
