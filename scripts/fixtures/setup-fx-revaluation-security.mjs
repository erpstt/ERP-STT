import{readFile}from'node:fs/promises';import{setupPendingInvoiceSecurity}from'./setup-pending-invoice-security.mjs';
export const migration='20261101084601_secure_fx_revaluation.sql';
export async function setupFxRevaluationSecurity(db){await setupPendingInvoiceSecurity(db);const read=p=>readFile(new URL(p,import.meta.url),'utf8');
 await db.exec(await read('./fx-revaluation-tables.sql'));await db.exec(await read('./fx-revaluation-reference-columns.sql'));await db.exec('set check_function_bodies=off');await db.exec(await read('./fx-revaluation-original-functions.sql'));await db.exec('set check_function_bodies=on');
 await db.exec(`alter table fx_revaluation_runs alter column run_id set not null;alter table fx_revaluation_runs add primary key(run_id);alter table fx_revaluation_settings add primary key(subsidiary_id);
 create unique index fixture_fx_once on fx_revaluation_runs(subsidiary_id,fiscal_period_id,currency_id)where status='CONTABILIZADO';
 alter table chart_accounts add column if not exists pending_fx_revaluation boolean default false;
 insert into role_access_matrix values(1,'accounting:fx-revaluation',true,true,false,false),(2,'accounting:fx-revaluation',false,true,false,false),(3,'accounting:fx-revaluation',true,false,false,false),(4,'accounting:fx-revaluation-analysis',true,false,false,false);
 insert into user_roles values(1,4)on conflict do nothing;
 insert into chart_accounts(account_id,account_number,account_name,category,accepts_entries,is_inactive,pending_fx_revaluation,nature,financial_statement)values(2601,'111990','Synthetic FX cash','Activo',true,false,true,'Deudora','Balance General'),(2602,'4201-02','Synthetic FX gain','Ingreso',true,false,false,'Acreedora','Estado de Resultados'),(2603,'5201-02','Synthetic FX loss','Gasto',true,false,false,'Deudora','Estado de Resultados');
 insert into account_subsidiaries values(2601,1,true),(2602,1,true),(2603,1,true);insert into subsidiary_currencies values(1,2)on conflict do nothing;
 insert into fiscal_periods(fiscal_period_id,subsidiary_id,start_date,end_date,is_closed,gl_closed,is_inactive)values(13,1,'2026-11-01','2026-11-30',false,false,false);
 insert into transaction_types(transaction_type_id,abbreviation,name)values(71,'DIF_CAM','Synthetic FX');
 `);
 await db.exec(await read('./fx-revaluation-defaults-triggers.sql'));await db.exec('begin');await db.exec(await read('../../supabase/migrations/'+migration));await db.exec('commit');
}
