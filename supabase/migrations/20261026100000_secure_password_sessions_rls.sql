-- Limita sesiones e historial de contraseñas al usuario propietario.
-- Los administradores pueden consultar/revocar sesiones, pero nunca reciben
-- acceso transversal a hashes históricos de contraseñas.

alter table public.sessions enable row level security;
alter table public.password_history enable row level security;

do $$
declare
  policy_row record;
begin
  -- Elimina también cualquier política permisiva heredada. En PostgreSQL las
  -- políticas permisivas se combinan con OR; dejar una sola `using (true)`
  -- anularía por completo las restricciones nuevas.
  for policy_row in
    select tablename,policyname
    from pg_policies
    where schemaname='public'
      and tablename in('sessions','password_history')
  loop
    execute format(
      'drop policy %I on public.%I',
      policy_row.policyname,
      policy_row.tablename
    );
  end loop;
end;
$$;

-- Sesiones: cada usuario administra las suyas. El rol Administrador activo
-- puede revisar o revocar sesiones de terceros, pero no crear ni modificar
-- una sesión en nombre de otra persona.
create policy sessions_select_owner_or_admin
on public.sessions
for select
to authenticated
using(
  user_id=public.app_user_id()
  or public.app_is_admin()
);

create policy sessions_insert_owner
on public.sessions
for insert
to authenticated
with check(user_id=public.app_user_id());

create policy sessions_update_owner
on public.sessions
for update
to authenticated
using(user_id=public.app_user_id())
with check(user_id=public.app_user_id());

create policy sessions_delete_owner_or_admin
on public.sessions
for delete
to authenticated
using(
  user_id=public.app_user_id()
  or public.app_is_admin()
);

-- Historial: es confidencial e inmutable. Ni siquiera un administrador puede
-- leer hashes ajenos; la administración únicamente muestra el historial del
-- propio usuario. Las altas solo pueden pertenecer al usuario autenticado.
create policy password_history_select_owner
on public.password_history
for select
to authenticated
using(user_id=public.app_user_id());

create policy password_history_insert_owner
on public.password_history
for insert
to authenticated
with check(user_id=public.app_user_id());

-- Defensa adicional: RLS no aplica a TRUNCATE y una política futura no debe
-- convertir accidentalmente el historial inmutable en editable.
revoke update,delete,truncate,references,trigger
on table public.password_history
from authenticated;

revoke truncate,references,trigger
on table public.sessions
from authenticated;

revoke all
on table public.sessions,public.password_history
from anon;

comment on policy sessions_select_owner_or_admin on public.sessions is
  'Permite consultar sesiones propias; el administrador activo puede auditar sesiones de usuarios.';
comment on policy sessions_insert_owner on public.sessions is
  'Impide crear una sesión para un usuario distinto del JWT autenticado.';
comment on policy sessions_update_owner on public.sessions is
  'Impide modificar sesiones de terceros, incluso con un rol administrativo.';
comment on policy sessions_delete_owner_or_admin on public.sessions is
  'Permite cerrar sesiones propias o revocarlas desde un rol Administrador activo.';
comment on policy password_history_select_owner on public.password_history is
  'Los hashes históricos solo son visibles para su propietario; no existe excepción administrativa.';
comment on policy password_history_insert_owner on public.password_history is
  'Solo permite registrar historial para el usuario del JWT autenticado.';

notify pgrst,'reload schema';
