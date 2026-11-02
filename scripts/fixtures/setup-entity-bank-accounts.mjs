import {readFile} from 'node:fs/promises';
import {setupEmployeeMasterSecurity} from './setup-employee-master-security.mjs';

export const migration='20261102173013_entity_bank_accounts_and_sections.sql';
const read=path=>readFile(new URL(path,import.meta.url),'utf8');
const definition=(source,name)=>{
  const start=source.indexOf('create or replace function public.'+name+'(');
  const end=source.indexOf('$$;',start);
  if(start<0||end<0)throw Error('Missing original function '+name);
  return source.slice(start,end+3);
};
export async function assumeBankActor(db,user=1,role=1,sid=1){
  await db.exec('reset role');
  await db.query("insert into user_role_sessions values('fixture',$1,$2)on conflict(session_id)do update set user_id=$1,role_id=$2",[user,role]);
  await db.query("insert into user_company_sessions values('fixture',$1,$2)on conflict(session_id)do update set user_id=$1,subsidiary_id=$2",[user,sid]);
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:'00000000-0000-0000-0000-'+String(user).padStart(12,'0'),session_id:'fixture'})]);
  await db.exec('set role authenticated');
}
export async function bankSnapshot(db){
  const result={};
  for(const[table,pk]of[['suppliers','supplier_id'],['employees','employee_id'],['other_names','other_name_id']])
    result[table]=(await db.query('select jsonb_agg(jsonb_strip_nulls(to_jsonb(r))order by '+pk+') data from public.'+table+' r')).rows[0].data;
  return result;
}
export async function setupEntityBankAccounts(db){
  await setupEmployeeMasterSecurity(db);
  await db.exec('update role_access_matrix m set can_view=x.v,can_create=x.c,can_edit=x.e,can_delete=x.d '+
    'from(select role_id,resource_key,bool_or(can_view)v,bool_or(can_create)c,bool_or(can_edit)e,bool_or(can_delete)d '+
      'from role_access_matrix group by role_id,resource_key)x where m.role_id=x.role_id and m.resource_key=x.resource_key; '+
    'delete from role_access_matrix a using role_access_matrix b '+
      'where a.role_id=b.role_id and a.resource_key=b.resource_key and a.ctid>b.ctid; '+
    'create unique index fixture_entity_bank_matrix on role_access_matrix(role_id,resource_key)');
  await db.exec("alter table banks add column if not exists bank_code text;insert into banks(bank_id,bank_name,bank_code,country_id)values(501,'Account test bank','ACT',1),(502,'Secondary test bank','SEC',2)");
  await db.exec("insert into currencies(currency_id,currency_code)values(33,'XTS')");
  await db.exec(definition(await read('../../supabase/migrations/20261019110000_audit_change_report.sql'),'audit_change_entity_meta'));
  await db.exec('begin');
  await db.exec(await read('../../supabase/migrations/20261102162941_add_other_names_entities.sql'));
  await db.exec('commit');
  await db.exec("insert into role_access_matrix(role_id,resource_key,can_view,can_create,can_edit,can_delete)values(1,'entities:other-names',true,true,true,true),(3,'entities:other-names',true,false,false,false)");
  await assumeBankActor(db);
  await db.query("select save_entity_master('suppliers',$1,null)",[{company_name:'Legacy account supplier',tax_id:'BANK-LEGACY',supplier_type:'Empresa',subsidiary_ids:[1],currency_ids:[1],withholding_rules:[],payment_bank_id:501,payment_iban:'CR05015202001026284066',payment_beneficiary_name:'Legacy beneficiary'}]);
  await db.query("select save_entity_master('employees',$1,null)",[{identification:'BANK-LEGACY-EMPLOYEE',first_name:'Legacy',last_name:'Employee',subsidiary_id:1}]);
  await db.query("select save_other_name($1,null)",[{identification:'BANK-LEGACY-OTHER',name:'Legacy other name',payment_bank_id:501,payment_iban:'GB82WEST12345698765432',payment_account_number:'00001234'}]);
  await db.exec('reset role');
  const before=await bankSnapshot(db);
  await db.exec('begin');
  await db.exec(await read('../../supabase/migrations/'+migration));
  await db.exec('commit');
  return {before};
}
