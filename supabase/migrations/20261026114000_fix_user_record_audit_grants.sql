-- Permite que record_actor_audit (SECURITY INVOKER) lea exclusivamente los
-- metadatos de autoría de users. La política users_select_authorized continúa
-- limitando las filas visibles al perfil propio o a roles con security:users.
grant select(
  created_by_name,
  created_by_email,
  actor_type,
  actor_source,
  execution_context_id,
  updated_by_name,
  updated_by_email,
  updated_actor_type,
  updated_actor_source,
  updated_execution_context_id
) on table public.users to authenticated;

-- Defensa explícita: los identificadores internos y credenciales no forman
-- parte del contrato de la autoría y permanecen inaccesibles al navegador.
revoke select(
  password_hash,
  auth_user_id,
  created_by_id,
  updated_by_id
) on table public.users from authenticated;

comment on function public.record_actor_audit(text,text) is
  'Devuelve metadatos mínimos de autoría respetando los grants y RLS del solicitante; no expone credenciales ni identificadores internos.';

notify pgrst,'reload schema';
