import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import ts from 'typescript';
import {chromium} from '@playwright/test';
import {budgetAction} from '../dist/modules/budget/budget.service.js';
import {primeRoleAccessCache} from '../dist/modules/security-catalogs/role-access-matrix.module.js';
const names=['app','budget','budget-xlsx','spreadsheet-safety','html-safety'],sources=new Map();
for(const name of names){if(process.env.CATALOG_CSV_SOURCE_URL){const response=await fetch(new URL('/'+name+'.js',process.env.CATALOG_CSV_SOURCE_URL));assert.equal(response.status,200);sources.set(name,await response.text());}else sources.set(name,await readFile(new URL('../public/'+name+'.js',import.meta.url),'utf8'));}
function extract(name,predicate){const sf=ts.createSourceFile(name,sources.get(name),99,true,1);let found;function walk(n){if(predicate(n,sf))found=n;ts.forEachChild(n,walk);}walk(sf);assert.ok(found,name);return found.getText(sf);}
test('exportadores reales del navegador y reimportación de presupuesto, sin guardar datos reales',{timeout:60000},async t=>{
 const server=createServer((req,res)=>{const name=new URL(req.url,'http://localhost').pathname.slice(1).replace(/\.js$/,'');if(!sources.has(name)){res.writeHead(404);res.end();return;}res.setHeader('Content-Type','text/javascript');res.end(sources.get(name));});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));const base=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();await page.route('**/*',r=>new URL(r.request().url()).origin===base&&r.request().url().includes('.js')?r.continue():r.abort());await page.goto(base+'/html-safety.js');await page.evaluate(async base=>{window.__csv=(await import(base+'/spreadsheet-safety.js')).csvCell;window.__blobs=[];URL.createObjectURL=blob=>{window.__blobs.push(blob);return 'blob:synthetic';};HTMLAnchorElement.prototype.click=function(){};},base);
 await t.test('Plan de cuentas protege arreglos/objetos después de convertirlos a texto',async()=>{
  const method=extract('app',n=>ts.isMethodDeclaration(n)&&n.name?.getText()==='downloadChartAccounts');
  const csv=await page.evaluate(async method=>{const object={catalogExporting:false,tableError:'',activeCatalog:{primaryKey:'id',fields:[{key:'name',label:'Nombre'},{key:'amount',label:'Monto'},{key:'list',label:'Lista'},{key:'object',label:'Objeto'}]},api:async()=>[{id:1,name:'\u2066=1+1',amount:-123.45,list:['=1+1','Otra'],object:{text:'=1+1'},code:'00123'}]};await new Function('protectedCsvCell','object','return ({'+method+'}).downloadChartAccounts.call(object)')(window.__csv,object);if(object.tableError)throw Error(object.tableError);return window.__blobs.at(-1).text();},method);
  assert.ok(csv.includes('"\t\u2066=1+1"'));assert.ok(csv.includes('"\t=1+1 | Otra"'));assert.ok(csv.includes('"-123.45"'));assert.ok(csv.includes('"00123"'));assert.ok(csv.includes('{""text"":""=1+1""}'));
 });
 await t.test('plantilla presupuestaria descarga doce meses y vuelve al importador real',async st=>{
  const functions=['templateRows','exportTemplate'].map(name=>extract('budget',n=>ts.isFunctionDeclaration(n)&&n.name?.text===name)).join('\n');
  await page.setContent('<input id="version" value="7"><p id="templateStatus"></p>');
  const csv=await page.evaluate(async functions=>{const code=`const csvCell=window.__csv,$=id=>document.getElementById(id),matrix=[{accountId:1,months:Array(12).fill(123.45)}],options={accounts:[{id:1,number:'-00123',name:'=1+1',category:'Gasto'}]},report={header:{anio:2027}},categories=()=>['Gasto'],downloadBlob=(name,blob)=>window.__blobs.push(blob);`+functions+`;exportTemplate('csv');return window.__blobs.at(-1).text();`;return new Function(code)();},functions);
  assert.ok(csv.includes('"\t-00123"'));assert.ok(csv.includes('"\t=1+1"'));assert.ok(csv.includes('"123.45"'));
  const original=globalThis.fetch,oldUrl=process.env.SUPABASE_URL,oldKey=process.env.SUPABASE_ANON_KEY;st.after(()=>{globalThis.fetch=original;if(oldUrl===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=oldUrl;if(oldKey===undefined)delete process.env.SUPABASE_ANON_KEY;else process.env.SUPABASE_ANON_KEY=oldKey;});
  process.env.SUPABASE_URL='https://catalog-csv.invalid';process.env.SUPABASE_ANON_KEY='synthetic-public';const auth='Bearer catalog-csv-budget';await primeRoleAccessCache(auth,{isAdmin:false,grants:[{resourceKey:'accounting:budget-lines',canView:true,canCreate:false,canEdit:true,canDelete:false}]});const calls=[];globalThis.fetch=async(url,init)=>{const parsed=new URL(url);assert.equal(parsed.hostname,'catalog-csv.invalid');assert.equal(parsed.pathname,'/rest/v1/rpc/budget_save_lines');calls.push(JSON.parse(init.body));return Response.json({ok:true});};
  await budgetAction(auth,'import-excel',{id:7,revision:3,fileName:'synthetic.csv',base64:Buffer.from(csv).toString('base64')});assert.equal(calls.length,1);const payload=calls[0].p;assert.equal(payload.lines.length,12);assert.ok(payload.lines.every(row=>row.account==='-00123'&&row.amount==='123.45'));assert.equal(payload.lines[0].month,'2027-01');assert.equal(payload.lines.at(-1).month,'2027-12');
 });
 t.diagnostic(process.env.CATALOG_CSV_SOURCE_URL?'Published browser sources with isolated synthetic dependencies':'Local browser sources with isolated synthetic dependencies');
});
