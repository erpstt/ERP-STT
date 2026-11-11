import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import ExcelJS from 'exceljs';
import {PGlite} from '@electric-sql/pglite';
import {setupTaxCatalogSecurity} from './fixtures/setup-tax-catalog-security.mjs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8').replaceAll('\r\n','\n');
const migration=read('supabase/migrations/20261111170818_distinguish_vat_tax_treatments.sql');
const original=read('supabase/migrations/20261002150000_vat_declaration_report.sql');
const db=new PGlite();let body;
before(async()=>{
 await setupTaxCatalogSecurity(db);
 await db.exec('update tax_codes set is_purchase_creditable=coalesce(is_purchase_creditable,true),is_import_tax=coalesce(is_import_tax,false)');
 await db.exec(`alter table tax_codes alter column rate_percentage set not null;alter table tax_codes alter column is_withholding set not null;alter table tax_codes alter column is_purchase_creditable set not null;alter table tax_codes alter column is_import_tax set not null;`);
 const report=original.slice(original.indexOf('create or replace function public.run_vat_declaration_report'),original.lastIndexOf("revoke all on function public.vat_declaration_report_options"));
 await db.exec('set check_function_bodies=off');await db.exec(report);await db.exec('set check_function_bodies=on');
 const before=(await db.query("select proacl::text acl from pg_proc where oid='public.run_vat_declaration_report(jsonb)'::regprocedure")).rows[0];
 await db.exec('begin');await db.exec(migration);await db.exec('commit');
 const after=(await db.query("select proacl::text acl,prosrc from pg_proc where oid='public.run_vat_declaration_report(jsonb)'::regprocedure")).rows[0];
 assert.equal(after.acl,before.acl);body=after.prosrc;
});
after(()=>db.close());
test('all four SQL document classifiers distinguish treatments regardless of purchase credit eligibility',async()=>{
 const cases=[...body.matchAll(/case when line.tax_code_id is null then'NO_CODE'[\s\S]*?end(?: tax_classification)?/g)].map(m=>m[0].replace(/ tax_classification$/,''));assert.equal(cases.length,4);
 for(const expression of cases){
 const result=await db.query(`select tax.tax_treatment,${expression} classification from(values(1::bigint,1::numeric))line(tax_code_id,tax_rate) cross join(values(1::bigint,1,true,'Ambos',true,false,0::numeric,'Exento'),(1,1,true,'Ambos',false,false,0,'No sujeto'),(1,1,true,'Ambos',true,false,0,'Tasa cero'),(1,1,true,'Ambos',false,false,0,'Sin clasificar'))tax(tax_code_id,country_id,is_indirect_tax,applies_to,is_purchase_creditable,is_import_tax,rate_percentage,tax_treatment) cross join(values(1))company(company_country_id)`);
 // Use the document's stored zero rate, as it takes precedence over the catalog.
 const zero=await db.query(`select tax.tax_treatment,${expression} classification from(values(1::bigint,0::numeric))line(tax_code_id,tax_rate) cross join(values(1::bigint,1,true,'Ambos',false,false,0::numeric,'Exento'),(1,1,true,'Ambos',false,false,0,'No sujeto'),(1,1,true,'Ambos',true,false,0,'Tasa cero'),(1,1,true,'Ambos',false,false,0,'Sin clasificar'))tax(tax_code_id,country_id,is_indirect_tax,applies_to,is_purchase_creditable,is_import_tax,rate_percentage,tax_treatment) cross join(values(1))company(company_country_id)`);
 assert.deepEqual(zero.rows.map(r=>r.classification),['EXEMPT','NON_SUBJECT','ZERO_RATE','UNCLASSIFIED']);assert.equal(result.rows.length,4);
 }
});
test('SQL totals separate sales, purchases, credit notes and unknown rows without changing settlement',async()=>{
 const totals=body.slice(body.indexOf(' totals as(')+1,body.indexOf(' retention_totals as('));
 const {rows:[r]}=await db.query(`with details(side,base_amount,tax_reportable,tax_rate,tax_classification,tax_amount,excluded_tax_amount,gross_amount,document_type,document_id)as(values
 ('SALES',100,true,0,'EXEMPT',0,0,100,'INVOICE',1),('SALES',-10,true,0,'EXEMPT',0,0,-10,'CREDIT',2),
 ('SALES',200,true,0,'NON_SUBJECT',0,0,200,'INVOICE',3),('SALES',300,true,0,'ZERO_RATE',0,0,300,'INVOICE',4),('SALES',400,true,0,'UNCLASSIFIED',0,0,400,'INVOICE',5),('SALES',1000,true,13,'DOMESTIC',130,0,1130,'INVOICE',6),
 ('PURCHASES',50,false,0,'EXEMPT',0,0,50,'INVOICE',7),('PURCHASES',60,false,0,'NON_SUBJECT',0,0,60,'INVOICE',8),('PURCHASES',70,true,0,'ZERO_RATE',0,0,70,'INVOICE',9),('PURCHASES',500,true,13,'DOMESTIC',65,0,565,'INVOICE',10)) ,${totals.replace(/,\s*$/,'')} select * from totals`);
 for(const[k,v]of Object.entries({sales_exempt_base:90,sales_non_subject_base:200,sales_zero_rate_base:300,sales_unclassified_base:400,purchase_exempt_base:50,purchase_non_subject_base:60,purchase_zero_rate_base:70,sales_tax:130,purchase_tax:65}))assert.equal(Number(r[k]),v,k);
});
async function assume(){await db.exec('reset role');await db.query("insert into user_role_sessions values('fixture',1,1)on conflict(session_id)do update set user_id=1,role_id=1");await db.query("insert into user_company_sessions values('fixture',1,1)on conflict(session_id)do update set user_id=1,subsidiary_id=1");await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:'00000000-0000-0000-0000-000000000001',session_id:'fixture'})]);await db.exec('set role authenticated');}
test('authorized catalog RPC saves treatment, applies defaults and rejects invalid combinations',async()=>{
 await db.exec('begin');try{await assume();const save=async(k,p)=>(await db.query('select save_tax_catalog($1,$2,null)d',[k,p])).rows[0].d;
 const a=await save('tax-agencies',{agency_name:'Synthetic DGII',country_id:1,tax_id:'SYN',subsidiary_ids:[1]});
 const t=await save('tax-types',{type_name:'Synthetic IVA',country_id:1,applies_to:'Ambos',is_indirect_tax:true});
 const p={code_name:'SYN-EX',country_id:1,tax_agency_id:a.tax_agency_id,tax_type_id:t.tax_type_id,rate_percentage:0,is_withholding:false,is_purchase_creditable:false,is_import_tax:false,tax_treatment:'Exento',subsidiary_ids:[1]};
 for(const treatment of ['Exento','No sujeto','Tasa cero'])assert.equal((await save('tax-codes',{...p,code_name:treatment,tax_treatment:treatment})).tax_treatment,treatment);
 const {tax_treatment,...legacy}=p;assert.equal((await save('tax-codes',{...legacy,code_name:'SYN-LEGACY'})).tax_treatment,'Sin clasificar');
 for(const patch of [{tax_treatment:'bad'},{rate_percentage:13},{is_purchase_creditable:true},{is_import_tax:true}]){await db.exec('savepoint invalid');await assert.rejects(save('tax-codes',{...p,...patch}),e=>e.code==='23514');await db.exec('rollback to savepoint invalid');}
 }finally{await db.exec('rollback;reset role');}
});
const serviceSource=read('src/modules/reports/vat-declaration-report.service.ts').replace(/^import .*;\n/gm,'').replace(/export /g,'');
const runtime=new Function('createExcelWorkbook',ts.transpileModule(serviceSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText+';return {normalizeReport,normalizeRow,pdfHtml,exportVatDeclarationReportExcel,set fullReport(value){fullReport=value}};')(async()=>new ExcelJS.Workbook());
const fixture={header:{currencyCode:'USD',currencySymbol:'$',countryName:'El Salvador'},details:['SALES','PURCHASES'].flatMap(side=>[['EXEMPT',100],['NON_SUBJECT',200],['ZERO_RATE',300],['UNCLASSIFIED',400],['DOMESTIC',1000]].map(([classification,amount],index)=>({side,classification,taxCode:'SYN-'+classification,baseAmount:amount,taxRate:classification==='DOMESTIC'?13:0,taxAmount:classification==='DOMESTIC'?130:0,grossAmount:classification==='DOMESTIC'?1130:amount,documentNumber:side+index}))),summary:{}};
test('normalization and PDF separate all bases and preserve totals and escaping',()=>{
 const report=runtime.normalizeReport(fixture);for(const prefix of ['sales','purchase'])for(const[k,v]of Object.entries({ExemptBase:100,NonSubjectBase:200,ZeroRateBase:300,UnclassifiedBase:400,TaxableBase:1000}))assert.equal(report.summary[prefix+k],v,prefix+k);
 assert.equal(report.summary.salesGrossAmount,2130);assert.equal(report.summary.netTax,0);const html=runtime.pdfHtml(report);for(const label of ['Operaciones exentas','Operaciones no sujetas','Operaciones a tasa cero','Compras exentas','Compras no sujetas','Compras a tasa cero'])assert.ok(html.includes(label),label);assert.ok(!html.includes('Exento / 0%'));
 assert.equal(runtime.normalizeRow({classification:'EXEMPT',baseAmount:-25,taxRate:0,taxAmount:0},'SALES',report.header).exemptAmount,-25);
 assert.equal(runtime.normalizeRow({baseAmount:25,taxRate:0,taxAmount:0},'SALES',report.header).unclassifiedAmount,25);
});
test('real Excel workbook separates treatment and bases in summary and both details',async()=>{
 runtime.fullReport=async()=>runtime.normalizeReport(fixture);const file=await runtime.exportVatDeclarationReportExcel('synthetic',{});const wb=new ExcelJS.Workbook();await wb.xlsx.load(file.buffer);
 for(const name of ['Detalle Ventas','Detalle Compras']){const sh=wb.getWorksheet(name);assert.equal(sh.getCell('U3').value,'Tratamiento fiscal',JSON.stringify(sh.getSheetValues().slice(0,6)));assert.equal(sh.getCell('U4').value,'Exento');assert.equal(sh.getCell('V4').value,100);assert.equal(sh.getCell('U5').value,'No sujeto');assert.equal(sh.getCell('W5').value,200);assert.equal(sh.getCell('X6').value,300);assert.equal(sh.getCell('Y7').value,400);assert.equal(sh.getCell('N4').value,100);}
 const rows=wb.getWorksheet('Resumen').getSheetValues();for(const[label,base]of [['Ventas exentas',100],['Ventas no sujetas',200],['Ventas tasa cero',300],['Compras no sujetas',200]])assert.equal(rows.find(r=>r?.[1]===label)?.[2],base,label);
});
test('browser exposes distinct treatment totals and labels, escaping unknown values',()=>{
 let ui=read('public/vat-declaration-report.js');ui=ui.slice(ui.indexOf('const first='),ui.indexOf("$('generate')")); // Execute only pure helpers below, independently of DOM initialization.
 const source=read('public/vat-declaration-report.js');const context=vm.createContext({});
 const first=source.slice(source.indexOf('const first='),source.indexOf('const number='));
 const helper=source.match(/function treatmentLabel\(row\)\{[^\n]+/)[0];vm.runInContext(first+'\nconst rowAmount=(row,...keys)=>Number(first(row,...keys)||0);\n'+helper,context);
 assert.deepEqual(['EXEMPT','NON_SUBJECT','ZERO_RATE','UNCLASSIFIED'].map(classification=>context.treatmentLabel({classification})),['Exento','No sujeto','Tasa cero','Sin clasificar']);
 assert.ok(source.includes("['NonSubject','No sujeto']"));assert.ok(source.includes("['ZeroRate','Tasa cero']"));
});
