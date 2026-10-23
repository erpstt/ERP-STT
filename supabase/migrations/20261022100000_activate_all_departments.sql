begin transaction read write;

-- El cambio debe afectar únicamente el estado del departamento. Los bloqueos
-- mantienen estable el catálogo y sus asignaciones mientras se verifica la
-- integridad antes de confirmar la transacción.
lock table public.departments in share row exclusive mode;
lock table public.department_subsidiaries in share mode;

do $$
declare
  assignment_count_before bigint;
  assignment_fingerprint_before text;
  owner_fingerprint_before text;
  assignment_count_after bigint;
  assignment_fingerprint_after text;
  owner_fingerprint_after text;
begin
  select count(*),
         md5(coalesce(string_agg(department_id::text||':'||subsidiary_id::text,',' order by department_id,subsidiary_id),''))
    into assignment_count_before,assignment_fingerprint_before
  from public.department_subsidiaries;

  select md5(coalesce(string_agg(department_id::text||':'||coalesce(subsidiary_id::text,'NULL'),',' order by department_id),''))
    into owner_fingerprint_before
  from public.departments;

  update public.departments
     set is_inactive=false
   where is_inactive;

  if exists(select 1 from public.departments where is_inactive)then
    raise exception 'No fue posible activar todos los departamentos.';
  end if;

  select count(*),
         md5(coalesce(string_agg(department_id::text||':'||subsidiary_id::text,',' order by department_id,subsidiary_id),''))
    into assignment_count_after,assignment_fingerprint_after
  from public.department_subsidiaries;

  select md5(coalesce(string_agg(department_id::text||':'||coalesce(subsidiary_id::text,'NULL'),',' order by department_id),''))
    into owner_fingerprint_after
  from public.departments;

  if assignment_count_before is distinct from assignment_count_after
     or assignment_fingerprint_before is distinct from assignment_fingerprint_after
     or owner_fingerprint_before is distinct from owner_fingerprint_after then
    raise exception 'Las asignaciones de subsidiarias cambiaron durante la activación de departamentos.';
  end if;
end
$$;

commit;

notify pgrst,'reload schema';
