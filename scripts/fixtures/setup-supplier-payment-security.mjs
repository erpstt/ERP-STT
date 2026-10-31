import {readFile,readdir} from 'node:fs/promises';import {setupSupplierNoteSecurity} from './setup-supplier-note-security.mjs';
export async function setupSupplierPaymentSecurity(db){
 await setupSupplierNoteSecurity(db);
 await db.exec(`alter table bank_transaction rename column bank_transaction_id to bank_tran_id;alter table bank_transaction add column beneficiary text,add column is_opening_balance boolean default false,add column opening_bank_item_id bigint,add column opening_balance_line_id bigint;
 alter table locations add column if not exists subsidiary_id bigint;alter table fiscal_periods add column if not exists period_name text;
 alter table supplier_payment alter column status set default 'APROBADO';alter table supplier_payment alter column exchange_rate set default 1;
 alter table supplier_payment_application add foreign key(payment_id) references supplier_payment on delete cascade;
 alter table gl_impact add foreign key(transaction_id) references "transaction" on delete cascade;
 drop table supplier_payment_withholding;
 create table supplier_payment_withholding(payment_withholding_id bigint generated always as identity primary key,payment_id bigint references supplier_payment on delete cascade,invoice_id bigint,invoice_withholding_id bigint,tax_code_id bigint,liability_account_id bigint,base_applied numeric,withholding_amount numeric);
 create table bank_reconciliation(bank_account_id bigint,reconciliation_date date,status text);
 create table bank_reconciliation_match(bank_tran_id bigint);
 create table quadratic_bank_reconciliations(bank_account_id bigint,period_year integer,period_month integer,status text);
 create table quadratic_reconciliation_matches(bank_tran_id bigint);create table quadratic_reconciliation_items(bank_tran_id bigint);
 create table payment_batch_items(payment_id bigint,journal_id bigint);
 create table solicitudes_pago_eventos(id_solicitud bigint,usuario bigint,accion text,nota text);
 create function pr_access() returns bigint language sql stable security definer as $$select asset_posting_private.identity()$$;
 create function pr_can_execute() returns boolean language sql stable security definer as $$select app_active_role_id()=2$$;
 create function pr_validate(bigint) returns void language sql as $$select$$;
 create function payment_email_history(bigint) returns jsonb language sql as $$select '[]'::jsonb$$;
 create function payment_email_resend(bigint,text default null) returns jsonb language sql as $$select '{}'::jsonb$$;
 insert into transaction_types values(12,'PAG_PRO','Pago de proveedor');`);
 const advance=await readFile(new URL('../../supabase/migrations/20260909180000_supplier_advances.sql',import.meta.url),'utf8');await db.exec(advance.slice(0,advance.indexOf('create index')));
 const names=new Set(['supplier_payment_options','supplier_payment_report','supplier_payment_detail','delete_supplier_payment','supplier_payment_request_locks','supplier_payment_advance_summary','supplier_payment_advance_detail','supplier_available_advances','save_supplier_payment_with_advances_base','save_supplier_payment_before_payable_routing','save_supplier_payment_with_advances_before_payable_routing','save_supplier_payment_without_withholding','apply_supplier_payment_payable_accounts','save_supplier_payment','save_supplier_payment_with_advances','protect_applied_supplier_advance','validate_supplier_payment_application_payable','pr_protect_invoice_payment','pr_protect_payment']);
 const dir=new URL('../../supabase/migrations/',import.meta.url);for(const file of (await readdir(dir)).sort()){
  if(!file.endsWith('.sql')||file>'20261030235959.sql')continue;const sql=await readFile(new URL(file,dir),'utf8'),events=[];
  for(const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)\s*\([\s\S]*?\$\$[\s\S]*?\$\$\s*;/gi))if(names.has(m[1]))events.push({index:m.index,sql:m[0]});
  for(const m of sql.matchAll(/alter\s+function\s+(?:public\.)?([a-z0-9_]+)\s*(\([^;]+?\))\s*rename\s+to\s+([a-z0-9_]+)\s*;/gi))if(names.has(m[1])&&names.has(m[3]))events.push({index:m.index,sql:m[0],from:m[1]+m[2],to:m[3]+m[2]});
  for(const e of events.sort((a,b)=>a.index-b.index)){if(e.from){const r=(await db.query('select to_regprocedure($1) a,to_regprocedure($2) b',[e.from,e.to])).rows[0];if(!r.a||r.b)continue;}await db.exec(e.sql);}
 }
 await db.exec(await readFile(new URL('./legacy-supplier-payment-treasury.sql',import.meta.url),'utf8'));
 await db.exec(`create trigger advance_protection before update or delete on supplier_payment for each row execute function protect_applied_supplier_advance();
 create trigger request_protection before update or delete on supplier_payment for each row execute function pr_protect_payment();
 create trigger request_invoice before insert or update of invoice_id,amount on supplier_payment_application for each row execute function pr_protect_invoice_payment();
 create trigger payable_guard before insert or update on supplier_payment_application for each row execute function validate_supplier_payment_application_payable();
 create trigger batch_guard before insert or update or delete on supplier_payment_application for each row execute function supplier_invoice_batch_guard();`);
 await db.query('insert into role_access_matrix values(1,$1,true,true,true,true),(3,$1,true,false,false,false)',['purchasing:supplier-payments']);
 await db.exec('begin');await db.exec(await readFile(new URL('../../supabase/migrations/20261031172846_secure_supplier_payments.sql',import.meta.url),'utf8'));await db.exec('commit');
}
