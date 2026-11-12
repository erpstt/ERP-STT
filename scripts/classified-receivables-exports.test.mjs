import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import ExcelJS from 'exceljs';
import {primeRoleAccessCache} from '../dist/modules/security-catalogs/role-access-matrix.module.js';
import {runClassifiedReceivables,exportClassifiedReceivables,setReceivableDiscount} from '../dist/modules/reports/classified-receivables.service.js';
import {bankBrowserFixture} from './lib/bank-browser-fixture.mjs';

test('complete paging, numeric Excel totals, safe PDF layout and read-role marking',{timeout:45000},async t=>{
 const savedFetch=globalThis.fetch,savedEnv={...process.env};t.after(()=>{globalThis.fetch=savedFetch;for(const key of ['SUPABASE_URL','SUPABASE_ANON_KEY','PDF_RENDERER_URL','PDF_RENDERER_TOKEN']){if(savedEnv[key]===undefined)delete process.env[key];else process.env[key]=savedEnv[key];}});
 process.env.SUPABASE_URL='https://synthetic.invalid';process.env.SUPABASE_ANON_KEY='synthetic-anon';process.env.PDF_RENDERER_URL='http://synthetic.railway.internal';process.env.PDF_RENDERER_TOKEN='synthetic-test-only-token-00000000000000';
 const auth='Bearer classified-synthetic',options={subsidiaries:[{id:1,name:'Empresa de demostración',currencyId:1}],currencies:[{id:1,code:'USD'}]},filters={subsidiaryIds:[1],dateTo:'2026-11-30',agingCurrencyMode:'ORIGINAL'};
 await primeRoleAccessCache(auth,{isAdmin:false,grants:[{resourceKey:'reports:accounting-reports',canView:true,canCreate:false,canEdit:false,canDelete:false}]});
 const docs=Array.from({length:251},(_,i)=>({document_id:i+1,entity_name:i===0?'=HYPERLINK("https://invalid")':'Cliente '+i,document_number:'FAC-'+(i+1),issue_date:'2026-10-01',due_date:'2026-11-01',currency_code:i%2?'JMD':'USD',original_amount:1000,applied_amount:200,pending:800,bucket:'1_30',discounted:i%3===0,intercompany:i%3===1}));let pdfHtml='',calls=[];
 globalThis.fetch=async(url,init)=>{const path=new URL(url).pathname,input=JSON.parse(init.body);calls.push({path,input});
 if(path.endsWith('/run_classified_receivables_report')){const p=input.p_filters.page;return Response.json({rows:docs.slice((p-1)*250,p*250),total:docs.length,summary:{subledger:200800}});}
 if(path.endsWith('/set_receivable_discount_mark'))return Response.json({discounted:input.p_discounted});
 if(path==='/render'){pdfHtml=input.html;return new Response('%PDF-synthetic-test',{headers:{'Content-Type':'application/pdf'}});}
 throw Error('Unexpected synthetic request '+path);};
 const report=await runClassifiedReceivables(auth,filters);assert.equal(report.rows.length,251);assert.deepEqual(calls.map(c=>c.input.p_filters.page),[1,2]);
 assert.deepEqual(await setReceivableDiscount(auth,{invoiceId:1,discounted:true,expected:false}),{discounted:true});await assert.rejects(setReceivableDiscount(auth,{invoiceId:'1',discounted:'true'}),/válidas/);
 const excel=await exportClassifiedReceivables(auth,filters,'excel',options),workbook=new ExcelJS.Workbook();await workbook.xlsx.load(Buffer.from(excel.base64,'base64'));assert.equal(workbook.worksheets.length,3);
 assert.equal(workbook.worksheets.reduce((sum,sheet)=>sum+sheet.getColumn(2).values.filter(v=>typeof v==='string'&&v.startsWith('FAC-')).length,0),251);
 let formulas=0;workbook.eachSheet(sheet=>sheet.eachRow(row=>row.eachCell(cell=>{if(cell.value&&typeof cell.value==='object'&&'formula'in cell.value)formulas++;})));assert.equal(formulas,0);
 const pdf=await exportClassifiedReceivables(auth,{...filters,agingEntityId:5},'pdf',options);assert.equal(pdf.mimeType,'application/pdf');assert.ok(pdfHtml.includes('Facturación descontada'));assert.ok(!pdfHtml.includes('<script'));assert.ok(pdfHtml.includes('Subtotal USD')&&pdfHtml.includes('Subtotal JMD'));
 const {page}=await bankBrowserFixture(t,{viewport:{width:1500,height:1000}});await page.setContent(pdfHtml);await mkdir('.local-tools/classified-receivables-qa',{recursive:true});await writeFile('.local-tools/classified-receivables-qa/export.html',pdfHtml);await page.screenshot({path:'.local-tools/classified-receivables-qa/pdf-layout.png',fullPage:false});
});
