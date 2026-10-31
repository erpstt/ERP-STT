import {readFile,readdir} from 'node:fs/promises';import {setupSupplierPaymentSecurity} from './setup-supplier-payment-security.mjs';
export async function setupPaymentRequestSecurity(db){
 const exec=async sql=>{try{return await db.exec(sql);}catch(error){throw new Error(sql.slice(Math.max(0,Number(error.position)-100),Number(error.position)+100)+': '+error.message+' position '+error.position,{cause:error});}};
 await setupSupplierPaymentSecurity(db);
 const treasury=(await db.query("select pg_get_functiondef('public.pr_execute_without_budget(jsonb)'::regprocedure) d")).rows[0].d;
 const wf=await readFile(new URL('../../supabase/migrations/20260910100000_generic_approval_workflow.sql',import.meta.url),'utf8');await exec(wf.slice(0,wf.indexOf('create index')));
 await exec(`alter table subsidiaries add column if not exists administrative_approver text,add column if not exists default_up_approver_id bigint,add column if not exists tax_supervisor_user_id bigint,add column if not exists country_id bigint default 1;
 alter table suppliers add column if not exists primary_subsidiary_id bigint,add column if not exists tax_id text;
 alter table customers add column if not exists primary_subsidiary_id bigint,add column if not exists is_inactive boolean default false;
 alter table chart_accounts add column payment_request_enabled boolean default false;
 alter table account_group add column if not exists group_code text;
 alter table cost_centers add column if not exists department_id bigint,add column if not exists cost_center_type text,add column if not exists up_approver_id bigint,add column if not exists code text;
 alter table employees add column if not exists is_active boolean default true,add column if not exists user_id bigint;
 create table cashbox(account_id bigint);
 create function expense_approval_email_enqueue(bigint,bigint,bigint) returns void language sql as $$select$$;
 create table tax_agencies(tax_agency_id bigint primary key,agency_name text,country_id bigint,tax_id text);create table tax_agency_subsidiaries(tax_agency_id bigint,subsidiary_id bigint);
 alter table solicitudes_pago alter column estado set default 'BORRADOR',alter column version set default 1,alter column fecha_solicitud set default current_date;
 alter table solicitudes_pago_eventos add column id bigint generated always as identity primary key,add column fecha timestamptz default now();
 update roles set role_name='Tesorería' where role_id=2;update users set email='synthetic-'||user_id||'@example.invalid';update chart_accounts set payment_request_enabled=true where account_id=203;
 update subsidiaries set administrative_approver='user:2' where subsidiary_id=1;
 insert into transaction_types values(13,'SOL_PAG','Solicitud de pago');
 insert into tax_agencies values(1,'Synthetic agency',1,'SYN');insert into tax_agency_subsidiaries values(1,1);`);
 const supports=await readFile(new URL('../../supabase/migrations/20260913150000_payment_request_supports.sql',import.meta.url),'utf8');await exec(supports.slice(0,supports.indexOf('create index')));
 await exec('alter table solicitudes_pago_respaldos add column created_by_name text,add column created_by_email text');
 const names=new Set(['sync_journal_gl_impacts_trigger','pr_options','pr_invoices','pr_report','pr_detail','pr_save','pr_save_without_budget','pr_submit','pr_transition','pr_execute','pr_execute_without_payment_batch_guard','pr_execute_without_budget','pr_supports','pr_support_save','pr_support_delete','pr_validate','pr_invoice_balance','pr_allowed_account','pr_resolve_payment_request_approver','pr_payment_request_admin_route','pr_resolve_up_approver','pr_can_approve','pr_can_execute','payment_request_report_options','run_payment_request_report','wf_start_entity_without_budget','wf_start_entity','wf_apply_entity_status_without_budget','wf_apply_entity_status','wf_entity_data_without_budget','wf_entity_data','wf_act','wf_instance_detail','wf_inbox','wf_notify_level','wf_bulk_approve','pr_sync_dynamic_current_approver']);
 await exec('drop function if exists public.pr_save(jsonb);drop function if exists public.pr_save_without_budget(jsonb);drop function if exists public.wf_start_entity_without_budget(text,bigint,jsonb);drop function if exists public.pr_execute_without_budget(jsonb)');
 const dir=new URL('../../supabase/migrations/',import.meta.url);for(const file of (await readdir(dir)).sort()){
  if(!file.endsWith('.sql')||file>'20261030235959.sql')continue;const sql=await readFile(new URL(file,dir),'utf8'),events=[];
  for(const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)\s*\([\s\S]*?\$\$[\s\S]*?\$\$\s*;/gi))if(names.has(m[1]))events.push({index:m.index,sql:m[0]});
  for(const m of sql.matchAll(/alter\s+function\s+(?:public\.)?([a-z0-9_]+)\s*(\([^;]+?\))\s*rename\s+to\s+([a-z0-9_]+)\s*;/gi))if(names.has(m[1])&&names.has(m[3]))events.push({index:m.index,sql:m[0],from:m[1]+m[2],to:m[3]+m[2]});
  if(file==='20261027120000_payment_request_line_dimensions.sql'){
   const start=sql.indexOf('do $migration$'),stop=sql.search(/  definition:=pg_get_functiondef\(\s*'public\.expense_approval_email_snapshot/);
   if(start<0||stop<start)throw Error('Missing original dimension definition patch');
   events.push({index:start,sql:sql.slice(start,stop)+'end\n$migration$;'});
  }
  for(const e of events.sort((a,b)=>a.index-b.index)){if(e.from){const r=(await db.query('select to_regprocedure($1) a,to_regprocedure($2) b',[e.from,e.to])).rows[0];if(!r.a||r.b)continue;}try{await exec(e.sql);}catch(error){throw new Error(file+': '+e.sql.slice(0,100)+': '+error.message,{cause:error});}}
 }
 // Restore the real deployed Treasury body already patched by supplier payment security.
 await exec(treasury);
 // Real bank-check/transfer writer used by the OTROS Treasury branch.
 await exec(`create schema bank_check_private;create table bank_check(check_id bigint generated always as identity primary key,check_number text,bank_account_id bigint,supplier_id bigint,amount numeric,status text);
 alter table transaction_types add column if not exists module_category text,add column if not exists description text;insert into transaction_types(transaction_type_id,abbreviation,name) values(14,'CHQ_TRF','Synthetic check');`);
 for(const [table,key]of [['customers','customer_id'],['employees','employee_id']])if(!(await db.query("select 1 from pg_constraint where conrelid=$1::regclass and contype='p'",[table])).rows.length)await exec(`alter table ${table} add primary key(${key})`);
 const check=await readFile(new URL('../../supabase/migrations/20260903100000_bank_checks_transfers_transaction.sql',import.meta.url),'utf8');await exec(check.slice(0,check.indexOf('create or replace function bank_check_options')));
 for(const name of ['20260903100000_bank_checks_transfers_transaction.sql','20260903110000_bank_check_periods.sql']){const text=await readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8');for(const m of text.matchAll(/create or replace function (?:public\.)?save_bank_check_transfer\([\s\S]*?\$\$[\s\S]*?\$\$;/gi))await exec(m[0]);}
 await exec('alter function save_bank_check_transfer(jsonb,bigint) set schema bank_check_private;alter function bank_check_private.save_bank_check_transfer(jsonb,bigint) rename to save_bank_check_transfer_without_tax_agency;alter table bank_check_line add column tax_agency_id bigint;alter table journal_line add column tax_agency_id bigint');
 const tax=await readFile(new URL('../../supabase/migrations/20261027090000_tax_agency_payment_requests.sql',import.meta.url),'utf8');const wrapper=tax.match(/create or replace function public\.save_bank_check_transfer\([\s\S]*?\$\$[\s\S]*?\$\$;/i)?.[0];if(!wrapper)throw Error('Missing real bank writer');await exec(wrapper.replaceAll('public.save_bank_check_transfer','bank_check_private.save_bank_check_transfer'));
 // Unrelated configuration/report infrastructure is represented synthetically, never connected remotely.
 await exec(`create table payment_batches(batch_id bigint primary key,subsidiary_id bigint,status text,bank_account_id bigint,currency_id bigint,execution_date date,exchange_rate numeric);
 alter table payment_batch_items add column batch_id bigint,add column payment_request_id bigint,add column supplier_id bigint,add column currency_id bigint,add column application_amount numeric,add column processing_status text;
 create function payment_batch_has_permission(text) returns boolean language sql stable as $$select false$$;
 create trigger request_dynamic_approver after update on wf_instances for each row execute function pr_sync_dynamic_current_approver();
 create trigger journal_line_gl_impact_sync after insert or delete or update on journal_line for each row execute function sync_journal_gl_impacts_trigger();`);
 for(const [role,view,create,edit,del]of [[1,true,true,true,true],[2,true,false,true,false],[3,true,false,false,false],[4,true,false,false,false]])await db.query("insert into role_access_matrix values($1,'treasury:payment-requests',$2,$3,$4,$5)",[role,view,create,edit,del]);
 await exec('begin');await exec(await readFile(new URL('../../supabase/migrations/20261031181041_secure_payment_requests.sql',import.meta.url),'utf8'));await exec('commit');
}
