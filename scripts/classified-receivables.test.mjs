import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {receivableBlock,receivableCells,currencyGroups} from '../dist/modules/reports/classified-receivables.service.js';

test('discount priority, currency isolation and preserved balances',()=>{
 const rows=[{document_id:1,discounted:true,intercompany:true,currency_code:'USD',original_amount:100,applied_amount:20,pending:80,bucket:'1_30'},{document_id:2,intercompany:true,currency_code:'JMD',pending:1000},{document_id:3,currency_code:'USD',pending:15}];
 const blocks=currencyGroups({rows},{agingCurrencyMode:'ORIGINAL'},{});
 assert.deepEqual(blocks.map(b=>b.groups.flatMap(g=>g.rows.map(r=>r.document_id))),[[3],[2],[1]]);
 assert.equal(receivableBlock(rows[0]),'DISCOUNTED');assert.equal(receivableBlock({...rows[0],discounted:false}),'INTERCOMPANY');
 assert.deepEqual(receivableCells(rows[0]).slice(5,10),[100,20,80,0,80]);
 assert.deepEqual(blocks.map(b=>b.groups.map(g=>g.currency)),[['USD'],['JMD'],['USD']]);
});

test('SQL marks persist across monthly queries, can be undone, audited and protected from unauthorized writes',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create schema report_delivery_private;create schema report_template_private;
 create table users(user_id bigint primary key);insert into users values(1);
 create table user_subsidiaries(user_id bigint,subsidiary_id bigint);insert into user_subsidiaries values(1,10);
 create function app_user_id()returns bigint language sql stable as $$select nullif(current_setting('test.uid',true),'')::bigint$$;
 create function report_template_private.enter(text,text)returns bigint language plpgsql as $$begin if public.app_user_id()is null or current_setting('test.allowed',true)<>'yes' then raise exception using errcode='42501',message='denied';end if;return 10;end$$;
 create table customers(customer_id bigint primary key,is_intercompany boolean);insert into customers values(1,true),(2,false);
 create table chart_accounts(account_id bigint primary key,account_number text);insert into chart_accounts values(1,'113002'),(2,'113001');
 create table invoice(invoice_id bigint primary key,customer_id bigint,subsidiary_id bigint,receivable_account_id bigint);
 insert into invoice values(1,1,10,1),(2,2,10,2),(3,2,20,2);
 create function run_aging_report(text,jsonb)returns jsonb language sql as $$select jsonb_build_object('rows','[{"document_id":1,"pending":80},{"document_id":2,"pending":20}]'::jsonb,'total',2,'summary','{"subledger":100}'::jsonb)$$;
 grant usage on schema public to authenticated,anon;
 `);
 await db.exec(await readFile(new URL('../supabase/migrations/20261112210026_receivables_classified_report.sql',import.meta.url),'utf8'));
 const call=(sql,args=[])=>db.query(sql,args).then(r=>r.rows[0]?.d);
 await db.exec("set role authenticated;select set_config('test.uid','1',false),set_config('test.allowed','yes',false)");
 const run=month=>call('select run_classified_receivables_report($1)d',[{dateTo:month}]);
 const before=await run('2026-10-31');assert.equal(before.rows[0].discounted,false);assert.equal(before.rows[0].intercompany,true);
 await call('select set_receivable_discount_mark(1,true,false)d');
 for(const month of ['2026-10-31','2026-11-30','2026-12-31']){const result=await run(month);assert.equal(result.rows[0].discounted,true);assert.deepEqual(result.summary,before.summary);assert.equal(result.rows[0].pending,80);}
 await assert.rejects(call('select set_receivable_discount_mark(1,false,false)d'),/Otro usuario/);
 await assert.rejects(call('select set_receivable_discount_mark(3,true,false)d'),/subsidiarias autorizadas/);
 await assert.rejects(call('select * from report_delivery_private.receivable_discount_marks'),/permission denied/);
 await call('select set_receivable_discount_mark(1,false,true)d');assert.equal((await run('2026-12-31')).rows[0].discounted,false);
 await db.exec("select set_config('test.allowed','no',false)");await assert.rejects(run('2026-12-31'),/denied/);await assert.rejects(call('select set_receivable_discount_mark(1,true,false)d'),/denied/);
 await db.exec('reset role;set role anon');await assert.rejects(run('2026-12-31'),/permission denied/);await assert.rejects(call('select set_receivable_discount_mark(1,true,false)d'),/permission denied/);
 await db.exec('reset role');assert.equal(await call('select count(*)::int d from report_delivery_private.receivable_discount_history'),2);
 const policies=await db.query("select relrowsecurity from pg_class where oid in ('report_delivery_private.receivable_discount_marks'::regclass,'report_delivery_private.receivable_discount_history'::regclass)");assert.ok(policies.rows.every(r=>r.relrowsecurity));
 }finally{await db.close();}
});
