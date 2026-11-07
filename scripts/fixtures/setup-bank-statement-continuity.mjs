import {readFile} from 'node:fs/promises';
import {isolatedBankStatementDatabase} from './isolated-bank-statement-security.mjs';
export {assumeSecurityUser,assumeSqlRole,beginIsolatedCase,deniedSql} from './isolated-bank-statement-security.mjs';
export const bankStatementContinuityMigration='20261107182859_enforce_bank_statement_monthly_continuity.sql';
const read=name=>readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8').then(s=>s.replace(/\r\n/g,'\n'));
function definition(sql,name){
 const escaped=name.replaceAll('.','\\.');
 const match=sql.match(new RegExp('create(?: or replace)? function '+escaped+'\\([\\s\\S]*?\\$\\$[\\s\\S]*?\\$\\$;','i'));
 if(!match)throw Error('Missing reviewed function: '+name);return match[0];
}
export async function applyBankStatementContinuity(db){
 await db.exec('begin');try{await db.exec(await read(bankStatementContinuityMigration));await db.exec('commit');}catch(error){await db.exec('rollback');throw error;}
}
export async function setupBankStatementContinuity({apply=true}={}){
 const {db,manifest}=await isolatedBankStatementDatabase();
 try{
  const secure=await read('20261031125441_secure_bank_reconciliation.sql');
  for(const name of ['reconciliation_private.before_import','reconciliation_private.protect_sources'])await db.exec(definition(secure,name));
  const legacy=await read('20260829150000_enhance_bank_reconciliation.sql');
  await db.exec(definition(legacy,'public.import_bank_statement').replace('public.import_bank_statement(','reconciliation_private.import_bank_statement('));
  await db.exec('alter function reconciliation_private.import_bank_statement(bigint,date,numeric,numeric,text,jsonb) set search_path=pg_catalog,public,pg_temp');
  // Actual deployed wrapper captured by the read-only production preflight.
  await db.exec("CREATE OR REPLACE FUNCTION public.import_bank_statement(p_bank_account_id bigint, p_statement_date date, p_opening_balance numeric, p_closing_balance numeric, p_file_name text, p_lines jsonb)\n RETURNS bigint\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'pg_catalog', 'public', 'pg_temp'\nAS $function$begin perform reconciliation_private.before_import(p_bank_account_id,p_statement_date,p_opening_balance,p_closing_balance,p_lines); return reconciliation_private.import_bank_statement(p_bank_account_id,p_statement_date,p_opening_balance,p_closing_balance,p_file_name,p_lines);end$function$\n");
  for(const table of ['bank_statement','bank_statement_line','bank_reconciliation','bank_reconciliation_match'])
   await db.exec('create trigger security_reconciliation_sources before insert or update or delete on public.'+table+' for each row execute function reconciliation_private.protect_sources()');
  await db.exec(`revoke all on function reconciliation_private.before_import(bigint,date,numeric,numeric,jsonb),reconciliation_private.protect_sources(),reconciliation_private.import_bank_statement(bigint,date,numeric,numeric,text,jsonb)from public,anon,authenticated,service_role;
   revoke all on function public.import_bank_statement(bigint,date,numeric,numeric,text,jsonb)from public,anon,authenticated,service_role;
   grant execute on function public.import_bank_statement(bigint,date,numeric,numeric,text,jsonb)to authenticated;
   insert into role_access_matrix(role_id,resource_key,can_view,can_create,can_edit,can_delete)values
   (1,'reports:accounting-reports',true,false,false,false),(2,'reports:accounting-reports',true,false,false,false),(3,'reports:accounting-reports',true,false,false,false);
  `);
  if(apply)await applyBankStatementContinuity(db);
  return{db,manifest};
 }catch(error){await db.close();throw error;}
}
