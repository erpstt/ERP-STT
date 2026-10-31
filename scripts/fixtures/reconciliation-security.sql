-- Synthetic data only. Extends bank-fee fixtures to exercise both real reconciliation engines.
alter table public.bank_statement alter column statement_id add generated always as identity(start with 100);
alter table public.bank_statement add column opening_balance numeric default 0,add column closing_balance numeric default 0,
 add column source_file_name text,add column imported_at timestamptz default now();
alter table public.bank_statement add unique(statement_date,bank_account_id);
alter table public.bank_statement_line alter column statement_line_id add generated always as identity(start with 100);
alter table public.bank_statement_line add column source_row int;
alter table public.bank_statement_line alter column reconciliation_status set default 'PENDIENTE';
alter table public.bank_reconciliation add primary key(reconciliation_id);
alter table public.bank_reconciliation add column fiscal_period_id bigint,add column book_balance numeric,
 add column statement_balance numeric,add column transit_payments numeric,add column transit_deposits numeric,
 add column bank_adjustments numeric,add column difference numeric,add column closed_at timestamptz,add column closed_by bigint,
 add column created_by_id text,add column created_by_name text;
alter table public.bank_reconciliation add unique(bank_account_id,fiscal_period_id);
alter table public.bank_reconciliation_match add column match_id bigint generated always as identity primary key,
 add column matched_at timestamptz default now();
alter table public.bank_reconciliation_match add unique(bank_tran_id);
alter table public.bank_transaction add column is_opening_balance boolean default false;
alter table public."transaction" add column customer_id bigint,add column supplier_id bigint;
alter table public.subsidiaries add column legal_name text,add column tax_id text,add column logo_url text;
alter table public.employees add column is_active boolean default true,add column user_id bigint,add column job_title text;
alter table public.roles add column is_active boolean default true;
create function public.security_resource_allowed(p_resource text,p_action text) returns boolean language plpgsql stable security definer as $$
begin perform public.security_assert_role_access(p_resource,p_action);return true;exception when insufficient_privilege then return false;end$$;
create function public.accounting_report_options_bundle() returns jsonb language plpgsql stable security definer as $$
 begin return jsonb_build_object('bankOptions',coalesce(public.bank_reconciliation_options(),'{}'::jsonb));end
$$;
-- Mixed owner-independent rows are kept outside the active company for denial tests.
update bank_statement set opening_balance=0,closing_balance=0;
delete from bank_statement_line;
insert into bank_transaction(bank_tran_id,tran_date,value_date,bank_account_id,transaction_id,amount,tran_type,reference_number,description,reconciliation_status)
 overriding system value values(10,'2026-10-10','2026-10-10',1,null,100,'SYNTHETIC','MATCH','Synthetic receipt','PENDIENTE_EN_TRANSITO'),
 (11,'2026-10-11','2026-10-11',1,null,-40,'SYNTHETIC','PAYMENT','Synthetic payment','PENDIENTE_EN_TRANSITO'),
 (12,'2026-10-10','2026-10-10',3,null,100,'SYNTHETIC','FOREIGN','Foreign receipt','PENDIENTE_EN_TRANSITO');
update bank_statement set closing_balance=60 where statement_id=1;
insert into bank_statement_line(statement_line_id,statement_id,bank_date,value_date,amount,reference,description,beneficiary,reconciliation_status)
 overriding system value values(10,1,'2026-10-10','2026-10-10',100,'MATCH','Synthetic receipt','Synthetic','PENDIENTE'),
 (11,1,'2026-10-11','2026-10-11',-40,'PAYMENT','Synthetic payment','Synthetic','PENDIENTE'),
 (12,2,'2026-10-10','2026-10-10',100,'FOREIGN','Foreign receipt','Synthetic','PENDIENTE');
