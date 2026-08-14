alter table public.fiscal_periods
  add column if not exists checklist_completed boolean not null default false,
  add column if not exists ap_closed boolean not null default false,
  add column if not exists ar_closed boolean not null default false,
  add column if not exists gl_closed boolean not null default false,
  add column if not exists is_inactive boolean not null default false;

create or replace function public.validate_accounting_period()
returns trigger language plpgsql as $$
declare fiscal_start date; fiscal_end date;
begin
  select start_date,end_date into fiscal_start,fiscal_end from public.fiscal_years where fiscal_year_id=new.fiscal_year_id;
  if new.end_date<new.start_date then raise exception 'La fecha final no puede ser anterior a la fecha inicial.'; end if;
  if fiscal_start is not null and (new.start_date<fiscal_start or new.end_date>fiscal_end) then raise exception 'El período debe estar dentro de las fechas del año fiscal seleccionado.'; end if;
  if exists(select 1 from public.fiscal_periods p where p.subsidiary_id=new.subsidiary_id and p.fiscal_period_id<>coalesce(new.fiscal_period_id,0) and daterange(p.start_date,p.end_date,'[]') && daterange(new.start_date,new.end_date,'[]')) then raise exception 'Ya existe otro período contable para esta subsidiaria dentro del rango indicado.'; end if;
  if new.gl_closed and not(new.ap_closed and new.ar_closed) then raise exception 'Debe cerrar primero Compras (AP) y Ventas/Cuentas por cobrar (AR).'; end if;
  if new.is_closed and not(new.ap_closed and new.ar_closed and new.gl_closed) then raise exception 'Para cerrar el período deben estar cerrados AP, AR y GL.'; end if;
  if new.is_closed then new.checklist_completed:=true; end if;
  return new;
end $$;
drop trigger if exists validate_accounting_period_trigger on public.fiscal_periods;
create trigger validate_accounting_period_trigger before insert or update on public.fiscal_periods for each row execute function public.validate_accounting_period();

create or replace function public.guard_transaction_accounting_period()
returns trigger language plpgsql as $$
declare period public.fiscal_periods%rowtype; row_value public."transaction"%rowtype;
begin
  row_value:=case when tg_op='DELETE' then old else new end;
  select * into period from public.fiscal_periods where fiscal_period_id=row_value.fiscal_period_id;
  if period.fiscal_period_id is null then raise exception 'El período contable no existe.'; end if;
  if period.is_inactive or period.is_closed then raise exception 'El período contable % está cerrado o inactivo.',period.period_name; end if;
  if row_value.supplier_id is not null and period.ap_closed then raise exception 'Compras (AP) está cerrado para el período %.',period.period_name; end if;
  if row_value.customer_id is not null and period.ar_closed then raise exception 'Ventas/Cuentas por cobrar (AR) está cerrado para el período %.',period.period_name; end if;
  if row_value.customer_id is null and row_value.supplier_id is null and period.gl_closed then raise exception 'Libro Mayor (GL) está cerrado para el período %.',period.period_name; end if;
  return case when tg_op='DELETE' then old else new end;
end $$;
drop trigger if exists guard_transaction_accounting_period_trigger on public."transaction";
create trigger guard_transaction_accounting_period_trigger before insert or update or delete on public."transaction" for each row execute function public.guard_transaction_accounting_period();

create or replace function public.guard_journal_accounting_period()
returns trigger language plpgsql as $$
declare closed boolean; inactive boolean; name text; period_id bigint;
begin
  period_id:=case when tg_op='DELETE' then old.fiscal_period_id else new.fiscal_period_id end;
  select (is_closed or gl_closed),is_inactive,period_name into closed,inactive,name from public.fiscal_periods where fiscal_period_id=period_id;
  if closed or inactive then raise exception 'Libro Mayor (GL) está cerrado para el período %.',name; end if;
  return case when tg_op='DELETE' then old else new end;
end $$;
drop trigger if exists guard_journal_accounting_period_trigger on public.journal;
create trigger guard_journal_accounting_period_trigger before insert or update or delete on public.journal for each row execute function public.guard_journal_accounting_period();
comment on table public.fiscal_periods is 'Períodos contables mensuales con cierres diferenciados AP, AR y GL.';
