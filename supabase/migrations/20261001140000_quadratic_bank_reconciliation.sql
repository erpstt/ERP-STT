-- Conciliacion cuadratica bancaria (prueba de efectivo de cuatro columnas).
-- Los catalogos existentes de NEXO usan BIGINT; por eso las nuevas llaves
-- conservan ese tipo aunque la especificacion funcional sugiera UUID.

create table if not exists public.quadratic_bank_reconciliations(
  reconciliation_id bigint generated always as identity primary key,
  subsidiary_id bigint not null references public.subsidiaries(subsidiary_id) on delete restrict,
  bank_account_id bigint not null references public.bank_account(bank_account_id) on delete restrict,
  period_year integer not null check(period_year between 1900 and 2200),
  period_month integer not null check(period_month between 1 and 12),
  bank_start_balance numeric(24,6) not null default 0,
  bank_total_receipts numeric(24,6) not null default 0 check(bank_total_receipts>=0),
  bank_total_disbursements numeric(24,6) not null default 0 check(bank_total_disbursements>=0),
  bank_end_balance numeric(24,6) not null default 0,
  book_start_balance numeric(24,6) not null default 0,
  book_total_receipts numeric(24,6) not null default 0 check(book_total_receipts>=0),
  book_total_disbursements numeric(24,6) not null default 0 check(book_total_disbursements>=0),
  book_end_balance numeric(24,6) not null default 0,
  previous_reconciliation_id bigint references public.quadratic_bank_reconciliations(reconciliation_id) on delete set null,
  status text not null default 'draft' check(status in('draft','in_review','approved','closed')),
  notes text check(notes is null or length(notes)<=4000),
  created_by bigint not null references public.users(user_id) on delete restrict,
  reconciled_by bigint references public.users(user_id) on delete set null,
  approved_by bigint references public.users(user_id) on delete set null,
  closed_by bigint references public.users(user_id) on delete set null,
  approved_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(bank_account_id,period_year,period_month)
);

create table if not exists public.quadratic_reconciliation_items(
  item_id bigint generated always as identity primary key,
  reconciliation_id bigint not null references public.quadratic_bank_reconciliations(reconciliation_id) on delete cascade,
  bank_tran_id bigint references public.bank_transaction(bank_tran_id) on delete restrict,
  statement_line_id bigint references public.bank_statement_line(statement_line_id) on delete restrict,
  origin_item_id bigint references public.quadratic_reconciliation_items(item_id) on delete set null,
  item_type text not null check(item_type in(
    'DEPOSIT_IN_TRANSIT_PRIOR','DEPOSIT_IN_TRANSIT_CURRENT',
    'OUTSTANDING_CHECK_PRIOR','OUTSTANDING_CHECK_CURRENT',
    'UNRECORDED_BANK_CHARGE','UNRECORDED_BANK_CREDIT','BOOK_ERROR','BANK_ERROR'
  )),
  adjustment_side text not null check(adjustment_side in('BANK','BOOK')),
  source_kind text not null default 'MANUAL' check(source_kind in('MANUAL','CARRY_FORWARD','UNMATCHED')),
  description varchar(255) not null check(length(trim(description)) between 1 and 255),
  reference_number varchar(100),
  transaction_date date not null,
  amount numeric(24,6) not null default 0 check(amount>=0),
  impact_start_balance numeric(24,6) not null default 0,
  impact_receipts numeric(24,6) not null default 0,
  impact_disbursements numeric(24,6) not null default 0,
  impact_end_balance numeric(24,6) not null default 0,
  created_by bigint not null references public.users(user_id) on delete restrict,
  updated_by bigint references public.users(user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(abs((impact_start_balance+impact_receipts-impact_disbursements)-impact_end_balance)<0.000001)
);

create table if not exists public.quadratic_reconciliation_matches(
  match_id bigint generated always as identity primary key,
  reconciliation_id bigint not null references public.quadratic_bank_reconciliations(reconciliation_id) on delete cascade,
  bank_tran_id bigint not null references public.bank_transaction(bank_tran_id) on delete restrict,
  statement_line_id bigint not null references public.bank_statement_line(statement_line_id) on delete restrict,
  match_type text not null check(match_type in('AUTOMATIC','MANUAL')),
  matched_by bigint not null references public.users(user_id) on delete restrict,
  matched_at timestamptz not null default now(),
  unique(reconciliation_id,bank_tran_id),
  unique(reconciliation_id,statement_line_id)
);

create table if not exists public.quadratic_reconciliation_history(
  history_id bigint generated always as identity primary key,
  reconciliation_id bigint not null references public.quadratic_bank_reconciliations(reconciliation_id) on delete cascade,
  prior_status text,
  new_status text not null,
  changed_by bigint not null references public.users(user_id) on delete restrict,
  details jsonb not null default '{}'::jsonb,
  changed_at timestamptz not null default now()
);

create index if not exists quadratic_reconciliation_scope_idx
  on public.quadratic_bank_reconciliations(subsidiary_id,period_year,period_month,status);
create index if not exists quadratic_reconciliation_account_period_idx
  on public.quadratic_bank_reconciliations(bank_account_id,period_year desc,period_month desc);
create index if not exists quadratic_reconciliation_previous_idx
  on public.quadratic_bank_reconciliations(previous_reconciliation_id)
  where previous_reconciliation_id is not null;
create index if not exists quadratic_items_reconciliation_type_idx
  on public.quadratic_reconciliation_items(reconciliation_id,item_type,transaction_date,item_id);
create index if not exists quadratic_items_bank_transaction_idx
  on public.quadratic_reconciliation_items(bank_tran_id)
  where bank_tran_id is not null;
create index if not exists quadratic_items_statement_line_idx
  on public.quadratic_reconciliation_items(statement_line_id)
  where statement_line_id is not null;
create unique index if not exists quadratic_items_origin_once_idx
  on public.quadratic_reconciliation_items(reconciliation_id,origin_item_id)
  where origin_item_id is not null;
create index if not exists quadratic_matches_reconciliation_idx
  on public.quadratic_reconciliation_matches(reconciliation_id,matched_at,match_id);
create index if not exists quadratic_history_reconciliation_idx
  on public.quadratic_reconciliation_history(reconciliation_id,changed_at,history_id);

insert into public.permissions(code,module,description) values
 ('BANK_QUADRATIC_VIEW','Bancos','Consultar conciliaciones cuadraticas de las subsidiarias autorizadas.'),
 ('BANK_QUADRATIC_MANAGE','Bancos','Crear y preparar conciliaciones cuadraticas y sus partidas.'),
 ('BANK_QUADRATIC_APPROVE','Bancos','Aprobar y cerrar conciliaciones cuadraticas sin diferencias.')
on conflict(code)do update set module=excluded.module,description=excluded.description;

insert into public.role_permissions(role_id,permission_id)
select r.role_id,p.permission_id from public.roles r cross join public.permissions p
where p.code in('BANK_QUADRATIC_VIEW','BANK_QUADRATIC_MANAGE','BANK_QUADRATIC_APPROVE')
  and(r.is_system_role or lower(r.role_name)in('administrador','administrator','admin'))
on conflict do nothing;

create or replace function public.quadratic_has_permission(p_code text)returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select public.app_user_id() is not null
   and exists(select 1 from public.users u where u.user_id=public.app_user_id()and u.is_active)
   and(public.app_is_admin()or exists(
     select 1 from public.role_permissions rp
     join public.permissions p using(permission_id)
     join public.user_roles ur on ur.user_id=public.app_user_id()and ur.role_id=rp.role_id
     where rp.role_id=public.app_active_role_id()and p.code=p_code
   ))
$$;

create or replace function public.quadratic_can(p_subsidiary_id bigint,p_code text)returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select public.quadratic_has_permission(p_code)and exists(
   select 1 from public.user_subsidiaries us
   where us.user_id=public.app_user_id()and us.subsidiary_id=p_subsidiary_id
 )
$$;

alter table public.quadratic_bank_reconciliations enable row level security;
alter table public.quadratic_bank_reconciliations force row level security;
alter table public.quadratic_reconciliation_items enable row level security;
alter table public.quadratic_reconciliation_items force row level security;
alter table public.quadratic_reconciliation_matches enable row level security;
alter table public.quadratic_reconciliation_matches force row level security;
alter table public.quadratic_reconciliation_history enable row level security;
alter table public.quadratic_reconciliation_history force row level security;

create policy quadratic_reconciliation_read on public.quadratic_bank_reconciliations
 for select to authenticated using(public.quadratic_can(subsidiary_id,'BANK_QUADRATIC_VIEW'));
create policy quadratic_reconciliation_create on public.quadratic_bank_reconciliations
 for insert to authenticated with check(public.quadratic_can(subsidiary_id,'BANK_QUADRATIC_MANAGE'));
create policy quadratic_reconciliation_change on public.quadratic_bank_reconciliations
 for update to authenticated using(public.quadratic_can(subsidiary_id,'BANK_QUADRATIC_MANAGE'))
 with check(public.quadratic_can(subsidiary_id,'BANK_QUADRATIC_MANAGE'));
create policy quadratic_reconciliation_remove on public.quadratic_bank_reconciliations
 for delete to authenticated using(status='draft'and public.quadratic_can(subsidiary_id,'BANK_QUADRATIC_MANAGE'));

create policy quadratic_items_read on public.quadratic_reconciliation_items
 for select to authenticated using(exists(select 1 from public.quadratic_bank_reconciliations r
  where r.reconciliation_id=quadratic_reconciliation_items.reconciliation_id
    and public.quadratic_can(r.subsidiary_id,'BANK_QUADRATIC_VIEW')));
create policy quadratic_items_write on public.quadratic_reconciliation_items
 for all to authenticated using(exists(select 1 from public.quadratic_bank_reconciliations r
  where r.reconciliation_id=quadratic_reconciliation_items.reconciliation_id and r.status in('draft','in_review')
    and public.quadratic_can(r.subsidiary_id,'BANK_QUADRATIC_MANAGE')))
 with check(exists(select 1 from public.quadratic_bank_reconciliations r
  where r.reconciliation_id=quadratic_reconciliation_items.reconciliation_id and r.status in('draft','in_review')
    and public.quadratic_can(r.subsidiary_id,'BANK_QUADRATIC_MANAGE')));

create policy quadratic_matches_read on public.quadratic_reconciliation_matches
 for select to authenticated using(exists(select 1 from public.quadratic_bank_reconciliations r
  where r.reconciliation_id=quadratic_reconciliation_matches.reconciliation_id
    and public.quadratic_can(r.subsidiary_id,'BANK_QUADRATIC_VIEW')));
create policy quadratic_matches_write on public.quadratic_reconciliation_matches
 for all to authenticated using(exists(select 1 from public.quadratic_bank_reconciliations r
  where r.reconciliation_id=quadratic_reconciliation_matches.reconciliation_id and r.status in('draft','in_review')
    and public.quadratic_can(r.subsidiary_id,'BANK_QUADRATIC_MANAGE')))
 with check(exists(select 1 from public.quadratic_bank_reconciliations r
  where r.reconciliation_id=quadratic_reconciliation_matches.reconciliation_id and r.status in('draft','in_review')
    and public.quadratic_can(r.subsidiary_id,'BANK_QUADRATIC_MANAGE')));

create policy quadratic_history_read on public.quadratic_reconciliation_history
 for select to authenticated using(exists(select 1 from public.quadratic_bank_reconciliations r
  where r.reconciliation_id=quadratic_reconciliation_history.reconciliation_id
    and public.quadratic_can(r.subsidiary_id,'BANK_QUADRATIC_VIEW')));

create or replace function public.quadratic_touch_updated_at()returns trigger
language plpgsql set search_path=public,pg_temp as $$begin new.updated_at:=now();return new;end$$;

drop trigger if exists quadratic_reconciliation_touch on public.quadratic_bank_reconciliations;
create trigger quadratic_reconciliation_touch before update on public.quadratic_bank_reconciliations
for each row execute function public.quadratic_touch_updated_at();
drop trigger if exists quadratic_item_touch on public.quadratic_reconciliation_items;
create trigger quadratic_item_touch before update on public.quadratic_reconciliation_items
for each row execute function public.quadratic_touch_updated_at();

create or replace function public.quadratic_validate_header()returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if not exists(select 1 from public.bank_account b where b.bank_account_id=new.bank_account_id and b.subsidiary_id=new.subsidiary_id)then
  raise exception 'La cuenta bancaria no pertenece a la subsidiaria seleccionada.';
 end if;
 if tg_op='UPDATE'and old.status='closed'and new is distinct from old then
  raise exception 'La conciliacion cuadratica esta cerrada y es inmutable.';
 end if;
 return new;
end$$;
drop trigger if exists quadratic_reconciliation_validate on public.quadratic_bank_reconciliations;
create trigger quadratic_reconciliation_validate before insert or update on public.quadratic_bank_reconciliations
for each row execute function public.quadratic_validate_header();

create or replace function public.quadratic_validate_item()returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.quadratic_bank_reconciliations%rowtype;expected_side text;
begin
 select * into r from public.quadratic_bank_reconciliations where reconciliation_id=coalesce(new.reconciliation_id,old.reconciliation_id);
 if r.reconciliation_id is null then raise exception 'La conciliacion cuadratica no existe.';end if;
 if r.status not in('draft','in_review')then raise exception 'Las partidas solo se modifican en borrador o revision.';end if;
 if tg_op='DELETE'then return old;end if;
 expected_side:=case when new.item_type in('DEPOSIT_IN_TRANSIT_PRIOR','DEPOSIT_IN_TRANSIT_CURRENT','OUTSTANDING_CHECK_PRIOR','OUTSTANDING_CHECK_CURRENT','BANK_ERROR')then'BANK'else'BOOK'end;
 if new.adjustment_side<>expected_side then raise exception 'El lado del ajuste no corresponde al tipo de partida.';end if;
 if abs((new.impact_start_balance+new.impact_receipts-new.impact_disbursements)-new.impact_end_balance)>=0.000001 then
  raise exception 'Los impactos de la partida no conservan la ecuacion Saldo inicial + Ingresos - Egresos = Saldo final.';
 end if;
 if new.bank_tran_id is not null and not exists(select 1 from public.bank_transaction b where b.bank_tran_id=new.bank_tran_id and b.bank_account_id=r.bank_account_id)then
  raise exception 'El movimiento contable pertenece a otra cuenta bancaria.';
 end if;
 if new.statement_line_id is not null and not exists(select 1 from public.bank_statement_line l join public.bank_statement s using(statement_id)
  where l.statement_line_id=new.statement_line_id and s.bank_account_id=r.bank_account_id)then
  raise exception 'El movimiento del extracto pertenece a otra cuenta bancaria.';
 end if;
 return new;
end$$;
drop trigger if exists quadratic_item_validate on public.quadratic_reconciliation_items;
create trigger quadratic_item_validate before insert or update or delete on public.quadratic_reconciliation_items
for each row execute function public.quadratic_validate_item();

create or replace function public.quadratic_validate_match()returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.quadratic_bank_reconciliations%rowtype;
begin
 select * into r from public.quadratic_bank_reconciliations where reconciliation_id=coalesce(new.reconciliation_id,old.reconciliation_id);
 if r.reconciliation_id is null or r.status not in('draft','in_review')then raise exception 'El punteo no se puede modificar en el estado actual.';end if;
 if tg_op='DELETE'then return old;end if;
 if not exists(select 1 from public.bank_transaction b where b.bank_tran_id=new.bank_tran_id and b.bank_account_id=r.bank_account_id)then raise exception 'El movimiento contable pertenece a otra cuenta bancaria.';end if;
 if not exists(select 1 from public.bank_statement_line l join public.bank_statement s using(statement_id)where l.statement_line_id=new.statement_line_id and s.bank_account_id=r.bank_account_id)then raise exception 'El movimiento del extracto pertenece a otra cuenta bancaria.';end if;
 return new;
end$$;
drop trigger if exists quadratic_match_validate on public.quadratic_reconciliation_matches;
create trigger quadratic_match_validate before insert or update or delete on public.quadratic_reconciliation_matches
for each row execute function public.quadratic_validate_match();

create or replace function public.quadratic_book_values(p_bank_account_id bigint,p_year integer,p_month integer)
returns table(start_balance numeric,receipts numeric,disbursements numeric,end_balance numeric)
language sql stable security definer set search_path=public,pg_temp as $$
 with bounds as(select make_date(p_year,p_month,1)d1,(make_date(p_year,p_month,1)+interval'1 month')::date d2),v as(
  select coalesce(sum(b.amount)filter(where b.tran_date<x.d1),0)::numeric start_balance,
   coalesce(sum(greatest(b.amount,0))filter(where b.tran_date>=x.d1 and b.tran_date<x.d2),0)::numeric receipts,
   coalesce(sum(greatest(-b.amount,0))filter(where b.tran_date>=x.d1 and b.tran_date<x.d2),0)::numeric disbursements
  from bounds x left join public.bank_transaction b on b.bank_account_id=p_bank_account_id and b.tran_date<x.d2 group by x.d1
 )select start_balance,receipts,disbursements,start_balance+receipts-disbursements from v
$$;

create or replace function public.quadratic_refresh_books(p_reconciliation_id bigint)returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.quadratic_bank_reconciliations%rowtype;v record;
begin
 select * into r from public.quadratic_bank_reconciliations where reconciliation_id=p_reconciliation_id for update;
 if r.reconciliation_id is null then raise exception 'Conciliacion cuadratica no encontrada.';end if;
 select * into v from public.quadratic_book_values(r.bank_account_id,r.period_year,r.period_month);
 update public.quadratic_bank_reconciliations set book_start_balance=v.start_balance,book_total_receipts=v.receipts,
  book_total_disbursements=v.disbursements,book_end_balance=v.end_balance where reconciliation_id=r.reconciliation_id;
end$$;

create or replace function public.quadratic_matrix_core(p_reconciliation_id bigint)returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare r public.quadratic_bank_reconciliations%rowtype;v record;
 bs numeric;br numeric;bd numeric;be numeric;ks numeric;kr numeric;kd numeric;ke numeric;
 bas numeric;bar numeric;bad numeric;bae numeric;kas numeric;kar numeric;kad numeric;kae numeric;
 bxs numeric;bxr numeric;bxd numeric;bxe numeric;kxs numeric;kxr numeric;kxd numeric;kxe numeric;
 ds numeric;dr numeric;dd numeric;de numeric;
begin
 select * into r from public.quadratic_bank_reconciliations where reconciliation_id=p_reconciliation_id;
 if r.reconciliation_id is null then raise exception 'Conciliacion cuadratica no encontrada.';end if;
 bs:=r.bank_start_balance;br:=r.bank_total_receipts;bd:=r.bank_total_disbursements;be:=r.bank_end_balance;
 if r.status='closed'then ks:=r.book_start_balance;kr:=r.book_total_receipts;kd:=r.book_total_disbursements;ke:=r.book_end_balance;
 else select * into v from public.quadratic_book_values(r.bank_account_id,r.period_year,r.period_month);ks:=v.start_balance;kr:=v.receipts;kd:=v.disbursements;ke:=v.end_balance;end if;
 select coalesce(sum(impact_start_balance)filter(where adjustment_side='BANK'),0),coalesce(sum(impact_receipts)filter(where adjustment_side='BANK'),0),
  coalesce(sum(impact_disbursements)filter(where adjustment_side='BANK'),0),coalesce(sum(impact_end_balance)filter(where adjustment_side='BANK'),0),
  coalesce(sum(impact_start_balance)filter(where adjustment_side='BOOK'),0),coalesce(sum(impact_receipts)filter(where adjustment_side='BOOK'),0),
  coalesce(sum(impact_disbursements)filter(where adjustment_side='BOOK'),0),coalesce(sum(impact_end_balance)filter(where adjustment_side='BOOK'),0)
 into bas,bar,bad,bae,kas,kar,kad,kae from public.quadratic_reconciliation_items where reconciliation_id=r.reconciliation_id;
 bxs:=bs+bas;bxr:=br+bar;bxd:=bd+bad;bxe:=be+bae;kxs:=ks+kas;kxr:=kr+kar;kxd:=kd+kad;kxe:=ke+kae;
 ds:=bxs-kxs;dr:=bxr-kxr;dd:=bxd-kxd;de:=bxe-kxe;
 return jsonb_build_object(
  'bankBase',jsonb_build_object('startBalance',bs,'receipts',br,'disbursements',bd,'endBalance',be),
  'bankAdjustments',jsonb_build_object('startBalance',bas,'receipts',bar,'disbursements',bad,'endBalance',bae),
  'bankAdjusted',jsonb_build_object('startBalance',bxs,'receipts',bxr,'disbursements',bxd,'endBalance',bxe),
  'bookBase',jsonb_build_object('startBalance',ks,'receipts',kr,'disbursements',kd,'endBalance',ke),
  'bookAdjustments',jsonb_build_object('startBalance',kas,'receipts',kar,'disbursements',kad,'endBalance',kae),
  'bookAdjusted',jsonb_build_object('startBalance',kxs,'receipts',kxr,'disbursements',kxd,'endBalance',kxe),
  'differences',jsonb_build_object('startBalance',ds,'receipts',dr,'disbursements',dd,'endBalance',de),
  'equations',jsonb_build_object('bankBase',bs+br-bd-be,'bankAdjusted',bxs+bxr-bxd-bxe,
    'bookBase',ks+kr-kd-ke,'bookAdjusted',kxs+kxr-kxd-kxe),
  'balanced',round(ds,2)=0 and round(dr,2)=0 and round(dd,2)=0 and round(de,2)=0
    and round(bxs+bxr-bxd-bxe,2)=0 and round(kxs+kxr-kxd-kxe,2)=0
 );
end$$;

create or replace function public.quadratic_continuity(p_reconciliation_id bigint)returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare r public.quadratic_bank_reconciliations%rowtype;p public.quadratic_bank_reconciliations%rowtype;cm jsonb;pm jsonb;expected numeric;actual numeric;diff numeric;
begin
 select * into r from public.quadratic_bank_reconciliations where reconciliation_id=p_reconciliation_id;
 if r.reconciliation_id is null then raise exception 'Conciliacion cuadratica no encontrada.';end if;
 select * into p from public.quadratic_bank_reconciliations where bank_account_id=r.bank_account_id
  and(period_year*12+period_month)=(r.period_year*12+r.period_month-1)and status in('approved','closed')
  order by case status when'closed'then 0 else 1 end,reconciliation_id desc limit 1;
 cm:=public.quadratic_matrix_core(r.reconciliation_id);
 if p.reconciliation_id is null then return jsonb_build_object('required',false,'ok',true,'previousReconciliationId',null,
  'expectedStartBalance',null,'actualStartBalance',cm#>>'{bankAdjusted,startBalance}','difference',0);end if;
 pm:=public.quadratic_matrix_core(p.reconciliation_id);expected:=(pm#>>'{bankAdjusted,endBalance}')::numeric;actual:=(cm#>>'{bankAdjusted,startBalance}')::numeric;diff:=actual-expected;
 return jsonb_build_object('required',true,'ok',round(diff,2)=0,'previousReconciliationId',p.reconciliation_id,
  'expectedStartBalance',expected,'actualStartBalance',actual,'difference',diff);
end$$;

create or replace function public.quadratic_reconciliation_options()returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sid bigint:=public.active_subsidiary_id();
begin
 if not public.quadratic_has_permission('BANK_QUADRATIC_VIEW')then raise exception using errcode='42501',message='No tiene permiso para consultar conciliaciones cuadraticas.';end if;
 return jsonb_build_object(
  'subsidiary',(select jsonb_build_object('id',s.subsidiary_id,'name',s.name)from public.subsidiaries s where s.subsidiary_id=sid),
  'subsidiaries',coalesce((select jsonb_agg(jsonb_build_object('id',s.subsidiary_id,'name',s.name)order by s.name)
   from public.subsidiaries s join public.user_subsidiaries u using(subsidiary_id)where u.user_id=public.app_user_id()and s.is_active),'[]'::jsonb),
  'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',b.bank_account_id,'name',bk.bank_name||' - '||b.account_number,
   'number',b.account_number,'bankName',bk.bank_name,'subsidiaryId',b.subsidiary_id,'currencyCode',c.currency_code,'currencySymbol',c.symbol)
   order by s.name,bk.bank_name,b.account_number)from public.bank_account b join public.banks bk using(bank_id)join public.currencies c using(currency_id)
   join public.subsidiaries s using(subsidiary_id)join public.user_subsidiaries u using(subsidiary_id)
   where u.user_id=public.app_user_id()and b.subsidiary_id=sid),'[]'::jsonb),
  'permissions',jsonb_build_object('view',true,'manage',public.quadratic_has_permission('BANK_QUADRATIC_MANAGE'),'approve',public.quadratic_has_permission('BANK_QUADRATIC_APPROVE')),
  'reconciliations',coalesce((select jsonb_agg(jsonb_build_object('id',r.reconciliation_id,'bankAccountId',r.bank_account_id,
   'subsidiaryId',r.subsidiary_id,'periodYear',r.period_year,'periodMonth',r.period_month,'status',r.status,'updatedAt',r.updated_at)
   order by r.period_year desc,r.period_month desc,r.reconciliation_id desc)from public.quadratic_bank_reconciliations r
   where r.subsidiary_id=sid and public.quadratic_can(r.subsidiary_id,'BANK_QUADRATIC_VIEW')),'[]'::jsonb)
 );
end$$;

create or replace function public.quadratic_reconciliation_list(p_filters jsonb default '{}'::jsonb)returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sid bigint:=nullif(p_filters->>'subsidiaryId','')::bigint;account_key bigint:=nullif(p_filters->>'bankAccountId','')::bigint;
 yr integer:=nullif(p_filters->>'periodYear','')::integer;mo integer:=nullif(p_filters->>'periodMonth','')::integer;
 state text:=nullif(p_filters->>'status','');result jsonb;
begin
 if not public.quadratic_has_permission('BANK_QUADRATIC_VIEW')then raise exception using errcode='42501',message='No tiene permiso para consultar conciliaciones cuadraticas.';end if;
 if sid is null then sid:=public.active_subsidiary_id();end if;
 if sid is not null and not public.quadratic_can(sid,'BANK_QUADRATIC_VIEW')then raise exception using errcode='42501',message='No tiene acceso a la subsidiaria seleccionada.';end if;
 with rows as(select r.*,b.account_number,bk.bank_name,c.currency_code,c.symbol,s.name subsidiary_name
  from public.quadratic_bank_reconciliations r join public.bank_account b using(bank_account_id)join public.banks bk using(bank_id)
  join public.currencies c using(currency_id)join public.subsidiaries s on s.subsidiary_id=r.subsidiary_id
  where public.quadratic_can(r.subsidiary_id,'BANK_QUADRATIC_VIEW')and(sid is null or r.subsidiary_id=sid)
   and(account_key is null or r.bank_account_id=account_key)and(yr is null or r.period_year=yr)
   and(mo is null or r.period_month=mo)and(state is null or r.status=state))
 select jsonb_build_object('rows',coalesce(jsonb_agg(jsonb_build_object('id',reconciliation_id,'subsidiaryId',subsidiary_id,
  'subsidiaryName',subsidiary_name,'bankAccountId',bank_account_id,'accountNumber',account_number,'bankName',bank_name,
  'currencyCode',currency_code,'currencySymbol',symbol,'periodYear',period_year,'periodMonth',period_month,'status',status,
  'bankEndBalance',bank_end_balance,'bookEndBalance',book_end_balance,'updatedAt',updated_at)
  order by period_year desc,period_month desc,reconciliation_id desc),'[]'::jsonb),'total',count(*))into result from rows;
 return result;
end$$;

create or replace function public.quadratic_reconciliation_get(p_reconciliation_id bigint)returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare r public.quadratic_bank_reconciliations%rowtype;matrix jsonb;continuity jsonb;d1 date;d2 date;statement_key bigint;
begin
 select * into r from public.quadratic_bank_reconciliations where reconciliation_id=p_reconciliation_id;
 if r.reconciliation_id is null or not public.quadratic_can(r.subsidiary_id,'BANK_QUADRATIC_VIEW')then raise exception using errcode='42501',message='Conciliacion cuadratica no encontrada o no autorizada.';end if;
 d1:=make_date(r.period_year,r.period_month,1);d2:=(d1+interval'1 month')::date;
 select statement_id into statement_key from public.bank_statement where bank_account_id=r.bank_account_id and statement_date>=d1 and statement_date<d2 order by statement_date desc,statement_id desc limit 1;
 matrix:=public.quadratic_matrix_core(r.reconciliation_id);continuity:=public.quadratic_continuity(r.reconciliation_id);matrix:=matrix||jsonb_build_object('continuity',continuity);
 return jsonb_build_object(
  'header',(select jsonb_build_object('id',r.reconciliation_id,'subsidiaryId',r.subsidiary_id,'subsidiaryName',s.name,
   'subsidiaryLegalName',coalesce(nullif(s.legal_name,''),s.name),'taxId',s.tax_id,'logoUrl',s.logo_url,
   'bankAccountId',r.bank_account_id,'accountNumber',b.account_number,'bankAccountNumber',b.account_number,'bankName',bk.bank_name,
   'ledgerAccountNumber',ca.account_number,'ledgerAccountName',ca.account_name,'currencyCode',c.currency_code,'currencySymbol',c.symbol,
   'periodYear',r.period_year,'periodMonth',r.period_month,'bankStartBalance',r.bank_start_balance,'bankTotalReceipts',r.bank_total_receipts,
   'bankTotalDisbursements',r.bank_total_disbursements,'bankEndBalance',r.bank_end_balance,'status',r.status,'notes',r.notes,
   'createdBy',r.created_by,'reconciledBy',r.reconciled_by,'approvedBy',r.approved_by,'closedBy',r.closed_by,
   'reconciledByName',(select coalesce(nullif(concat_ws(' ',u.first_name,u.last_name),''),u.email)from public.users u where u.user_id=r.reconciled_by),
   'approvedByName',(select coalesce(nullif(concat_ws(' ',u.first_name,u.last_name),''),u.email)from public.users u where u.user_id=r.approved_by),
   'closedByName',(select coalesce(nullif(concat_ws(' ',u.first_name,u.last_name),''),u.email)from public.users u where u.user_id=r.closed_by),
   'approvedAt',r.approved_at,'closedAt',r.closed_at,'createdAt',r.created_at,'updatedAt',r.updated_at)
   from public.bank_account b join public.banks bk using(bank_id)join public.currencies c using(currency_id)join public.chart_accounts ca using(account_id)
   join public.subsidiaries s on s.subsidiary_id=r.subsidiary_id where b.bank_account_id=r.bank_account_id),
  'matrix',matrix,'continuity',continuity,
  'items',coalesce((select jsonb_agg(jsonb_build_object('id',i.item_id,'itemType',i.item_type,'adjustmentSide',i.adjustment_side,
   'sourceKind',i.source_kind,'description',i.description,'referenceNumber',i.reference_number,'transactionDate',i.transaction_date,
   'amount',i.amount,'impactStartBalance',i.impact_start_balance,'impactReceipts',i.impact_receipts,
   'impactDisbursements',i.impact_disbursements,'impactEndBalance',i.impact_end_balance,'bankTransactionId',i.bank_tran_id,
   'statementLineId',i.statement_line_id,'originItemId',i.origin_item_id)order by i.transaction_date,i.item_id)
   from public.quadratic_reconciliation_items i where i.reconciliation_id=r.reconciliation_id),'[]'::jsonb),
  'matches',coalesce((select jsonb_agg(jsonb_build_object('id',m.match_id,'bankTransactionId',m.bank_tran_id,
   'statementLineId',m.statement_line_id,'matchType',m.match_type,'matchedBy',m.matched_by,'matchedAt',m.matched_at)
   order by m.matched_at,m.match_id)from public.quadratic_reconciliation_matches m where m.reconciliation_id=r.reconciliation_id),'[]'::jsonb),
  'statementLines',coalesce((select jsonb_agg(jsonb_build_object('id',l.statement_line_id,'date',l.bank_date,'valueDate',l.value_date,
   'reference',l.reference,'description',l.description,'beneficiary',l.beneficiary,'amount',l.amount,'matchId',m.match_id)
   order by l.bank_date,l.statement_line_id)from public.bank_statement_line l left join public.quadratic_reconciliation_matches m
   on m.reconciliation_id=r.reconciliation_id and m.statement_line_id=l.statement_line_id where l.statement_id=statement_key),'[]'::jsonb),
  'bookTransactions',coalesce((select jsonb_agg(jsonb_build_object('id',b.bank_tran_id,'date',b.tran_date,'valueDate',b.value_date,
   'reference',b.reference_number,'description',b.description,'beneficiary',b.beneficiary,'amount',b.amount,'matchId',m.match_id)
   order by b.tran_date,b.bank_tran_id)from public.bank_transaction b left join public.quadratic_reconciliation_matches m
   on m.reconciliation_id=r.reconciliation_id and m.bank_tran_id=b.bank_tran_id
   where b.bank_account_id=r.bank_account_id and b.tran_date>=d1 and b.tran_date<d2),'[]'::jsonb),
  'history',coalesce((select jsonb_agg(jsonb_build_object('id',h.history_id,'priorStatus',h.prior_status,'newStatus',h.new_status,
   'changedBy',h.changed_by,'details',h.details,'changedAt',h.changed_at)order by h.changed_at,h.history_id)
   from public.quadratic_reconciliation_history h where h.reconciliation_id=r.reconciliation_id),'[]'::jsonb),
  'permissions',jsonb_build_object('manage',public.quadratic_has_permission('BANK_QUADRATIC_MANAGE'),'approve',public.quadratic_has_permission('BANK_QUADRATIC_APPROVE'))
 );
end$$;

create or replace function public.quadratic_reconciliation_save(p_payload jsonb)returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare key bigint:=nullif(p_payload->>'id','')::bigint;r public.quadratic_bank_reconciliations%rowtype;b public.bank_account%rowtype;
 yr integer;mo integer;d1 date;d2 date;statement_row public.bank_statement%rowtype;created boolean:=false;prior_id bigint;uid bigint:=public.app_user_id();
 bank_start numeric;bank_receipts numeric;bank_disbursements numeric;bank_end numeric;
begin
 if uid is null then raise exception using errcode='42501',message='Sesion no identificada.';end if;
 if key is not null then select * into r from public.quadratic_bank_reconciliations where reconciliation_id=key for update;
  if r.reconciliation_id is null then raise exception 'Conciliacion cuadratica no encontrada.';end if;
  if not public.quadratic_can(r.subsidiary_id,'BANK_QUADRATIC_MANAGE')then raise exception using errcode='42501',message='No tiene permiso para modificar esta conciliacion.';end if;
  if r.status not in('draft','in_review')then raise exception 'La conciliacion aprobada o cerrada no admite cambios.';end if;
  select * into b from public.bank_account where bank_account_id=r.bank_account_id;yr:=r.period_year;mo:=r.period_month;
 else
  select * into b from public.bank_account where bank_account_id=nullif(p_payload->>'bankAccountId','')::bigint;
  yr:=nullif(p_payload->>'periodYear','')::integer;mo:=nullif(p_payload->>'periodMonth','')::integer;
  if b.bank_account_id is null or yr not between 1900 and 2200 or mo not between 1 and 12 then raise exception 'Seleccione cuenta bancaria, anio y mes validos.';end if;
  if not public.quadratic_can(b.subsidiary_id,'BANK_QUADRATIC_MANAGE')then raise exception using errcode='42501',message='No tiene permiso para crear conciliaciones en esta subsidiaria.';end if;
  select * into r from public.quadratic_bank_reconciliations where bank_account_id=b.bank_account_id and period_year=yr and period_month=mo for update;
  if r.reconciliation_id is not null then key:=r.reconciliation_id;if r.status not in('draft','in_review')then raise exception 'La conciliacion del periodo ya esta aprobada o cerrada.';end if;
  else created:=true;end if;
 end if;
 d1:=make_date(yr,mo,1);d2:=(d1+interval'1 month')::date;
 select * into statement_row from public.bank_statement where bank_account_id=b.bank_account_id and statement_date>=d1 and statement_date<d2 order by statement_date desc,statement_id desc limit 1;
 bank_start:=coalesce(nullif(p_payload->>'bankStartBalance','')::numeric,case when not created then r.bank_start_balance end,statement_row.opening_balance,0);
 bank_receipts:=coalesce(nullif(p_payload->>'bankTotalReceipts','')::numeric,case when not created then r.bank_total_receipts end,
  (select sum(greatest(amount,0))from public.bank_statement_line where statement_id=statement_row.statement_id),0);
 bank_disbursements:=coalesce(nullif(p_payload->>'bankTotalDisbursements','')::numeric,case when not created then r.bank_total_disbursements end,
  (select sum(greatest(-amount,0))from public.bank_statement_line where statement_id=statement_row.statement_id),0);
 bank_end:=coalesce(nullif(p_payload->>'bankEndBalance','')::numeric,case when not created then r.bank_end_balance end,statement_row.closing_balance,0);
 if bank_receipts<0 or bank_disbursements<0 then raise exception 'Los ingresos y egresos del banco no pueden ser negativos.';end if;
 if created then
  select reconciliation_id into prior_id from public.quadratic_bank_reconciliations where bank_account_id=b.bank_account_id
   and(period_year*12+period_month)=(yr*12+mo-1)and status in('approved','closed')order by case status when'closed'then 0 else 1 end,reconciliation_id desc limit 1;
  insert into public.quadratic_bank_reconciliations(subsidiary_id,bank_account_id,period_year,period_month,bank_start_balance,
   bank_total_receipts,bank_total_disbursements,bank_end_balance,previous_reconciliation_id,notes,created_by)
  values(b.subsidiary_id,b.bank_account_id,yr,mo,bank_start,bank_receipts,bank_disbursements,bank_end,prior_id,nullif(trim(p_payload->>'notes'),''),uid)
  returning reconciliation_id into key;
  insert into public.quadratic_reconciliation_history(reconciliation_id,prior_status,new_status,changed_by,details)
   values(key,null,'draft',uid,jsonb_build_object('event','created'));
  if prior_id is not null then
   insert into public.quadratic_reconciliation_items(reconciliation_id,bank_tran_id,statement_line_id,origin_item_id,item_type,
    adjustment_side,source_kind,description,reference_number,transaction_date,amount,impact_start_balance,impact_receipts,
    impact_disbursements,impact_end_balance,created_by)
   select key,i.bank_tran_id,null,i.item_id,
    case i.item_type when'DEPOSIT_IN_TRANSIT_CURRENT'then'DEPOSIT_IN_TRANSIT_PRIOR'else'OUTSTANDING_CHECK_PRIOR'end,
    'BANK','CARRY_FORWARD',i.description,i.reference_number,i.transaction_date,i.amount,
    case i.item_type when'DEPOSIT_IN_TRANSIT_CURRENT'then i.amount else-i.amount end,
    case i.item_type when'DEPOSIT_IN_TRANSIT_CURRENT'then-i.amount else 0 end,
    case i.item_type when'OUTSTANDING_CHECK_CURRENT'then-i.amount else 0 end,0,uid
   from public.quadratic_reconciliation_items i where i.reconciliation_id=prior_id
    and i.item_type in('DEPOSIT_IN_TRANSIT_CURRENT','OUTSTANDING_CHECK_CURRENT');
  end if;
 else
  update public.quadratic_bank_reconciliations set bank_start_balance=bank_start,bank_total_receipts=bank_receipts,
   bank_total_disbursements=bank_disbursements,bank_end_balance=bank_end,
   notes=case when p_payload?'notes'then nullif(trim(p_payload->>'notes'),'')else notes end where reconciliation_id=key;
 end if;
 perform public.quadratic_refresh_books(key);
 return jsonb_build_object('success',true,'id',key,'created',created,'result',public.quadratic_reconciliation_get(key));
end$$;

create or replace function public.quadratic_reconciliation_item_save(p_reconciliation_id bigint,p_item jsonb)returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.quadratic_bank_reconciliations%rowtype;key bigint:=nullif(p_item->>'id','')::bigint;kind text:=upper(trim(p_item->>'itemType'));
 side text;amt numeric:=coalesce(nullif(p_item->>'amount','')::numeric,0);is0 numeric:=0;ir numeric:=0;idisb numeric:=0;ie numeric:=0;
begin
 select * into r from public.quadratic_bank_reconciliations where reconciliation_id=p_reconciliation_id for update;
 if r.reconciliation_id is null or not public.quadratic_can(r.subsidiary_id,'BANK_QUADRATIC_MANAGE')then raise exception using errcode='42501',message='Conciliacion no encontrada o no autorizada.';end if;
 if r.status not in('draft','in_review')then raise exception 'Las partidas solo se modifican en borrador o revision.';end if;
 if kind not in('DEPOSIT_IN_TRANSIT_PRIOR','DEPOSIT_IN_TRANSIT_CURRENT','OUTSTANDING_CHECK_PRIOR','OUTSTANDING_CHECK_CURRENT','UNRECORDED_BANK_CHARGE','UNRECORDED_BANK_CREDIT','BOOK_ERROR','BANK_ERROR')then raise exception 'Tipo de partida no valido.';end if;
 side:=case when kind in('DEPOSIT_IN_TRANSIT_PRIOR','DEPOSIT_IN_TRANSIT_CURRENT','OUTSTANDING_CHECK_PRIOR','OUTSTANDING_CHECK_CURRENT','BANK_ERROR')then'BANK'else'BOOK'end;
 if kind='DEPOSIT_IN_TRANSIT_CURRENT'then ir:=amt;ie:=amt;
 elsif kind='DEPOSIT_IN_TRANSIT_PRIOR'then is0:=amt;ir:=-amt;
 elsif kind='OUTSTANDING_CHECK_CURRENT'then idisb:=amt;ie:=-amt;
 elsif kind='OUTSTANDING_CHECK_PRIOR'then is0:=-amt;idisb:=-amt;
 elsif kind='UNRECORDED_BANK_CHARGE'then idisb:=amt;ie:=-amt;
 elsif kind='UNRECORDED_BANK_CREDIT'then ir:=amt;ie:=amt;
 else
  is0:=coalesce(nullif(p_item->>'impactStartBalance','')::numeric,0);ir:=coalesce(nullif(p_item->>'impactReceipts','')::numeric,0);
  idisb:=coalesce(nullif(p_item->>'impactDisbursements','')::numeric,0);ie:=coalesce(nullif(p_item->>'impactEndBalance','')::numeric,0);
  if amt=0 then amt:=greatest(abs(is0),abs(ir),abs(idisb),abs(ie));end if;
 end if;
 if amt<0 then raise exception 'El monto de la partida no puede ser negativo.';end if;
 if coalesce(length(trim(p_item->>'description')),0)=0 then raise exception 'La descripcion de la partida es obligatoria.';end if;
 if nullif(p_item->>'transactionDate','')::date is null then raise exception 'La fecha de la partida es obligatoria.';end if;
 if nullif(p_item->>'bankTransactionId','')::bigint is not null and exists(select 1 from public.quadratic_reconciliation_matches where reconciliation_id=p_reconciliation_id and bank_tran_id=(p_item->>'bankTransactionId')::bigint)then raise exception 'El movimiento contable ya esta punteado.';end if;
 if nullif(p_item->>'statementLineId','')::bigint is not null and exists(select 1 from public.quadratic_reconciliation_matches where reconciliation_id=p_reconciliation_id and statement_line_id=(p_item->>'statementLineId')::bigint)then raise exception 'El movimiento del extracto ya esta punteado.';end if;
 if key is null then
  insert into public.quadratic_reconciliation_items(reconciliation_id,bank_tran_id,statement_line_id,item_type,adjustment_side,source_kind,
   description,reference_number,transaction_date,amount,impact_start_balance,impact_receipts,impact_disbursements,impact_end_balance,created_by)
  values(p_reconciliation_id,nullif(p_item->>'bankTransactionId','')::bigint,nullif(p_item->>'statementLineId','')::bigint,kind,side,
   coalesce(nullif(p_item->>'sourceKind',''),'MANUAL'),trim(p_item->>'description'),nullif(trim(p_item->>'referenceNumber'),''),
   (p_item->>'transactionDate')::date,amt,is0,ir,idisb,ie,public.app_user_id())returning item_id into key;
 else
  update public.quadratic_reconciliation_items set bank_tran_id=nullif(p_item->>'bankTransactionId','')::bigint,
   statement_line_id=nullif(p_item->>'statementLineId','')::bigint,item_type=kind,adjustment_side=side,source_kind=coalesce(nullif(p_item->>'sourceKind',''),source_kind),
   description=trim(p_item->>'description'),reference_number=nullif(trim(p_item->>'referenceNumber'),''),transaction_date=(p_item->>'transactionDate')::date,
   amount=amt,impact_start_balance=is0,impact_receipts=ir,impact_disbursements=idisb,impact_end_balance=ie,updated_by=public.app_user_id()
  where item_id=key and reconciliation_id=p_reconciliation_id;
  if not found then raise exception 'Partida de conciliacion no encontrada.';end if;
 end if;
 return jsonb_build_object('success',true,'id',key,'matrix',public.quadratic_matrix_core(p_reconciliation_id));
end$$;

create or replace function public.quadratic_reconciliation_item_delete(p_reconciliation_id bigint,p_item_id bigint)returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.quadratic_bank_reconciliations%rowtype;begin
 select * into r from public.quadratic_bank_reconciliations where reconciliation_id=p_reconciliation_id for update;
 if r.reconciliation_id is null or not public.quadratic_can(r.subsidiary_id,'BANK_QUADRATIC_MANAGE')then raise exception using errcode='42501',message='Conciliacion no encontrada o no autorizada.';end if;
 if r.status not in('draft','in_review')then raise exception 'Las partidas solo se eliminan en borrador o revision.';end if;
 delete from public.quadratic_reconciliation_items where reconciliation_id=p_reconciliation_id and item_id=p_item_id;
 if not found then raise exception 'Partida de conciliacion no encontrada.';end if;
 return jsonb_build_object('success',true,'id',p_item_id,'matrix',public.quadratic_matrix_core(p_reconciliation_id));
end$$;

create or replace function public.quadratic_reconciliation_match(p_reconciliation_id bigint,p_bank_tran_id bigint,p_statement_line_id bigint)returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.quadratic_bank_reconciliations%rowtype;bt public.bank_transaction%rowtype;sl public.bank_statement_line%rowtype;key bigint;
begin
 select * into r from public.quadratic_bank_reconciliations where reconciliation_id=p_reconciliation_id for update;
 if r.reconciliation_id is null or not public.quadratic_can(r.subsidiary_id,'BANK_QUADRATIC_MANAGE')then raise exception using errcode='42501',message='Conciliacion no encontrada o no autorizada.';end if;
 if r.status not in('draft','in_review')then raise exception 'El punteo solo se modifica en borrador o revision.';end if;
 select * into bt from public.bank_transaction where bank_tran_id=p_bank_tran_id and bank_account_id=r.bank_account_id;
 select l.* into sl from public.bank_statement_line l join public.bank_statement s using(statement_id)where l.statement_line_id=p_statement_line_id and s.bank_account_id=r.bank_account_id;
 if bt.bank_tran_id is null or sl.statement_line_id is null then raise exception 'Seleccione movimientos de la misma cuenta bancaria.';end if;
 if round(bt.amount-sl.amount,2)<>0 then raise exception 'Los importes seleccionados no coinciden.';end if;
 if exists(select 1 from public.quadratic_reconciliation_items where reconciliation_id=p_reconciliation_id and(bank_tran_id=p_bank_tran_id or statement_line_id=p_statement_line_id))then raise exception 'Una partida de ajuste ya utiliza uno de los movimientos.';end if;
 insert into public.quadratic_reconciliation_matches(reconciliation_id,bank_tran_id,statement_line_id,match_type,matched_by)
 values(p_reconciliation_id,p_bank_tran_id,p_statement_line_id,'MANUAL',public.app_user_id())returning match_id into key;
 return jsonb_build_object('success',true,'id',key);
end$$;

create or replace function public.quadratic_reconciliation_unmatch(p_reconciliation_id bigint,p_match_id bigint)returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.quadratic_bank_reconciliations%rowtype;begin
 select * into r from public.quadratic_bank_reconciliations where reconciliation_id=p_reconciliation_id for update;
 if r.reconciliation_id is null or not public.quadratic_can(r.subsidiary_id,'BANK_QUADRATIC_MANAGE')then raise exception using errcode='42501',message='Conciliacion no encontrada o no autorizada.';end if;
 if r.status not in('draft','in_review')then raise exception 'El punteo solo se modifica en borrador o revision.';end if;
 delete from public.quadratic_reconciliation_matches where reconciliation_id=p_reconciliation_id and match_id=p_match_id;
 if not found then raise exception 'Punteo no encontrado.';end if;
 return jsonb_build_object('success',true,'id',p_match_id);
end$$;

create or replace function public.quadratic_reconciliation_auto_match(p_reconciliation_id bigint,p_tolerance_days integer default 3)returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.quadratic_bank_reconciliations%rowtype;row_value record;matched integer:=0;d1 date;d2 date;
begin
 if p_tolerance_days not between 0 and 31 then raise exception 'La tolerancia debe estar entre 0 y 31 dias.';end if;
 select * into r from public.quadratic_bank_reconciliations where reconciliation_id=p_reconciliation_id for update;
 if r.reconciliation_id is null or not public.quadratic_can(r.subsidiary_id,'BANK_QUADRATIC_MANAGE')then raise exception using errcode='42501',message='Conciliacion no encontrada o no autorizada.';end if;
 if r.status not in('draft','in_review')then raise exception 'El punteo solo se modifica en borrador o revision.';end if;
 d1:=make_date(r.period_year,r.period_month,1);d2:=(d1+interval'1 month')::date;
 for row_value in
  select bt.bank_tran_id,sl.statement_line_id from public.bank_transaction bt
  join lateral(select sl.statement_line_id from public.bank_statement s join public.bank_statement_line sl using(statement_id)
   where s.bank_account_id=r.bank_account_id and s.statement_date>=d1 and s.statement_date<d2
    and abs(sl.amount-bt.amount)<.005 and abs(sl.bank_date-bt.tran_date)<=p_tolerance_days
    and nullif(lower(trim(sl.reference)),'')=nullif(lower(trim(bt.reference_number)),'')
    and not exists(select 1 from public.quadratic_reconciliation_matches m where m.reconciliation_id=r.reconciliation_id and m.statement_line_id=sl.statement_line_id)
    and not exists(select 1 from public.quadratic_reconciliation_items i where i.reconciliation_id=r.reconciliation_id and i.statement_line_id=sl.statement_line_id)
   order by abs(sl.bank_date-bt.tran_date),sl.statement_line_id limit 1)sl on true
  where bt.bank_account_id=r.bank_account_id and bt.tran_date>=d1 and bt.tran_date<d2
   and nullif(trim(bt.reference_number),'')is not null
   and not exists(select 1 from public.quadratic_reconciliation_matches m where m.reconciliation_id=r.reconciliation_id and m.bank_tran_id=bt.bank_tran_id)
   and not exists(select 1 from public.quadratic_reconciliation_items i where i.reconciliation_id=r.reconciliation_id and i.bank_tran_id=bt.bank_tran_id)
  order by bt.tran_date,bt.bank_tran_id
 loop
  begin
   insert into public.quadratic_reconciliation_matches(reconciliation_id,bank_tran_id,statement_line_id,match_type,matched_by)
    values(r.reconciliation_id,row_value.bank_tran_id,row_value.statement_line_id,'AUTOMATIC',public.app_user_id());matched:=matched+1;
  exception when unique_violation then null;end;
 end loop;
 return jsonb_build_object('success',true,'matched',matched);
end$$;

create or replace function public.quadratic_reconciliation_transition(p_id bigint,p_status text)returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.quadratic_bank_reconciliations%rowtype;target text:=lower(trim(p_status));matrix jsonb;continuity jsonb;prior text;uid bigint:=public.app_user_id();
begin
 select * into r from public.quadratic_bank_reconciliations where reconciliation_id=p_id for update;
 if r.reconciliation_id is null then raise exception 'Conciliacion cuadratica no encontrada.';end if;
 if target in('submit','review','in_review')then target:='in_review';
 elsif target in('return','draft')then target:='draft';
 elsif target in('approve','approved')then target:='approved';
 elsif target in('close','closed')then target:='closed';
 elsif target='reopen'then target:='in_review';else raise exception 'Transicion de estado no valida.';end if;
 if target in('approved','closed')then
  if not public.quadratic_can(r.subsidiary_id,'BANK_QUADRATIC_APPROVE')then raise exception using errcode='42501',message='No tiene permiso para aprobar o cerrar conciliaciones cuadraticas.';end if;
 else
  if not public.quadratic_can(r.subsidiary_id,'BANK_QUADRATIC_MANAGE')then raise exception using errcode='42501',message='No tiene permiso para preparar esta conciliacion.';end if;
 end if;
 if r.status='closed'then raise exception 'Una conciliacion cerrada no se puede reabrir ni modificar.';
 elsif target='in_review'and r.status not in('draft','approved')then raise exception 'Solo un borrador se envia a revision o una aprobada se reabre.';
 elsif target='draft'and r.status<>'in_review'then raise exception 'Solo una conciliacion en revision puede devolverse a borrador.';
 elsif target='approved'and r.status<>'in_review'then raise exception 'Solo una conciliacion en revision puede aprobarse.';
 elsif target='closed'and r.status<>'approved'then raise exception 'Solo una conciliacion aprobada puede cerrarse.';end if;
 if target in('approved','closed')then
  perform public.quadratic_refresh_books(r.reconciliation_id);matrix:=public.quadratic_matrix_core(r.reconciliation_id);continuity:=public.quadratic_continuity(r.reconciliation_id);
  if not coalesce((matrix->>'balanced')::boolean,false)then raise exception 'Las cuatro columnas deben quedar en 0.00 antes de aprobar o cerrar.';end if;
  if not coalesce((continuity->>'ok')::boolean,false)then raise exception 'El saldo inicial ajustado no coincide con el saldo final ajustado del mes anterior.';end if;
 end if;
 prior:=r.status;
 update public.quadratic_bank_reconciliations set status=target,
  reconciled_by=case when target='in_review'then uid else reconciled_by end,
  approved_by=case when target='approved'then uid when target='in_review'and prior='approved'then null else approved_by end,
  approved_at=case when target='approved'then now()when target='in_review'and prior='approved'then null else approved_at end,
  closed_by=case when target='closed'then uid else closed_by end,closed_at=case when target='closed'then now()else closed_at end
 where reconciliation_id=r.reconciliation_id;
 insert into public.quadratic_reconciliation_history(reconciliation_id,prior_status,new_status,changed_by,details)
 values(r.reconciliation_id,prior,target,uid,jsonb_build_object('matrix',coalesce(matrix,public.quadratic_matrix_core(r.reconciliation_id))));
 return jsonb_build_object('success',true,'id',r.reconciliation_id,'status',target,'result',public.quadratic_reconciliation_get(r.reconciliation_id));
end$$;

-- Un cierre cuadratico bloquea cualquier alta, cambio o eliminacion retroactiva
-- de movimientos del libro bancario en ese periodo.
create or replace function public.prevent_closed_quadratic_bank_transaction()returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare old_locked boolean:=false;new_locked boolean:=false;
begin
 if tg_op<>'INSERT'then select exists(select 1 from public.quadratic_bank_reconciliations r where r.bank_account_id=old.bank_account_id
  and r.period_year=extract(year from old.tran_date)::integer and r.period_month=extract(month from old.tran_date)::integer and r.status='closed')into old_locked;end if;
 if tg_op<>'DELETE'then select exists(select 1 from public.quadratic_bank_reconciliations r where r.bank_account_id=new.bank_account_id
  and r.period_year=extract(year from new.tran_date)::integer and r.period_month=extract(month from new.tran_date)::integer and r.status='closed')into new_locked;end if;
 if old_locked or new_locked then raise exception 'El movimiento pertenece a un periodo cerrado por una conciliacion cuadratica.';end if;
 return case when tg_op='DELETE'then old else new end;
end$$;
drop trigger if exists prevent_closed_quadratic_bank_transaction on public.bank_transaction;
create trigger prevent_closed_quadratic_bank_transaction before insert or update or delete on public.bank_transaction
for each row execute function public.prevent_closed_quadratic_bank_transaction();

revoke all on public.quadratic_bank_reconciliations,public.quadratic_reconciliation_items,
 public.quadratic_reconciliation_matches,public.quadratic_reconciliation_history from public,anon,authenticated;

do $$declare f record;begin
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname like'quadratic_%'
 loop execute format('revoke all on function %s from public,anon,authenticated',f.signature);end loop;
end$$;

grant execute on function public.quadratic_reconciliation_options(),public.quadratic_reconciliation_list(jsonb),
 public.quadratic_reconciliation_get(bigint),public.quadratic_reconciliation_save(jsonb),
 public.quadratic_reconciliation_item_save(bigint,jsonb),public.quadratic_reconciliation_item_delete(bigint,bigint),
 public.quadratic_reconciliation_match(bigint,bigint,bigint),public.quadratic_reconciliation_unmatch(bigint,bigint),
 public.quadratic_reconciliation_auto_match(bigint,integer),public.quadratic_reconciliation_transition(bigint,text)
to authenticated;

notify pgrst,'reload schema';
