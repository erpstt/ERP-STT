import {readFile} from 'node:fs/promises';
import {setupAssetDisposalAccounting} from './setup-asset-disposal-accounting.mjs';
// Isolated contract fixture for the existing native Sales APIs. No remote sessions.
export async function setupAssetNativeInvoice(db){
 await setupAssetDisposalAccounting(db);
 await db.exec(`create table products(product_id bigint primary key,item_code text,display_name text,sales_account_id bigint,is_active boolean,product_usage text);
 create table product_subsidiaries(product_id bigint,subsidiary_id bigint,is_active boolean);
 create table payment_terms(term_id bigint primary key,term_name text,days_due integer);
 create table if not exists countries(country_id bigint primary key,country_name text);
 alter table subsidiaries add column if not exists country_id bigint;
 alter table invoice alter column invoice_id add generated always as identity;
 alter table invoice add column total_amount numeric,add column invoice_date date,add column journal_id bigint,add column transaction_id bigint,add column customer_id bigint,add column currency_id bigint,add column exchange_rate numeric;
 create table sales_invoice_line(line_id bigint generated always as identity,invoice_id bigint,product_id bigint,account_id bigint,amount numeric,quantity numeric,unit_price numeric,tax_code_id bigint,tax_rate numeric,department_id bigint,cost_center_id bigint,class_id bigint,related_company_id bigint,service_country_id bigint,service_month text,note text);
 create table customer_payment_application(invoice_id bigint);
 create table credit_note(cn_id bigint generated always as identity primary key,invoice_id bigint,journal_id bigint);
 create table debit_note(invoice_id bigint);
 insert into products values(1,'AF','Venta de activo',303,true,'Venta');insert into product_subsidiaries values(1,1,true);insert into payment_terms values(1,'Contado',0);insert into countries(country_id) values(1) on conflict do nothing;update subsidiaries set country_id=1;
 create schema sales_invoice_private;
 create function resolve_customer_receivable_account(bigint,bigint) returns bigint language sql as $$select 101::bigint$$;
 create function sales_invoice_private.prepare(p jsonb,id bigint) returns jsonb language plpgsql as $$begin
 perform public.security_assert_role_access('sales:invoices','create');
 if not exists(select 1 from products where product_id=(p->'lines'->0->>'product_id')::bigint) or (p->>'payment_term_id')::bigint<>1 then raise exception using errcode='22023',message='Invalid invoice fields';end if;return p;end$$;
 insert into role_access_matrix values(1,'sales:invoices',true,true,true,true);
 create function public.save_sales_invoice(p jsonb,id bigint) returns jsonb language plpgsql as $$declare jid bigint;iid bigint;entry jsonb;amount numeric:=(p->'lines'->0->>'unit_price')::numeric;tax numeric:=case when p->'lines'->0->>'tax_code_id'='1' then round(amount*0.19,6) else 0 end;rate numeric:=(p->>'exchange_rate')::numeric;begin
 entry:=jsonb_build_object('journal_date',p->>'invoice_date','currency_id',1,'exchange_rate',1,'fiscal_period_id',p->>'fiscal_period_id','journal_type','Asiento de Diario General','lines',jsonb_build_array(jsonb_build_object('account_id',101,'debit',(amount+tax)*rate,'credit',0),jsonb_build_object('account_id',303,'debit',0,'credit',amount*rate))||case when tax>0 then jsonb_build_array(jsonb_build_object('account_id',305,'debit',0,'credit',tax*rate)) else '[]'::jsonb end);
 jid:=journal_entry_private.create_journal_entry(entry);perform sync_journal_gl_impacts(jid);
 insert into invoice(invoice_number,subsidiary_id,journal_id,transaction_id,customer_id,currency_id,exchange_rate) select 'FAC-TEST-'||jid,1,jid,transaction_id,(p->>'customer_id')::bigint,(p->>'currency_id')::bigint,rate from journal where journal_id=jid returning invoice_id into iid;
 insert into sales_invoice_line(invoice_id,product_id,account_id,amount,quantity,unit_price,tax_code_id,tax_rate) values(iid,1,303,amount,1,amount,nullif(p->'lines'->0->>'tax_code_id','')::bigint,case when tax>0 then 19 else 0 end);
 return jsonb_build_object('invoiceId',iid,'journalId',jid);end$$;
 create function public.save_sales_note(k text,p jsonb,id bigint) returns jsonb language plpgsql as $$declare jid bigint;nid bigint;i invoice;l record;entry jsonb;lines jsonb:='[]';begin
 select * into i from invoice where invoice_id=(p->>'invoice_id')::bigint;
 for l in select * from journal_line where journal_id=i.journal_id loop lines:=lines||jsonb_build_array(jsonb_build_object('account_id',l.account_id,'debit',l.credit,'credit',l.debit));end loop;
 entry:=jsonb_build_object('journal_date',p->>'note_date','currency_id',1,'exchange_rate',1,'fiscal_period_id',p->>'fiscal_period_id','journal_type','Asiento de Diario General','lines',lines);
 jid:=journal_entry_private.create_journal_entry(entry);perform sync_journal_gl_impacts(jid);insert into credit_note(invoice_id,journal_id) values(i.invoice_id,jid) returning cn_id into nid;return jsonb_build_object('noteId',nid,'journalId',jid);end$$;`);
 await db.exec('begin');await db.exec(await readFile(new URL('../../supabase/migrations/20261119235000_asset_sale_native_invoice.sql',import.meta.url),'utf8'));await db.exec('commit');
}
