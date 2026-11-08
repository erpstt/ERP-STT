import {readFile} from 'node:fs/promises';
import {setupSupplierAdvancesReport} from './setup-supplier-advances-report.mjs';
export {assumeSecurityUser,assumeSqlRole,beginIsolatedCase,deniedSql,seedSupplierAdvanceSource,seedSupplierAdvanceApplication} from './setup-supplier-advances-report.mjs';
export const supplierPaymentAdvanceVisibilityMigration='20261108220513_allow_supplier_account_115004_advances.sql';
export const supplierPaymentAdvanceVisibilityTargets=[
 'supplier_payment_private.supplier_available_advances()',
 'supplier_payment_private.prepare(jsonb,bigint,bigint)',
 'supplier_payment_private.save_supplier_payment_with_advances_base(jsonb,bigint)',
];
export async function setupSupplierPaymentAdvanceVisibility(db){
 await setupSupplierAdvancesReport(db);
 // Bring the one older fixture definition to the already-published optional
 // supplier flag guard, using the exact two literals from its migration.
 const beneficiary=(await readFile(new URL('../../supabase/migrations/20261102180607_payment_request_beneficiary_bank_accounts.sql',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
 const patch=beneficiary.match(/'supplier_payment_private\.prepare\(jsonb,bigint,bigint\)',\s*\$old\$([\s\S]*?)\$old\$,\s*\$new\$([\s\S]*?)\$new\$/);
 if(!patch)throw Error('Missing published supplier preparation compatibility');
 await db.exec('reset role');
 const source=(await db.query("select pg_get_functiondef('supplier_payment_private.prepare(jsonb,bigint,bigint)'::regprocedure)d")).rows[0].d;
 if(source.split(patch[1]).length!==2)throw Error('Unexpected fixture preparation compatibility source');
 await db.exec(source.replace(patch[1],patch[2]));
 await db.exec(`reset role;
  update subsidiaries set name='SYNTHETIC EMPRESA DE PRUEBAS'where subsidiary_id=1;
  insert into account_group(group_id,group_name,category)values(700,'Otras Cuentas por Cobrar','Activo');
  update chart_accounts set account_group_id=700 where account_id=601;
  insert into chart_accounts(account_id,account_number,account_name,category,accepts_entries,account_group_id)
   values(603,'118002','Synthetic unrelated other receivable','Activo',true,700);
  insert into account_subsidiaries values(603,1,true);
 `);
 // The same real baseline must be guarded in Windows CRLF and Linux LF clones.
 for(const target of supplierPaymentAdvanceVisibilityTargets){
  const definition=(await db.query('select pg_get_functiondef($1::regprocedure)d',[target])).rows[0].d;
  await db.exec(definition.replace(/\r\n/g,'\n'));
 }
}
export async function applySupplierPaymentAdvanceVisibility(db){
 const sql=(await readFile(new URL('../../supabase/migrations/'+supplierPaymentAdvanceVisibilityMigration,import.meta.url),'utf8')).replace(/\r\n/g,'\n');
 await db.exec('reset role;begin');try{await db.exec(sql);await db.exec('commit');}catch(error){await db.exec('rollback');throw error;}
}
