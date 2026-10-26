-- Aisla el catalogo de extractos bancarios por la subsidiaria activa. Un
-- usuario puede estar asignado a varias empresas, pero el catalogo solo debe
-- exponer la empresa seleccionada en la sesion actual.

create or replace function public.bank_statement_in_active_subsidiary(
  p_statement_id bigint
) returns boolean
language sql
stable
security definer
set search_path=public,pg_temp
as $$
  select exists(
    select 1
    from public.bank_statement statement
    join public.bank_account account using(bank_account_id)
    where statement.statement_id=p_statement_id
      and account.subsidiary_id=public.active_subsidiary_id()
  )
$$;

revoke all on function public.bank_statement_in_active_subsidiary(bigint)
  from public,anon;
grant execute on function public.bank_statement_in_active_subsidiary(bigint)
  to authenticated,service_role;

alter table public.bank_statement enable row level security;

drop policy if exists banking_select on public.bank_statement;
drop policy if exists banking_insert on public.bank_statement;
drop policy if exists banking_update on public.bank_statement;
drop policy if exists banking_delete on public.bank_statement;
-- Estas politicas fueron creadas por el endurecimiento generico de alcance
-- empresarial. Incluyen un OR para Administrador y, al ser permisivas, podrian
-- ampliar las nuevas reglas aunque las politicas especificas sean correctas.
drop policy if exists company_select on public.bank_statement;
drop policy if exists company_insert on public.bank_statement;
drop policy if exists company_update on public.bank_statement;
drop policy if exists company_delete on public.bank_statement;
drop policy if exists bank_statement_select_active_subsidiary on public.bank_statement;
drop policy if exists bank_statement_insert_active_subsidiary on public.bank_statement;
drop policy if exists bank_statement_update_active_subsidiary on public.bank_statement;
drop policy if exists bank_statement_delete_active_subsidiary on public.bank_statement;

create policy bank_statement_select_active_subsidiary
on public.bank_statement
for select
to authenticated
using(
  public.security_resource_allowed('banking:bank-statements','view')
  and exists(
    select 1
    from public.bank_account account
    where account.bank_account_id=bank_statement.bank_account_id
      and account.subsidiary_id=public.active_subsidiary_id()
  )
);

create policy bank_statement_insert_active_subsidiary
on public.bank_statement
for insert
to authenticated
with check(
  public.security_resource_allowed('banking:bank-statements','create')
  and exists(
    select 1
    from public.bank_account account
    where account.bank_account_id=bank_statement.bank_account_id
      and account.subsidiary_id=public.active_subsidiary_id()
  )
);

create policy bank_statement_update_active_subsidiary
on public.bank_statement
for update
to authenticated
using(
  public.security_resource_allowed('banking:bank-statements','edit')
  and exists(
    select 1
    from public.bank_account account
    where account.bank_account_id=bank_statement.bank_account_id
      and account.subsidiary_id=public.active_subsidiary_id()
  )
)
with check(
  public.security_resource_allowed('banking:bank-statements','edit')
  and exists(
    select 1
    from public.bank_account account
    where account.bank_account_id=bank_statement.bank_account_id
      and account.subsidiary_id=public.active_subsidiary_id()
  )
);

create policy bank_statement_delete_active_subsidiary
on public.bank_statement
for delete
to authenticated
using(
  public.security_resource_allowed('banking:bank-statements','delete')
  and exists(
    select 1
    from public.bank_account account
    where account.bank_account_id=bank_statement.bank_account_id
      and account.subsidiary_id=public.active_subsidiary_id()
  )
);

-- Las lineas heredan tanto la subsidiaria como la accion autorizada de su
-- encabezado. Los RPC de importacion y conciliacion conservan su ejecucion
-- SECURITY DEFINER y no dependen de acceso directo desde el navegador.
alter table public.bank_statement_line enable row level security;

drop policy if exists bank_statement_line_company_access on public.bank_statement_line;
drop policy if exists bank_statement_line_select_active_subsidiary on public.bank_statement_line;
drop policy if exists bank_statement_line_insert_active_subsidiary on public.bank_statement_line;
drop policy if exists bank_statement_line_update_active_subsidiary on public.bank_statement_line;
drop policy if exists bank_statement_line_delete_active_subsidiary on public.bank_statement_line;

create policy bank_statement_line_select_active_subsidiary
on public.bank_statement_line
for select
to authenticated
using(
  public.security_resource_allowed('banking:bank-statements','view')
  and public.bank_statement_in_active_subsidiary(statement_id)
);

create policy bank_statement_line_insert_active_subsidiary
on public.bank_statement_line
for insert
to authenticated
with check(
  public.security_resource_allowed('banking:bank-statements','create')
  and public.bank_statement_in_active_subsidiary(statement_id)
);

create policy bank_statement_line_update_active_subsidiary
on public.bank_statement_line
for update
to authenticated
using(
  public.security_resource_allowed('banking:bank-statements','edit')
  and public.bank_statement_in_active_subsidiary(statement_id)
)
with check(
  public.security_resource_allowed('banking:bank-statements','edit')
  and public.bank_statement_in_active_subsidiary(statement_id)
);

create policy bank_statement_line_delete_active_subsidiary
on public.bank_statement_line
for delete
to authenticated
using(
  public.security_resource_allowed('banking:bank-statements','delete')
  and public.bank_statement_in_active_subsidiary(statement_id)
);

comment on function public.bank_statement_in_active_subsidiary(bigint) is
  'Comprueba que un extracto pertenece a la subsidiaria activa sin omitir las politicas de accion del catalogo.';
comment on policy bank_statement_select_active_subsidiary on public.bank_statement is
  'Solo muestra extractos de la subsidiaria activa con permiso banking:bank-statements.view.';
comment on policy bank_statement_line_select_active_subsidiary on public.bank_statement_line is
  'Las lineas visibles pertenecen exclusivamente a extractos de la subsidiaria activa.';

notify pgrst,'reload schema';
