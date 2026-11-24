import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {bankBrowserFixture} from './lib/bank-browser-fixture.mjs';
import {reportCatalog} from '../dist/modules/reports/report-catalog.js';
import {roleAccessModules,primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';
import {availableReports,requireReportAccess,reportForRoute} from '../dist/modules/reports/report-access.service.js';

const grant=key=>({resourceKey:key,canView:true,canCreate:false,canEdit:false,canDelete:false});
test('all reports appear once in the role matrix, with view-only access',()=>{
 const resources=roleAccessModules.find(m=>m.key==='reports').resources;
 assert.equal(new Set(reportCatalog.map(r=>r.key)).size,reportCatalog.length);
 for(const report of reportCatalog){const resource=resources.find(r=>r.key===`reports:${report.key}`);assert.equal(resource.optionName,report.title);assert.deepEqual(resource.actions,['view']);}
 for(const report of reportCatalog.filter(r=>r.path)){assert.equal(reportForRoute(report.path),report.key);assert.equal(reportForRoute(report.path+'/excel'),report.key);}
 assert.equal(reportForRoute('/api/reports/accounting/general-ledger/export'),'general-ledger');
 assert.equal(reportForRoute('/api/reports/accounting/purchase-transactions/supports/42'),'purchase-transactions');
 assert.equal(reportForRoute('/api/sales/customer-payments/fees/pdf'),'customer-payment-fees');
});
test('a payroll role sees only granted reports; the general menu grant does not authorize a report',async()=>{
 const token='Bearer report-role-test';
 try{
  await primeRoleAccessCache(token,{isAdmin:false,grants:[grant('reports:accounting-reports'),grant('reports:payroll-journals')]});
  assert.deepEqual((await availableReports(token)).map(r=>r.key),['payroll-journals']);
  await requireReportAccess(token,'payroll-journals');
  await assert.rejects(requireReportAccess(token,'receivables-aging'),e=>e.status===403);
  await primeRoleAccessCache(token,{isAdmin:false,grants:[grant('reports:accounting-reports')]});
  assert.deepEqual(await availableReports(token),[]);
  await assert.rejects(requireReportAccess(token,'payroll-journals'),e=>e.status===403);
  await assert.rejects(availableReports(''),e=>e.status===401);
 }finally{invalidateRoleAccessCaches(token);}
});
test('new catalog reports default to denied and administrators see the complete catalog',async()=>{
 const token='Bearer report-new-test';
 const added={key:'future-example',title:'Future example',group:'operational',description:'Future example'};
 reportCatalog.push(added);
 try{
  await primeRoleAccessCache(token,{isAdmin:false,grants:[grant('reports:accounting-reports')]});
  assert.equal((await availableReports(token)).some(r=>r.key===added.key),false);
  await primeRoleAccessCache(token,{isAdmin:true,grants:[]});
  assert.equal((await availableReports(token)).length,reportCatalog.length);
 }finally{reportCatalog.pop();invalidateRoleAccessCaches(token);}
});
test('the real reports dashboard shows only permitted catalog entries',async t=>{
 const {page,baseURL}=await bankBrowserFixture(t);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>localStorage.setItem('nexo_token','synthetic-report-token'));
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  const payload=path==='/api/reports/catalog'?[reportCatalog.find(r=>r.key==='payroll-journals')]:{subsidiaries:[{id:1,name:'Synthetic company',currencyId:1}],currencies:[{id:1,code:'USD'}]};
  await route.fulfill({json:payload});
 });
 await page.goto(baseURL+'/accounting-reports.html');
 await page.locator('#operational .card').first().waitFor();
 assert.equal(await page.locator('#dashboard .card').count(),1);
 assert.match(await page.locator('#operational .card').innerText(),/Asientos de Nóminas/);
 assert.deepEqual(errors,[]);
});
test('database migration compiles real report wrappers, preserves grants, denies direct RPCs and contains nested report scope',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;
   create schema auth;create schema report_template_private;create schema report_delivery_private;create schema customer_payment_private;create schema fx_revaluation_private;create schema asset_posting_private;create schema asset_master_private;
   create function fx_revaluation_private.allowed(k text,a text)returns boolean language sql as $$select false$$;
   create function asset_posting_private.identity()returns bigint language sql as $$select 10::bigint$$;
   create function asset_master_private.fixed_asset_analytics(p jsonb)returns jsonb language sql as $$select '{"subsidiary":{"id":10},"assetOptions":[],"assets":[{"confidential":true}],"projection":[{"amount":100}],"movements":[{"amount":200}]}'::jsonb$$;
   create table public.asset(asset_id bigint,subsidiary_id bigint);
   create table public.fx_revaluation_runs(run_id bigint);
   create table public.fiscal_periods(fiscal_period_id bigint);
   create table report_delivery_private.receivable_discount_marks(invoice_id bigint);
   create table roles(role_id bigint primary key,role_name text);
   create table user_roles(user_id bigint,role_id bigint);
   create table role_access_matrix(role_id bigint,resource_key text,can_view boolean default false,can_create boolean default false,can_edit boolean default false,can_delete boolean default false,updated_by bigint,created_by_id text,created_by_email text,created_by_name text,actor_type text,actor_source text,execution_context_id text,primary key(role_id,resource_key));
   insert into roles values(1,'Administrator'),(2,'Payroll'),(3,'Existing reports'),(4,'Existing assets');
   insert into user_roles values(12,2);
   insert into role_access_matrix(role_id,resource_key,can_view)values(2,'reports:payroll-journals',true),(3,'reports:accounting-reports',true),(4,'fixed-assets:reports',true);
   create function auth.role() returns text language sql stable as $$select coalesce(nullif(current_setting('test.auth_role',true),''),'authenticated')$$;
   create function public.security_assert_role_access(k text,a text default 'view') returns void language plpgsql stable as $$begin
    if current_setting('test.role',true)='1' then return;end if;
    if not exists(select 1 from role_access_matrix where role_id=nullif(current_setting('test.role',true),'')::bigint and resource_key=k and can_view)then raise exception using errcode='42501',message='Denied';end if;end$$;
  `);
  await db.exec(await readFile(new URL('./report-role-permissions.sql',import.meta.url),'utf8'));
  assert.equal((await db.query("select count(*)::int n from role_access_matrix where role_id=3 and resource_key like 'reports:%' and resource_key<>'reports:accounting-reports'")).rows[0].n,reportCatalog.filter(r=>!r.key.startsWith('asset-')).length);
  assert.equal((await db.query("select count(*)::int n from role_access_matrix where role_id=4 and resource_key like 'reports:asset-%'")).rows[0].n,7);
  await db.exec("set test.role='2'");
  for(const call of ["run_accounting_report('balance-sheet')","run_aging_report('AR')","run_general_ledger_export()","run_classified_receivables_report()","run_vat_declaration_report()","run_customer_payment_fee_report()","fixed_asset_analytics('{\"reportKey\":\"projection\"}')"]){
   await assert.rejects(db.query('select public.'+call),e=>e.code==='42501',call);
  }
  await db.exec(`create function report_access_private.test_nested()returns jsonb language plpgsql stable as $$begin
   perform report_access_private.enter('payroll-journals');
   perform report_access_private.enter('receivables-aging');return '{}'::jsonb;end$$;`);
  await db.query('select report_access_private.test_nested()');
  await assert.rejects(db.query("select report_access_private.enter('receivables-aging')"),e=>e.code==='42501');
  await db.exec("insert into role_access_matrix(role_id,resource_key,can_view)values(2,'reports:asset-projection',true)");
  const assets=(await db.query("select fixed_asset_analytics('{\"reportKey\":\"projection\"}') payload")).rows[0].payload;
  assert.deepEqual(Object.keys(assets).sort(),['assetOptions','projection','subsidiary']);
  assert.equal(assets.projection[0].amount,100);
  await assert.rejects(db.query("select fixed_asset_analytics('{}')"),e=>e.code==='42501');
  assert.equal((await db.query("select has_function_privilege('authenticated','report_access_private.enter(text)','execute') allowed")).rows[0].allowed,false);
  await db.exec("set test.auth_role='service_role'");
  await assert.rejects(db.query("select report_access_private.delivery('receivables-aging',12)"),e=>e.code==='42501');
  await db.query("select report_access_private.delivery('payroll-journals',12)");
 }finally{await db.close();}
});
