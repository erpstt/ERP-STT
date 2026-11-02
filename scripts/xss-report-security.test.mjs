import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import {chromium} from '@playwright/test';

const attack='"><img src=x onerror="window.__xss=true"> & <b>dato</b>';
const files=['html-safety','frontend-performance','accounting-reports','accounting-aging-report','accounting-income-statement-matrix','account-statement','consolidation','fx-revaluation','fixed-assets-reports','intercompany-commercial-report','intercompany-loans-report','bank-report-pdf'];
const sources=new Map();
for(const name of files){
 let source;
 if(process.env.A03_REPORT_SOURCE_URL){const response=await fetch(new URL('/'+name+'.js',process.env.A03_REPORT_SOURCE_URL));assert.equal(response.status,200,name);source=await response.text();}
 else source=await readFile(new URL('../public/'+name+'.js',import.meta.url),'utf8');
 sources.set(name,source);
}
function declarations(file,names){
 const source=sources.get(file),sf=ts.createSourceFile(file,source,99,true,1),out=[];
 for(const name of names){let found=false;for(const statement of sf.statements){
  if(ts.isFunctionDeclaration(statement)&&statement.name?.text===name){out.push(statement.getText(sf).replace(/^export\s+/,''));found=true;break;}
  if(ts.isVariableStatement(statement))for(const item of statement.declarationList.declarations)if(item.name.getText(sf)===name){out.push('const '+item.getText(sf)+';');found=true;break;}
 }assert.ok(found,file+': '+name);}
 return out.join('\n');
}
const prelude=`const $=id=>document.getElementById(id),htmlText=window.__escapeHtml,escapeHtml=htmlText,esc=htmlText;`;
async function execute(page,code,input={}){return page.evaluate(({code,input})=>new Function('input',code)(input),{code:prelude+code,input});}
async function clean(page){await page.waitForTimeout(30);assert.equal(await page.locator('img[src="x"],svg[onload],[onerror],[onfocus],[onmouseover]').count(),0);assert.equal(await page.evaluate(()=>window.__xss===true),false);}
async function reset(page,body){await page.setContent(body);await page.evaluate(()=>{window.__xss=false;window.__downloads=[];});}

test('reportes: texto y atributos hostiles, exportaciones e importes originales',{timeout:90000},async t=>{
 // Only source files are served. No API, database, credentials or document generators.
 const server=createServer((req,res)=>{const name=new URL(req.url,'http://localhost').pathname.slice(1).replace(/\.js$/,'');if(!sources.has(name)){res.writeHead(404);res.end();return;}res.setHeader('Content-Type','text/javascript');res.end(sources.get(name));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const base=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({headless:true});t.after(()=>browser.close());const context=await browser.newContext();t.after(()=>context.close());
 const requests=[];await context.route('**/*',route=>{const u=new URL(route.request().url());requests.push(u.pathname);return u.origin===base&&u.pathname.endsWith('.js')?route.continue():route.abort();});
 const page=await context.newPage();await page.goto(base+'/html-safety.js');await page.evaluate(async base=>{window.__escapeHtml=(await import(base+'/html-safety.js')).escapeHtml;},base);

 await t.test('contabilidad: encabezados, celdas y Excel conservan texto y SUM',async()=>{
  await reset(page,'<table><thead id="thead"></thead><tbody id="tbody"></tbody><tfoot id="tfoot"></tfoot></table><div id="summary"></div><input id="to" value="2026-11-02">');
  const code=`const data=input.data,options={},current=['operational','custom','Reporte'],sort={key:''};const renderPager=()=>{},exportContext=()=>({subsidiaryName:input.attack,periodLabel:'2026',currencyLabel:'USD'}),download=(blob,name)=>window.__downloads.push({blob,name});`+declarations('accounting-reports',['labels','moneyKeys','fmt','renderSummary','render','exportRows'])+`render();return exportRows('excel');`;
  await execute(page,code,{attack,data:{rows:[{[attack]:attack,debit:-123.45,credit:200}],summary:{[attack]:1}}});
  assert.equal(await page.locator('th').first().textContent(),attack.replaceAll('_',' '));assert.equal(await page.locator('tbody td').first().textContent(),attack);
  const text=await page.evaluate(()=>window.__downloads[0].blob.text());assert.ok(text.includes('=SUM(B2:B2)'));assert.ok(text.includes('>-123.45</td>'));
  await page.locator('body').evaluate((body,text)=>{const div=document.createElement('div');div.id='excel';div.innerHTML=text;body.append(div);},text);
  assert.equal(await page.locator('#excel td').first().textContent(),attack);assert.equal(await page.locator('#excel th').first().textContent(),attack);await clean(page);
 });
 await t.test('Libro Mayor: moneda y atributos escapados sin perder el enlace al asiento',async()=>{
  await reset(page,'<select id="currency"><option value="1">USD</option></select><select id="ledgerView"><option value="ACCOUNT"></option></select><table><thead id="thead"></thead><tbody id="tbody"></tbody></table><div id="summary"></div>');
  await execute(page,`const data=input.data,options={currencies:[{id:1,symbol:input.attack}]},renderPager=()=>{},openJournalDrawer=id=>window.__journal=id;`+declarations('accounting-reports',['financial','renderGeneralLedger'])+'renderGeneralLedger();',{attack,data:{rows:[{account_id:1,account_number:'1101',account_name:attack,nature:'DEUDORA',journal_id:attack,journal_number:attack,date:'2026-11-02',debit:100,credit:0,opening_balance:0,running_balance:100,account_debit_total:100,account_final_balance:100}],total:1}});
  const button=page.locator('[data-journal]').first();assert.equal(await button.getAttribute('data-journal'),attack);await button.click();assert.equal(await page.evaluate(()=>window.__journal),attack);assert.ok((await page.locator('tbody').textContent()).includes(attack+' 100,00'));await clean(page);
 });
 await t.test('matriz: grupos y cuentas mantienen identificadores, resultado neto y conciliación',async()=>{
  await reset(page,'<section id="workspace"><table><thead id="thead"></thead><tbody id="tbody"></tbody></table></section><div id="summary"></div>');
  await page.evaluate(async({attack,base})=>{const {renderIncomeStatementMatrix}=await import(base+'/accounting-income-statement-matrix.js');renderIncomeStatementMatrix({data:{rows:[{account_id:attack,account_number:'4001',account_name:attack,group_id:attack,category:'Ingreso',dimensions:{one:100}}],columns:[{id:'one',name:attack}],summary:{periodResult:100}},options:{accountGroups:[{id:attack,code:attack,name:attack,level:1}]},financial:value=>attack+' '+Number(value).toFixed(2),escapeHtml:window.__escapeHtml,incomeSection:()=> 'revenue',toggleTree:()=>{},openLedger:id=>window.__account=id,renderPager:()=>{}});},{attack,base});
  assert.equal(await page.locator('[data-account]').first().getAttribute('data-account'),attack);await page.locator('[data-account]').first().click();assert.equal(await page.evaluate(()=>window.__account),attack);assert.ok((await page.locator('#summary').textContent()).includes('Coincide al centavo'));await clean(page);
 });
 await t.test('antigüedad: detalle, resumen y exportación conservan documentos e importes',async()=>{
  await reset(page,'<table><thead id="thead"></thead><tbody id="tbody"></tbody></table><div id="summary"></div>');
  const result=await page.evaluate(async({attack,base})=>{const mod=await import(base+'/accounting-aging-report.js'),context={data:{rows:[{entity_id:attack,entity_code:'SYN',entity_name:attack,document_id:attack,journal_id:attack,document_number:attack,identification:attack,manager:attack,issue_date:'2026-01-01',due_date:'2026-02-01',overdue_days:30,bucket:'1_30',original_amount:100,applied_amount:25,pending:75}],summary:{subledger:75,netBalance:75,controlBalance:75,difference:0}},options:{currencies:[],subsidiaries:[]},reportKey:'receivables-aging',reportTitle:'Auxiliar',view:'DETAIL',currencyMode:'LOCAL',cutoff:'2026-11-02',financial:value=>attack+' '+Number(value).toFixed(2),elements:{thead:document.getElementById('thead'),tbody:document.getElementById('tbody'),summary:document.getElementById('summary')},openJournal:id=>window.__journal=id,renderPager:()=>{},exportContext:{subsidiaryName:attack,periodLabel:'2026',currencyLabel:'USD'}};mod.renderCurrencyAwareAgingReport(context);const id=document.querySelector('[data-journal]').dataset.journal;document.querySelector('[data-journal]').click();const excel=await mod.buildAgingExport(context,'excel').blob.text(),csv=await mod.buildAgingExport(context,'csv').blob.text();context.view='SUMMARY';mod.renderCurrencyAwareAgingReport(context);return{id,clicked:window.__journal,statement:document.querySelector('[data-statement]').dataset.statement,excel,csv};},{attack,base});
  assert.equal(result.id,attack);assert.equal(result.clicked,attack);assert.equal(result.statement,attack);assert.ok(result.excel.includes('>75</td>'));assert.ok(result.csv.includes('"100","25","75"'));
  await page.locator('body').evaluate((body,text)=>{const div=document.createElement('div');div.id='export';div.innerHTML=text;body.append(div);},result.excel);assert.equal(await page.locator('#export h1').textContent(),attack);await clean(page);
 });
 await t.test('consolidación: parámetros y hoja de trabajo preservan valores y sumas',async()=>{
  await reset(page,'<a id="forecastLink"></a><select id="holding"></select><select id="currency"></select><select id="period"></select><table><thead id="thead"></thead><tbody id="tbody"></tbody></table><div id="summary"></div>');
  await execute(page,`let data=null,run={id:1};const money=n=>Number(n||0).toFixed(2),api=async path=>path.endsWith('/worksheet')?input.sheet:input.options;`+declarations('consolidation',['load','worksheet'])+'return load().then(worksheet);',{options:{canRun:false,holding:{name:attack},currency:{code:attack},periods:[attack]},sheet:{subsidiaries:[{id:1,name:attack}],rows:[{code:attack,name:attack,companies:{1:100},summed:100,consolidated:100}],run:{total_assets:100}}});
  assert.equal(await page.locator('#holding option').textContent(),attack);assert.equal(await page.locator('#period').inputValue(),attack);assert.ok((await page.locator('tbody').textContent()).includes('100.00'));await clean(page);
 });
 await t.test('estado de cuenta: mora y símbolo de moneda son texto; saldo neto correcto',async()=>{
  const html=await readFile(new URL('../public/account-statement.html',import.meta.url),'utf8');await reset(page,html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,''));
  const source=sources.get('account-statement').replace(/^import[^\n]+\n/,'');
  await page.evaluate(async({source,attack})=>{
   localStorage.setItem('nexo_token','synthetic-report-session');
   sessionStorage.setItem('nexo_account_statement',JSON.stringify({kind:'AR',report:'receivables-aging',entityId:1,entityName:attack,subsidiary:{id:1,name:attack},currency:{symbol:attack},cutoff:'2026-11-02',filters:{}}));
   const code=`const htmlText=window.__escapeHtml,fetch=async path=>({ok:true,json:async()=>path.includes('/subsidiaries/')?{name:input.attack}:path.includes('/entities/')?[{customer_id:1,company_name:input.attack}]:{rows:[{document_number:input.attack,issue_date:'2026-01-01',due_date:'2026-02-01',overdue_days:input.attack,original_amount:100,applied_amount:25,pending:75,entity_advances:5,bucket:'1_30'}]}});`+source;
   await new (Object.getPrototypeOf(async function(){}).constructor)('input',code)({attack});
  },{source,attack});
  assert.equal(await page.locator('#documents td').nth(3).textContent(),attack);assert.equal(await page.locator('#netBalance').textContent(),attack+' 70,00');assert.equal(await page.locator('#statement').isVisible(),true);await clean(page);
 });
 await t.test('PDF bancario: nombres y monedas son texto; importes y estructura se conservan',async()=>{
  await reset(page,'<main></main>');
  const html=await page.evaluate(async({attack,base})=>{const mod=await import(base+'/bank-report-pdf.js');return mod.bankBalancesPdfHtml({localCurrency:{symbol:attack,code:'USD'},localAccounts:[{bank:attack,account:attack,currency:'USD',balance:100,localEquivalent:100}],localValidationGroups:[{bankTotal:100,ledgerBalance:99,difference:1,matches:false}],summary:{totalLocalEquivalent:100}},{name:attack});},{attack,base});
  await page.setContent(html);assert.ok((await page.locator('body').textContent()).includes(attack+' 100,00'));assert.ok(await page.locator('table').count()>=2);await clean(page);
 });
 await t.test('PDF de cierre: columnas numéricas y datos de conciliación no introducen HTML',async()=>{
  await reset(page,'<main></main>');
  const html=await page.evaluate(async({attack,base})=>{const {bankCloseReportHtml}=await import(base+'/bank-report-pdf.js');return bankCloseReportHtml({header:{symbol:attack,legalName:attack,code:'SYN'},summary:{statementBalance:100,bookBalance:100,difference:0},movements:[{date:'2026-11-02',entry:100,note:attack}],pendingBankMovements:[]},'DETAIL');},{attack,base});
  await page.setContent(html);assert.ok((await page.locator('body').textContent()).includes(attack+' 100,00'));assert.ok((await page.locator('.badge').textContent()).includes('CUADRADO'));await clean(page);
 });
 await t.test('atributos reales de revaluación, activos e intercompany no crean elementos ni eventos',async()=>{
  for(const file of ['fx-revaluation','fixed-assets-reports','intercompany-commercial-report','intercompany-loans-report']){
   const source=sources.get(file),sf=ts.createSourceFile(file,source,99,true,1),templates=[];
   function scan(n){if(ts.isTemplateExpression(n)&&n.getText(sf).includes('htmlText('))templates.push(n.getText(sf));ts.forEachChild(n,scan);}scan(sf);
   assert.ok(templates.length,file+' templates');
   for(const template of templates){
    await reset(page,'<table><tbody id="subject"></tbody></table><select id="options"></select>');
    const rendered=await execute(page,`const proxy=new Proxy(function(){return input.attack},{get:(_,key)=>key===Symbol.toPrimitive?()=>input.attack:proxy,apply:()=>input.attack});const known={htmlText,esc,encodeURIComponent,String,Number,Math,row:proxy,item:proxy,money:()=> '100.00',date:()=> '2026-11-02',rateLabel:()=> '1.00',integer:()=> '1',partyCell:()=>'<td>Cliente</td>',companyCell:()=>'<td>Compañía</td>',currencyCell:()=>'<td>USD</td>',accountCell:()=>'<td>1101</td>',fxLocalAmount:()=>''};const scope=new Proxy(known,{has:()=>true,get:(obj,key)=>key===Symbol.unscopables?undefined:key in obj?obj[key]:proxy});return new Function('scope','with(scope){return '+input.template+'}')(scope);`,{attack,template});
    await page.evaluate(({rendered,template})=>{document.getElementById(template.startsWith('`<option')?'options':'subject').innerHTML=rendered;},{rendered,template});await clean(page);
    assert.ok((await page.locator('body').textContent()).includes(attack)||await page.locator('[data-detail],[data-cancel],option').count()>0,file+' hostile input must reach rendering');
   }
  }
 });
 assert.ok(!requests.some(path=>path.startsWith('/api/')),'No API requests');
 t.diagnostic(process.env.A03_REPORT_SOURCE_URL?'Verified published sources in isolated Chromium':'Verified local sources in isolated Chromium');
});
