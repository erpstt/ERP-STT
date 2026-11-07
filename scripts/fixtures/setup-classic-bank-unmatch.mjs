import {readFile} from 'node:fs/promises';
import {setupBankStatementContinuity} from './setup-bank-statement-continuity.mjs';
import {functionsIn} from './setup-audit-raw-security.mjs';
export {assumeSecurityUser,assumeSqlRole,deniedSql} from './isolated-bank-statement-security.mjs';
export const classicBankUnmatchMigration='20261107201345_allow_controlled_classic_bank_unmatch.sql';
const read=name=>readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8').then(s=>s.replace(/\r\n/g,'\n'));
async function install(db,file,names){const functions=functionsIn(await read(file));for(const name of names){const found=functions.filter(f=>f.name===name);if(found.length!==1)throw Error('Expected real audit definition '+name);await db.exec(found[0].sql);}}
export async function applyClassicBankUnmatch(db){
 await db.exec('begin');try{await db.exec(await read(classicBankUnmatchMigration));await db.exec('commit');}catch(error){await db.exec('rollback');throw error;}
}
export async function setupClassicBankUnmatch({apply=true}={}){
 const {db,manifest}=await setupBankStatementContinuity();
 try{
  const enhancement=await read('20260829150000_enhance_bank_reconciliation.sql');
  const recColumns=enhancement.match(/alter table public\.bank_reconciliation add column[\s\S]*?;/)?.[0];
  if(!recColumns)throw Error('Missing published reconciliation header columns');await db.exec(recColumns);
  await db.exec(`alter table auth.users add column raw_app_meta_data jsonb default '{"actor_type":"HUMAN","actor_source":"Synthetic classic-unmatch test"}';
   alter table activity_log add column activity_id bigint generated always as identity primary key;
   alter table activity_log add column if not exists "timestamp" timestamptz not null default now();`);
  const ddl=await read('20260807080000_create_audit_catalogs.sql');await db.exec(ddl.slice(0,ddl.indexOf('\ndo $$')));
  const central=await read('20260826160000_enable_central_auditing.sql');await db.exec(central.slice(0,central.indexOf('create or replace function')));
  await install(db,'20260826160000_enable_central_auditing.sql',['audit_request_ip','audit_primary_key','install_audit_trigger']);
  await install(db,'20260913090000_actor_audit_engine.sql',['resolve_audit_actor','stamp_actor_audit','reject_audit_mutation','reject_audit_truncate','install_actor_audit']);
  await install(db,'20260929110000_gentia_brand_refresh.sql',['resolve_audit_actor']);
  await install(db,'20261026113000_redact_audit_secrets.sql',['audit_field_is_sensitive','audit_redact_jsonb','audit_redact_json_text','capture_row_audit','record_system_event']);
  // Use the deployed audit engine, current trusted actor and source trigger;
  // no simulation of financial writes, record snapshots or role decisions.
  for(const table of ['audit_log','change_log','event_log','activity_log','deleted_records','bank_transaction','bank_statement_line','bank_reconciliation_match'])await db.query('select install_actor_audit($1::regclass)',[table]);
  await db.exec(`create trigger security_reconciliation_sources before insert or update or delete on bank_transaction for each row execute function reconciliation_private.protect_sources();
   revoke all on function public.record_system_event(text,text,text,text,jsonb),public.capture_row_audit(),public.resolve_audit_actor()from public,anon,authenticated,service_role;
   grant execute on function public.record_system_event(text,text,text,text,jsonb)to service_role;
   insert into role_access_matrix(role_id,resource_key,can_view,can_create,can_edit,can_delete)values
   (1,'banking:bank-reconciliations',true,false,true,false),(2,'banking:bank-reconciliations',true,false,true,false),
   (3,'banking:bank-reconciliations',true,false,false,false),(4,'banking:bank-reconciliations',false,false,true,false);`);
  const template=await read('20261103032056_secure_financial_reports_pdf_templates.sql');
  const enter=template.match(/create function report_template_private\.enter\([\s\S]*?end\$\$;/)?.[0];
  if(!enter)throw Error('Missing real financial report template guard');
  await db.exec('create schema report_template_private;revoke all on schema report_template_private from public,anon,authenticated,service_role;'+enter);
  await db.exec(`revoke all on function report_template_private.enter(text,text)from public,anon,authenticated,service_role;
   -- The untouched legacy report engine is outside this narrow projection
   -- fixture. This explicitly SYNTHETIC read-only source keeps guards, real
   -- table rows, ordering and financial data observable without fake writers.
   create function reconciliation_private.run_bank_reconciliation_report(p_filters jsonb default '{}'::jsonb)returns jsonb language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
    select jsonb_build_object('rows',coalesce((select jsonb_agg(jsonb_build_object('id',b.bank_tran_id,'date',b.tran_date,'reconciliation_status',b.reconciliation_status,'reference',b.reference_number,'deposits',greatest(b.amount,0),'withdrawals',greatest(-b.amount,0))order by b.bank_tran_id desc)from bank_transaction b where b.bank_account_id=(p_filters->>'bankAccountId')::bigint),'[]'::jsonb),
     'statementLines',coalesce((select jsonb_agg(to_jsonb(l)order by l.statement_line_id)from bank_statement_line l join bank_statement s using(statement_id)where s.bank_account_id=(p_filters->>'bankAccountId')::bigint),'[]'::jsonb),
     'summary',jsonb_build_object('syntheticControl',true,'bookBalance',(select sum(amount)from bank_transaction where bank_account_id=(p_filters->>'bankAccountId')::bigint)),
     'total',(select count(*)from bank_transaction where bank_account_id=(p_filters->>'bankAccountId')::bigint),'page',1,'pageSize',50)
   $$;revoke all on function reconciliation_private.run_bank_reconciliation_report(jsonb)from public,anon,authenticated,service_role;`);
  // Exact deployed public definition captured in the production RO preflight;
  // the migration guard checks its complete pg_get_functiondef MD5.
  await db.exec("CREATE OR REPLACE FUNCTION public.run_bank_reconciliation_report(p_filters jsonb DEFAULT '{}'::jsonb)\n RETURNS jsonb\n LANGUAGE plpgsql\n STABLE SECURITY DEFINER\n SET search_path TO 'pg_catalog', 'public', 'pg_temp'\nAS $function$begin perform report_template_private.enter('reports:accounting-reports','view');\nbegin perform reconciliation_private.access('reports:accounting-reports','view');perform reconciliation_private.bank_scope(nullif(p_filters->>'bankAccountId','')::bigint); return reconciliation_private.run_bank_reconciliation_report(p_filters);end;\nend$function$\n");
  await db.exec('revoke all on function public.run_bank_reconciliation_report(jsonb)from public,anon,authenticated,service_role;grant execute on function public.run_bank_reconciliation_report(jsonb)to authenticated');
  if(apply)await applyClassicBankUnmatch(db);
  return {db,manifest};
 }catch(error){await db.close();throw error;}
}
export async function seedClassicMatch(db,{bank=1,statement=1,date='2026-10-31',amount=25,lineId=null,period=10}={}){
 await db.exec('reset role');
 if(lineId===null)lineId=(await db.query('select statement_line_id from bank_statement_line where statement_id=$1 order by statement_line_id limit 1',[statement])).rows[0].statement_line_id;
 const rec=(await db.query("insert into bank_reconciliation(reconciliation_date,bank_account_id,fiscal_period_id,status)values($1,$2,$3,'ABIERTA')returning reconciliation_id",[date,bank,period])).rows[0].reconciliation_id;
 const book=(await db.query("insert into bank_transaction(bank_account_id,tran_date,value_date,amount,tran_type,reference_number,reconciliation_status)values($1,'2026-10-15','2026-10-18',$2,'SYNTHETIC','SYNTHETIC-CLASSIC-UNMATCH','CONCILIADO')returning bank_tran_id",[bank,amount])).rows[0].bank_tran_id;
 await db.query("update bank_statement_line set reconciliation_status='CONCILIADO'where statement_line_id=$1",[lineId]);
 const match=(await db.query("insert into bank_reconciliation_match(reconciliation_id,bank_tran_id,statement_line_id,match_type,matched_by)values($1,$2,$3,'MANUAL',1)returning match_id",[rec,book,lineId])).rows[0].match_id;
 return {bank,statement,cutoff:date,reconciliation:rec,book,line:lineId,match};
}
