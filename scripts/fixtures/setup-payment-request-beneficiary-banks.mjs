import {readFile} from 'node:fs/promises';
import {setupPaymentRequestSecurity} from './setup-payment-request-security.mjs';

export const beneficiaryBankMigration='20261102180607_payment_request_beneficiary_bank_accounts.sql';
const migrationFile=name=>new URL('../../supabase/migrations/'+name,import.meta.url);

// Local in-memory database only. Reuse the real guarded request/treasury engines
// and add only the catalog structure required for beneficiary bank projections.
export async function setupPaymentRequestBeneficiaryBanks(db){
  await setupPaymentRequestSecurity(db);
  for(const table of ['suppliers','employees']){
    await db.exec(`alter table ${table}
      add column if not exists payment_beneficiary_name text,
      add column if not exists payment_bank_id bigint references banks(bank_id),
      add column if not exists payment_iban text,
      add column if not exists payment_account_number text,
      add column if not exists payment_currency_id bigint references currencies(currency_id),
      add column if not exists secondary_payment_bank_id bigint references banks(bank_id),
      add column if not exists secondary_payment_iban text,
      add column if not exists secondary_payment_account_number text,
      add column if not exists secondary_payment_currency_id bigint references currencies(currency_id)`);
  }
  await db.exec(`create table other_names(
    other_name_id bigint primary key,subsidiary_id bigint not null references subsidiaries(subsidiary_id),
    other_name_number text,name text,identification text,is_active boolean not null default true,
    payment_beneficiary_name text,payment_bank_id bigint references banks(bank_id),payment_iban text,
    payment_account_number text,payment_currency_id bigint references currencies(currency_id),
    secondary_payment_bank_id bigint references banks(bank_id),secondary_payment_iban text,
    secondary_payment_account_number text,secondary_payment_currency_id bigint references currencies(currency_id));
    alter table solicitudes_pago_lineas add constraint solicitudes_pago_lineas_tipo_tercero_check
      check(tipo_tercero in('Cliente','Proveedor','Empleado','Agencia Tributaria')),
      add constraint solicitudes_pago_lineas_single_party_check
      check(num_nonnulls(id_cliente,id_proveedor,id_empleado,id_agencia_tributaria)<=1);
    alter table journal_line add constraint journal_line_entity_type_allowed
      check(entity_type is null or entity_type in('Cliente','Proveedor','Empleado','Agencia Tributaria'));
    alter table subsidiaries add column if not exists logo_url text,add column if not exists legal_name text,
      add column if not exists tax_id text;
    alter table currencies add column if not exists name text;
    alter table customers add column if not exists tax_id text;
    alter table employees add column if not exists identification text,add column if not exists department_id bigint;
    alter table wf_instances add column if not exists approval_context jsonb default '{}';
    update suppliers set primary_subsidiary_id=1 where supplier_id=10;
    update suppliers set primary_subsidiary_id=2 where supplier_id=11;
    update subsidiaries set tax_supervisor_user_id=2 where subsidiary_id=1;
    insert into banks(bank_id,bank_name)values(501,'Synthetic beneficiary bank'),(502,'Synthetic second bank');
    insert into employees(employee_id,first_name,last_name,subsidiary_id,is_active,identification)
      values(901,'Synthetic','Payee',1,true,'SYN-EMP'),(902,'Foreign','Payee',2,true,'FOREIGN-EMP');
    insert into other_names(other_name_id,subsidiary_id,other_name_number,name,identification,is_active)
      values(801,1,'ON-000001','Synthetic other name','SYN-OTHER',true),
        (802,2,'ON-000001','Foreign other name','FOREIGN-OTHER',true),
        (803,1,'ON-000002','Inactive other name','INACTIVE-OTHER',false),
        (804,1,'ON-000003','No bank instructions','EMPTY-OTHER',true);
    update suppliers set payment_beneficiary_name='Synthetic supplier beneficiary',
      payment_bank_id=501,payment_iban='CR05015202001026284066',payment_account_number='00001001',payment_currency_id=1,
      secondary_payment_bank_id=502,secondary_payment_iban='GB82WEST12345698765432',
      secondary_payment_account_number='00002002',secondary_payment_currency_id=2
      where supplier_id=10;
    update employees set payment_beneficiary_name='Synthetic employee beneficiary',
      payment_bank_id=501,payment_account_number='00003003',
      secondary_payment_bank_id=502,secondary_payment_currency_id=2 where employee_id=901;
    update other_names set payment_beneficiary_name='Synthetic other beneficiary',
      payment_bank_id=501,payment_iban='GB82WEST12345698765432',payment_currency_id=1,
      secondary_payment_bank_id=502,secondary_payment_account_number='00004004',secondary_payment_currency_id=2
      where other_name_id=801;
    update other_names set payment_bank_id=501,payment_account_number='SECRET-FOREIGN' where other_name_id=802;
    alter table other_names enable row level security;
    revoke all on suppliers,employees,other_names from anon,authenticated;
    revoke all on all functions in schema bank_check_private from public,anon,authenticated,service_role;`);

  // Restore the existing tax-agency report/name projections and the real email
  // snapshot. The shared cutoff fixture intentionally skips these DO patches.
  const email=await readFile(migrationFile('20261005100000_expense_approval_email_notifications.sql'),'utf8');
  const snapshot=email.match(/create or replace function public\.expense_approval_email_snapshot\([\s\S]*?\$\$[\s\S]*?\$\$;/i)?.[0];
  if(!snapshot)throw Error('Missing real approval email snapshot');
  await db.exec(snapshot);
  const taxReport=(await readFile(migrationFile('20261027101000_payment_request_tax_agency_reporting.sql'),'utf8'))
    .replaceAll('public.payment_request_report_options()','payment_request_private.payment_request_report_options()')
    .replaceAll('public.run_payment_request_report(jsonb)','payment_request_private.run_payment_request_report(jsonb)');
  await db.exec(taxReport);
  const currentSnapshot=(await db.query("select pg_get_functiondef('public.expense_approval_email_snapshot(bigint,bigint,bigint)'::regprocedure) definition")).rows[0].definition;
  await db.exec(currentSnapshot.replaceAll('employee.department_id,customer.department_id,center_customer.department_id',
    'l.id_departamento,employee.department_id,customer.department_id,center.department_id,center_customer.department_id'));
  await db.exec('revoke all on function expense_approval_email_snapshot(bigint,bigint,bigint) from public,anon,authenticated');
  const historicalId=(await db.query(`insert into solicitudes_pago(numero,id_subsidiaria,id_moneda,tipo_solicitud,
    fecha_pago_programada,id_solicitante,concepto,total,estado,version)
    values('SYN-HISTORICAL-APPROVED',1,1,'OTROS','2026-10-31',1,'Historical fixture',50,'APROBADO',3)returning id`)).rows[0].id;
  await db.query(`insert into solicitudes_pago_lineas(id_solicitud,id_cuenta_contable,tipo_tercero,
    id_proveedor,id_departamento,concepto,monto)values($1,203,'Proveedor',10,21,'Historical fixture line',50)`,[historicalId]);
  const existingFunctionIds=(await db.query("select oid::int id from pg_proc where pronamespace in('public'::regnamespace,'payment_request_private'::regnamespace,'bank_check_private'::regnamespace,'supplier_payment_private'::regnamespace) order by oid")).rows.map(x=>x.id);
  const fingerprint=async()=>{
    const functions=(await db.query(`select p.oid::int id,p.prosecdef,p.proacl::text acl,p.proconfig
      from pg_proc p where p.oid=any($1::oid[])order by p.oid`,[existingFunctionIds])).rows;
    const policies=(await db.query('select * from pg_policies order by schemaname,tablename,policyname')).rows;
    const historical=(await db.query(`select jsonb_build_object(
      'header',(select jsonb_strip_nulls(to_jsonb(h))from solicitudes_pago h where id=$1),
      'lines',(select jsonb_agg(jsonb_strip_nulls(to_jsonb(l))order by id)from solicitudes_pago_lineas l where id_solicitud=$1)) data`,[historicalId])).rows[0].data;
    return{functions,policies,historical};
  };
  const before=await fingerprint();
  await db.exec('begin');
  try{await db.exec(await readFile(migrationFile(beneficiaryBankMigration),'utf8'));await db.exec('commit');}
  catch(error){await db.exec('rollback');throw error;}
  return {before,after:await fingerprint(),historicalId};
}
