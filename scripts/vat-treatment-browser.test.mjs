import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import {chromium} from '@playwright/test';
const root=new URL('../public/',import.meta.url);
test('browser displays separate treatment totals and opens each code detail',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':undefined)});
 try{
 const context=await browser.newContext({viewport:{width:1440,height:1100}});
 await context.addInitScript(()=>{localStorage.setItem('nexo_token','synthetic-vat-token');});
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const summary={salesTaxableBase:1000,salesTax:130,purchaseTax:0,salesExemptBase:100,salesNonSubjectBase:200,salesZeroRateBase:300,salesUnclassifiedBase:400,purchaseExemptBase:50,purchaseNonSubjectBase:60,purchaseZeroRateBase:70,purchaseUnclassifiedBase:0};
 const rows=[['EXEMPT',100],['NON_SUBJECT',200],['ZERO_RATE',300],['UNCLASSIFIED',400]].map(([classification,baseAmount],i)=>({key:String(i),taxCode:'SYN-'+classification,classification,baseAmount,rate:0,taxAmount:0,documentCount:1}));
 const report={header:{currencyCode:'USD',currencySymbol:'$',periodMonth:'2026-11'},summary,sales:{rows},purchases:{rows:[]},details:rows.map((r,i)=>({...r,side:'SALES',documentNumber:'SYN-'+i,documentType:'INVOICE',documentDate:'2026-11-01',grossAmount:r.baseAmount,taxRate:0})),retentions:{}};
 await page.route('**/*',route=>{
 const url=new URL(route.request().url());if(url.hostname!=='vat.synthetic')return route.abort();
 if(url.pathname.endsWith('/options'))return route.fulfill({json:{subsidiary:{id:1,name:'Sociedad sintética',currencyCode:'USD'},country:{name:'El Salvador'},taxLabel:'IVA',defaultPeriod:'2026-11',documentStatuses:[{value:'APROBADO',label:'Aprobado'}]}});
 if(url.pathname==='/api/v1/reports/tax/vat-declaration')return route.fulfill({json:report});
 const name=url.pathname.slice(1)||'vat-declaration-report.html';if(!['vat-declaration-report.html','vat-declaration-report.js','vat-declaration-report.css'].includes(name))return route.abort();
 return route.fulfill({body:fs.readFileSync(new URL(name,root)),contentType:name.endsWith('.html')?'text/html':name.endsWith('.js')?'text/javascript':'text/css'});
 });
 await page.goto('http://vat.synthetic/vat-declaration-report.html');await page.waitForSelector('.rate-row');
 const text=await page.locator('#summary').innerText();for(const label of ['Exento','No sujeto','Tasa cero','Sin clasificar'])assert.ok(text.includes(label));for(const amount of ['100,00','200,00','300,00','400,00'])assert.ok(text.includes(amount),amount);
 assert.equal(await page.locator('.rate-row').count(),4);assert.ok((await page.locator('.rate-row').nth(1).innerText()).includes('No sujeto'));
 await page.locator('.rate-row').nth(1).click();await page.waitForSelector('#detailDialog[open]');assert.ok((await page.locator('#detailRows').innerText()).includes('SYN-1'));await page.locator('#closeDetailFooter').click();
 assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
