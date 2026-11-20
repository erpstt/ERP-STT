import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdir} from 'node:fs/promises';
import ExcelJS from 'exceljs';
import {bankBrowserFixture} from './lib/bank-browser-fixture.mjs';
test('downloaded template can be filled, validated and confirmed; foreign company and formulas are rejected',async t=>{
 const {page,baseURL}=await bankBrowserFixture(t),calls=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{localStorage.setItem('nexo_token','synthetic-bulk');localStorage.setItem('nexo_company','1');localStorage.setItem('nexo_role','1');});
 await page.route('**/api/**',async route=>{const req=route.request();if(req.url().includes('form-options'))return route.fulfill({json:{context:{subsidiaryId:1},subsidiaries:[{subsidiary_id:1,name:'Synthetic company'}],suppliers:[{supplier_id:10,company_name:'Synthetic supplier'}],accounts:[{account_id:203,account_number:'601',account_name:'Expense'}]}});const p=req.postDataJSON();calls.push(p);return route.fulfill({json:p.action==='VALIDATE'?{valid:true,invoices:[{invoice:'TEST',supplierId:10,currencyId:1,lines:1,date:'2026-10-31',subtotal:100}]}:{valid:true,imported:1}});});
 await page.goto(baseURL+'/supplier-invoice-bulk.html');await page.waitForFunction(()=>!document.getElementById('template').disabled);
 const pending=page.waitForEvent('download');await page.locator('#template').click();const download=await pending,book=new ExcelJS.Workbook();await book.xlsx.readFile(await download.path());assert.equal(book.getWorksheet('Contexto').getCell('A2').value,1);assert.equal(book.getWorksheet('Proveedores').getCell('A2').value,10);assert.equal(book.getWorksheet('Facturas').getCell('Q1').value,'NotaLinea');
 const data=['TEST','2026-10-31','10','1','2','1','','','203',2,50];book.getWorksheet('Facturas').addRow(data);
 const upload=async()=>page.locator('#file').setInputFiles({name:'facturas.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(await book.xlsx.writeBuffer())});
 await upload();await page.locator('#validate').click();await page.waitForFunction(()=>!document.getElementById('import').disabled);assert.equal(calls.length,1);assert.equal(calls[0].rows[0].Cantidad,'2');assert.equal(calls[0].rows[0].__row,2);assert.equal(calls[0].subsidiaryId,1);await mkdir('.task-tmp',{recursive:true});await page.screenshot({path:'.task-tmp/supplier-invoice-bulk.png',fullPage:true});
 page.once('dialog',d=>d.accept());await page.locator('#import').click();await page.waitForFunction(()=>document.getElementById('message').textContent.includes('Carga finalizada'));assert.equal(calls[1].requestId,calls[0].requestId);assert.equal(calls[1].action,'IMPORT');
 book.getWorksheet('Facturas').getCell('J2').value={formula:'1+1'};await upload();await page.locator('#validate').click();await page.waitForFunction(()=>document.getElementById('message').textContent.includes('sin fórmulas'));assert.equal(calls.length,2);
 book.getWorksheet('Contexto').getCell('A2').value=2;await upload();await page.locator('#validate').click();await page.waitForFunction(()=>document.getElementById('message').textContent.includes('otra subsidiaria'));assert.equal(calls.length,2);assert.deepEqual(errors,[]);
});
