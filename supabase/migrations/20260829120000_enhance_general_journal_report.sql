alter table public.journal
 add column if not exists status text not null default 'CONTABILIZADO',
 add column if not exists created_by bigint references public.users(user_id),
 add column if not exists created_at timestamptz not null default now(),
 add column if not exists reversed_from_journal_id bigint references public.journal(journal_id);

alter table public.journal drop constraint if exists journal_status_allowed;
alter table public.journal add constraint journal_status_allowed check(status in('CONTABILIZADO','BORRADOR','ANULADO'));
update public.journal set created_by=coalesce(created_by,public.app_user_id()) where created_by is null;
create index if not exists journal_general_report_idx on public.journal(subsidiary_id,journal_date,status,transaction_id);
create index if not exists journal_line_general_report_idx on public.journal_line(journal_id,cost_center_id,account_id);

create or replace function public.set_journal_audit_user() returns trigger language plpgsql security definer set search_path=public as $$
begin new.created_by:=coalesce(new.created_by,app_user_id());return new;end$$;
drop trigger if exists journal_set_audit_user on public.journal;
create trigger journal_set_audit_user before insert on public.journal for each row execute function public.set_journal_audit_user();

insert into public.permissions(code,module,description) values('accounting:journal:reverse','Contabilidad','Permite generar la reversión de un asiento contabilizado.') on conflict(code) do nothing;
insert into public.role_permissions(role_id,permission_id)
select r.role_id,p.permission_id from public.roles r cross join public.permissions p
where p.code='accounting:journal:reverse' and (r.is_system_role or lower(r.role_name) like '%admin%')
on conflict do nothing;

create or replace function public.general_journal_options()
returns jsonb language sql stable security definer set search_path=public as $$
select jsonb_build_object(
 'modules',coalesce((select jsonb_agg(distinct module_category order by module_category) from transaction_types where module_category is not null),'[]'::jsonb),
 'canReverse',exists(select 1 from user_roles ur join role_permissions rp using(role_id) join permissions p using(permission_id) where ur.user_id=app_user_id() and p.code='accounting:journal:reverse')
)$$;

create or replace function public.run_general_journal_report(p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare sids bigint[];date_from date;date_to date;book_id bigint;cost_id bigint;module_filter text;status_filter text;search_text text;page_no int;page_size int;result jsonb;
begin
 select coalesce(array_agg(value::bigint),array[]::bigint[]) into sids from jsonb_array_elements_text(coalesce(p_filters->'subsidiaryIds','[]'::jsonb));
 if cardinality(sids)=0 then sids:=array[active_subsidiary_id()];end if;
 if sids[1] is null or exists(select 1 from unnest(sids) x where not exists(select 1 from user_subsidiaries u where u.user_id=app_user_id() and u.subsidiary_id=x)) then raise exception 'No tiene acceso a una o más subsidiarias seleccionadas.';end if;
 date_from:=nullif(p_filters->>'dateFrom','')::date;date_to:=nullif(p_filters->>'dateTo','')::date;
 if date_from is null or date_to is null then raise exception 'El rango de fechas es obligatorio.';end if;
 book_id:=nullif(p_filters->>'bookId','')::bigint;cost_id:=nullif(p_filters->>'costCenterId','')::bigint;module_filter:=nullif(p_filters->>'moduleCategory','');status_filter:=nullif(p_filters->>'journalStatus','');search_text:=lower(nullif(trim(p_filters->>'search'),''));page_no:=greatest(coalesce((p_filters->>'page')::int,1),1);page_size:=least(greatest(coalesce((p_filters->>'pageSize')::int,20),10),100);
 with eligible as(
  select j.*,t.tran_number document_number,tt.code transaction_code,tt.abbreviation,tt.name transaction_type,tt.module_category,st.code transaction_status,coalesce(u.first_name||' '||u.last_name,u.email,'Sistema') created_by_name,
   coalesce(sum(jl.debit),0) journal_debit,coalesce(sum(jl.credit),0) journal_credit
  from journal j left join "transaction" t using(transaction_id) left join transaction_types tt using(transaction_type_id) left join status st on st.status_id=t.status_id left join users u on u.user_id=j.created_by join journal_line jl using(journal_id)
  where j.subsidiary_id=any(sids) and j.journal_date between date_from and date_to and (status_filter is null or j.status=status_filter) and (module_filter is null or tt.module_category=module_filter) and (cost_id is null or exists(select 1 from journal_line x where x.journal_id=j.journal_id and x.cost_center_id=cost_id)) and (book_id is null or exists(select 1 from gl_impact g where g.transaction_id=j.transaction_id and g.accounting_book_id=book_id))
   and (search_text is null or lower(j.journal_number) like '%'||search_text||'%' or lower(coalesce(t.tran_number,'')) like '%'||search_text||'%' or lower(coalesce(j.memo,'')) like '%'||search_text||'%' or exists(select 1 from journal_line sx left join customers c using(customer_id) left join suppliers sp using(supplier_id) left join employees e using(employee_id) where sx.journal_id=j.journal_id and lower(concat_ws(' ',c.company_name,c.tax_id,sp.company_name,sp.tax_id,e.first_name,e.last_name,e.identification,sx.note)) like '%'||search_text||'%'))
  group by j.journal_id,t.tran_number,tt.code,tt.abbreviation,tt.name,tt.module_category,st.code,u.first_name,u.last_name,u.email
 ), counted as(select *,count(*) over() total_count from eligible),paged as(select * from counted order by journal_date,journal_id limit page_size offset (page_no-1)*page_size)
 select jsonb_build_object('rows',coalesce(jsonb_agg(jsonb_build_object('journal_id',p.journal_id,'journal_number',p.journal_number,'status',p.status,'date',p.journal_date,'transaction_code',coalesce(p.abbreviation,p.transaction_code),'transaction_type',p.transaction_type,'module_category',p.module_category,'document_number',p.document_number,'memo',p.memo,'created_by',p.created_by_name,'debit',p.journal_debit,'credit',p.journal_credit,'difference',p.journal_debit-p.journal_credit,'lines',coalesce((select jsonb_agg(jsonb_build_object('line_id',l.journal_line_id,'account_number',a.account_number,'account_name',a.account_name,'entity_type',l.entity_type,'entity_name',coalesce(c.company_name,sp.company_name,concat_ws(' ',e.first_name,e.last_name)),'cost_center',cc.code,'note',l.note,'debit',l.debit,'credit',l.credit) order by l.journal_line_id) from journal_line l join chart_accounts a using(account_id) left join customers c using(customer_id) left join suppliers sp using(supplier_id) left join employees e using(employee_id) left join cost_centers cc using(cost_center_id) where l.journal_id=p.journal_id),'[]'::jsonb)) order by p.journal_date,p.journal_id),'[]'::jsonb),'total',coalesce(max(p.total_count),0),'page',page_no,'pageSize',page_size,
  'summary',jsonb_build_object('debit',coalesce((select sum(journal_debit) from eligible),0),'credit',coalesce((select sum(journal_credit) from eligible),0))) into result from paged p;
 return coalesce(result,jsonb_build_object('rows','[]'::jsonb,'total',0,'page',page_no,'pageSize',page_size,'summary',jsonb_build_object('debit',0,'credit',0)));
end$$;

create or replace function public.reverse_journal_entry(target_journal_id bigint)
returns bigint language plpgsql security definer set search_path=public as $$
declare source journal%rowtype;new_id bigint;new_transaction bigint;type_id bigint;status_id_value bigint;sequence_no bigint;
begin
 if not exists(select 1 from user_roles ur join role_permissions rp using(role_id) join permissions p using(permission_id) where ur.user_id=app_user_id() and p.code='accounting:journal:reverse') then raise exception 'No tiene permiso para reversar asientos.';end if;
 select * into source from journal where journal_id=target_journal_id and subsidiary_id in(select subsidiary_id from user_subsidiaries where user_id=app_user_id()) for update;if not found then raise exception 'Asiento no encontrado.';end if;if source.status<>'CONTABILIZADO' then raise exception 'Solo se pueden reversar asientos contabilizados.';end if;
 select coalesce((select transaction_type_id from transaction_types where abbreviation='ASI_DIA' limit 1),t.transaction_type_id),t.status_id into type_id,status_id_value from "transaction" t where t.transaction_id=source.transaction_id;
 select coalesce(max(transaction_id),0)+1 into sequence_no from "transaction";insert into "transaction"(tran_number,tran_date,transaction_type_id,subsidiary_id,currency_id,exchange_rate,fiscal_period_id,total_amount,status_id) values('REV-'||source.journal_number||'-'||sequence_no,current_date,type_id,source.subsidiary_id,source.currency_id,source.exchange_rate,source.fiscal_period_id,source.total_debit,status_id_value) returning transaction_id into new_transaction;
 insert into journal(journal_number,journal_date,transaction_id,subsidiary_id,currency_id,fiscal_period_id,exchange_rate,memo,journal_type,total_debit,total_credit,status,reversed_from_journal_id) values('REV-'||source.journal_number,current_date,new_transaction,source.subsidiary_id,source.currency_id,source.fiscal_period_id,source.exchange_rate,'Reversión de '||source.journal_number,'Reversión',source.total_credit,source.total_debit,'CONTABILIZADO',source.journal_id) returning journal_id into new_id;
 insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,department_id,class_id,location_id,tax_code_id,tax_rate,gross_amount,note,entity_type,customer_id,supplier_id,employee_id,cost_center_id,financial_creditor_id,related_company_id) select new_id,account_id,credit,debit,credit_fx,debit_fx,department_id,class_id,location_id,tax_code_id,tax_rate,gross_amount,'Reversión: '||coalesce(note,''),entity_type,customer_id,supplier_id,employee_id,cost_center_id,financial_creditor_id,related_company_id from journal_line where journal_id=source.journal_id;
 insert into gl_impact(transaction_id,account_id,subsidiary_id,fiscal_period_id,accounting_book_id,debit_amount,credit_amount,debit_fx,credit_fx,posting_date) select new_transaction,account_id,subsidiary_id,source.fiscal_period_id,accounting_book_id,credit_amount,debit_amount,credit_fx,debit_fx,current_date from gl_impact where transaction_id=source.transaction_id;
 update journal set status='ANULADO' where journal_id=source.journal_id;return new_id;
end$$;
grant execute on function public.general_journal_options(),public.run_general_journal_report(jsonb),public.reverse_journal_entry(bigint) to authenticated;
