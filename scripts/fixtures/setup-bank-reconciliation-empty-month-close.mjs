import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {setupBankReconciliationDraftDelete} from './setup-bank-reconciliation-draft-delete.mjs';
export {assumeSecurityUser,assumeSqlRole,deniedSql,authId,authSession,hash} from './isolated-bank-statement-security.mjs';

const read=name=>readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8').then(source=>source.replace(/\r\n/g,'\n'));
export const emptyBankMonthCloseMigration='20261109161132_close_verified_empty_bank_months.sql';
export async function applyBankReconciliationEmptyMonthClose(db){
 await db.exec('reset role;begin');try{await db.exec(await read(emptyBankMonthCloseMigration));await db.exec('commit');}catch(error){await db.exec('rollback');delete error.query;throw error;}
}
function definition(source,name){
 const escaped=name.replaceAll('.','\\.');const result=source.match(new RegExp('create(?: or replace)? function '+escaped+'\\([\\s\\S]*?\\$\\$[\\s\\S]*?\\$\\$;','i'))?.[0];
 assert.ok(result,'Missing published function '+name);return result;
}
const currentBodies={
 'reconciliation_private.ensure_open_bank_reconciliation(bigint,date)':'0ef6b20e15bd7577b1bfb8eae988a5de',
 'reconciliation_private.auto_match_bank_reconciliation(bigint,date)':'36adbeb1acb624d480fd00227152ecb3',
 'reconciliation_private.close_bank_reconciliation(bigint,date,numeric)':'d9b0ed5ad9f7d69a6b789680de2020cd',
 'public.auto_match_bank_reconciliation(bigint,date)':'8feb2a399473c43e8cc4a128c65f5dbf',
 'public.close_bank_reconciliation(bigint,date,numeric)':'74fcd8e12ab9f25143121060f7764a09'
};

/** Real current A06/session/device, audited header, protected sources and close
 * engines. The inherited synthetic report is replaced by its published actual
 * definition. No production captures, business calls or external files are used.
 */
export async function setupBankReconciliationEmptyMonthClose({apply=true}={}){
 const fixture=await setupBankReconciliationDraftDelete();const {db,abaDraft}=fixture;
 try{
  await db.exec('reset role');
  // Remove only the inherited synthetic ABA test record; each new case seeds
  // its own bank/period baseline and all actor/audit triggers stay enabled.
  await db.query('delete from bank_reconciliation where reconciliation_id=$1',[abaDraft.reconciliationId]);
  await db.exec(`
   update role_access_matrix set can_edit=true where role_id=1 and resource_key='banking:bank-reconciliations';
   alter table bank_transaction add column if not exists beneficiary text,add column if not exists is_opening_balance boolean default false;
   alter table "transaction"add column if not exists customer_id bigint,add column if not exists supplier_id bigint;
   alter table transaction_types add column if not exists name text;
   alter table journal_line add column if not exists employee_id bigint;
   create table if not exists customers(customer_id bigint primary key,company_name text);
   alter table customers add column if not exists company_name text;
   create table if not exists suppliers(supplier_id bigint primary key,company_name text);
   alter table suppliers add column if not exists company_name text;
   create table if not exists employees(employee_id bigint primary key,first_name text,last_name text);
   alter table employees add column if not exists first_name text,add column if not exists last_name text;
   insert into fiscal_periods(fiscal_period_id,subsidiary_id,start_date,end_date,is_closed,is_inactive,period_name)values
    (9,1,'2026-09-01','2026-09-30',false,false,'Synthetic September 2026'),
    (12,1,'2026-12-01','2026-12-31',false,false,'Synthetic December 2026'),
    (22,2,'2026-10-01','2026-10-31',false,false,'Synthetic foreign October 2026');
  `);
  const period=await read('20260916160000_reuse_bank_reconciliation_period.sql'),opening=await read('20261021100000_opening_bank_auxiliary.sql'),secure=await read('20261031125441_secure_bank_reconciliation.sql');
  const names=['ensure_open_bank_reconciliation','auto_match_bank_reconciliation','close_bank_reconciliation','run_bank_reconciliation_report'];
  for(const name of names){
   let body=definition(name==='ensure_open_bank_reconciliation'?period:opening,'public.'+name);
   for(const target of names)body=body.replaceAll('public.'+target+'(','reconciliation_private.'+target+'(');
   body=body.replace('set search_path=public,pg_temp','set search_path=pg_catalog,public,pg_temp');
   if(name==='ensure_open_bank_reconciliation')body=body.replace(/\bbegin\b/i,'begin perform reconciliation_private.bank_scope(p_bank_account_id,p_cutoff,true);');
   if(name==='auto_match_bank_reconciliation'){
    const needle=' loop\n  insert into public.bank_reconciliation_match';assert.equal(body.split(needle).length,2);
    body=body.replace(needle,' loop\n  if not exists(select 1 from public.bank_transaction b where b.bank_tran_id=r.bank_tran_id and b.reconciliation_status=\'PENDIENTE_EN_TRANSITO\') or not exists(select 1 from public.bank_statement_line l where l.statement_line_id=r.statement_line_id and l.reconciliation_status=\'PENDIENTE\') then continue;end if;perform reconciliation_private.check_match(r.bank_tran_id,r.statement_line_id,p_cutoff);\n  insert into public.bank_reconciliation_match');
   }
   if(name==='run_bank_reconciliation_report'){
    const needle='where bt.bank_account_id=account_key and bt.tran_type';assert.equal(body.split(needle).length,2);
    body=body.replace(needle,'where bt.bank_account_id=account_key and (bt.transaction_id is null or t.subsidiary_id=public.active_subsidiary_id()) and (j.journal_id is null or j.subsidiary_id=public.active_subsidiary_id()) and bt.tran_type');
   }
   await db.exec(body);
  }
  await db.exec(definition(secure,'reconciliation_private.check_match'));
  // The exact public-wrapper generator/guards from C04, restricted to the two
  // unchanged engines needed by these cases. It preserves original arguments.
  await db.exec(`do $$declare spec record;p record;body text;
  begin
   for spec in select *from(values
    ('auto_match_bank_reconciliation(bigint,date)','perform reconciliation_private.access(''banking:bank-reconciliations'',''edit'');perform reconciliation_private.bank_scope(p_bank_account_id,p_cutoff,true);'),
    ('close_bank_reconciliation(bigint,date,numeric)','perform reconciliation_private.access(''banking:bank-reconciliations'',''edit'');perform reconciliation_private.bank_scope(p_bank_account_id,p_cutoff,true);if not reconciliation_private.finite(p_bank_adjustments) then raise exception using errcode=''22023'',message=''Ajuste inválido.'';end if;'))as registry(signature,guard)loop
    select pr.*,pg_get_function_arguments(pr.oid)args,pg_get_function_result(pr.oid)result into p from pg_proc pr where pr.oid=('reconciliation_private.'||spec.signature)::regprocedure;
    body:='begin '||spec.guard||' return reconciliation_private.'||p.proname||'('||coalesce(array_to_string(p.proargnames,','),'')||');end';
    execute format('create or replace function public.%I(%s)returns %s language plpgsql volatile security definer set search_path=pg_catalog,public,pg_temp as %L',p.proname,p.args,p.result,body);
    execute format('revoke all on function public.%s from public,anon,authenticated,service_role',spec.signature);execute format('grant execute on function public.%s to authenticated',spec.signature);
   end loop;
  end$$;
  revoke all on function reconciliation_private.ensure_open_bank_reconciliation(bigint,date),reconciliation_private.auto_match_bank_reconciliation(bigint,date),reconciliation_private.close_bank_reconciliation(bigint,date,numeric),reconciliation_private.run_bank_reconciliation_report(jsonb),reconciliation_private.check_match(bigint,bigint,date)from public,anon,authenticated,service_role;`);
  for(const[signature,expected]of Object.entries(currentBodies)){const actual=(await db.query('select md5(prosrc)md5 from pg_proc where oid=$1::regprocedure',[signature])).rows[0].md5;assert.equal(actual,expected,'Reviewed current body '+signature);}
  if(apply)await applyBankReconciliationEmptyMonthClose(db);
  return{...fixture,currentBodies};
 }catch(error){await db.close();throw error;}
}

export async function seedEmptyMonthBaseline(db,{bank=2,amount=5399.02,date='2026-09-30',withStatement=true}={}){
 await db.exec('reset role');
 const transactionId=(await db.query("insert into bank_transaction(bank_account_id,tran_date,value_date,amount,tran_type,reference_number,reconciliation_status,is_opening_balance)values($1,$2,$2,$3,'SALDO_INICIAL','SYNTHETIC-EMPTY-MONTH-OPENING','CONCILIADO',true)returning bank_tran_id",[bank,date,amount])).rows[0].bank_tran_id;
 const statementId=withStatement?(await db.query("insert into bank_statement(statement_date,bank_account_id,opening_balance,closing_balance,source_file_name)values($1,$2,$3,$3,'synthetic-empty-month-prior.csv')returning statement_id",[date,bank,amount])).rows[0].statement_id:null;
 return{bank,date,amount,transactionId,statementId};
}
