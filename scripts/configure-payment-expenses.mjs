import pg from 'pg';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
await db.connect();
const value=async(sql,args=[]) => (await db.query(sql,args)).rows[0]?.value;
try{
 await db.query('begin');await db.query("set local lock_timeout='5s';set local statement_timeout='90s'");
 const context=(await db.query('select u.email,ucs.session_id,au.id sub from user_company_sessions ucs join users u using(user_id)join auth.users au on lower(au.email)=lower(u.email)order by selected_at desc limit 1')).rows[0];
 await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(context)]);
 const before=await value("select coalesce(jsonb_agg(account_id order by account_id),'[]')value from chart_accounts where category in('Activo','Pasivo')and pr_allowed_account(account_id)");
 await db.query(await readFile(new URL('../supabase/migrations/20260921140000_payment_request_selected_expenses.sql',import.meta.url),'utf8'));
 const enabled=await value("select jsonb_agg(account_number order by account_number)value from chart_accounts where category in('Costo','Gasto')and pr_allowed_account(account_id)");
 assert.deepEqual(enabled,['614014','614015','622005']);
 assert.deepEqual(await value("select coalesce(jsonb_agg(account_id order by account_id),'[]')value from chart_accounts where category in('Activo','Pasivo')and pr_allowed_account(account_id)"),before);
 const parent=await value("select group_id value from account_group where group_code='610'and category='Gasto'and level=2");assert.ok(parent);
 assert.equal(await value("select count(*)::int value from account_group where group_code='615'"),0);
 const group=await value("insert into account_group(group_code,group_name,level,parent_id,nature,financial_statement,category)values('615','Gastos no deducibles',3,$1,'Deudora','Estado de Resultados','Gasto')returning group_id value",[parent]);
 const account=await value("insert into chart_accounts(account_number,account_name,account_type,account_group_id,level,nature,financial_statement,category,accepts_entries)values('615001','Gastos no deducibles','Gasto',$1,4,'Deudora','Estado de Resultados','Gasto',true)returning to_jsonb(chart_accounts)value",[group]);
 assert.equal(account.account_number,'615001');
 await db.query('insert into account_subsidiaries(account_id,subsidiary_id)values($1,active_subsidiary_id())',[account.account_id]);
 assert.equal(await value('select pr_allowed_account($1)value',[account.account_id]),false);
 // Exercise save through the budget wrapper; discard these fixtures even during activation.
 await db.query('savepoint fixtures');
 const opts=await value('select pr_options()value');
 const supplier=await value("select supplier_id value from suppliers where primary_subsidiary_id=active_subsidiary_id()limit 1");
 const currency=await value('select currency_id value from subsidiaries where subsidiary_id=active_subsidiary_id()');
 for(const code of enabled){
  const id=await value('select account_id value from chart_accounts where account_number=$1',[code]);
  const result=await value('select pr_save($1)value',[JSON.stringify({type:'OTROS',plannedDate:'2026-09-21',currencyId:currency,concept:'Validacion temporal de cuenta autorizada',lines:[{accountId:id,entityType:'Proveedor',entityId:supplier,concept:'Validacion temporal',amount:1}]})]);assert.ok(result.id);
 }
 const excluded=await value("select account_id value from chart_accounts a join account_subsidiaries s using(account_id)where s.subsidiary_id=active_subsidiary_id()and a.category='Gasto'and not a.payment_request_enabled and not a.is_inactive and s.is_active limit 1");
 await db.query('savepoint rejected');
 await assert.rejects(value('select pr_save($1)value',[JSON.stringify({type:'OTROS',plannedDate:'2026-09-21',currencyId:currency,concept:'Validacion temporal cuenta no autorizada',lines:[{accountId:excluded,entityType:'Proveedor',entityId:supplier,concept:'Validacion temporal',amount:1}]})]),/no habilitada/);
 await db.query('rollback to savepoint rejected');await db.query('rollback to savepoint fixtures');
 const apply=process.argv.includes('--apply');await db.query(apply?'commit':'rollback');
 console.log(JSON.stringify({applied:apply,enabled,group:'615',account:'615001',existingAssetLiabilityRulesPreserved:true,saveAllowed:true,unlistedRejected:true,testRequestsRolledBack:true}));
}catch(e){await db.query('rollback').catch(()=>{});throw e;}finally{await db.end();}
