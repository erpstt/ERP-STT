CREATE OR REPLACE FUNCTION public.validate_subsidiary_approvers()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare field text; chosen text; label text;
begin
  foreach field in array array['project_approver','administrative_approver'] loop
    chosen:=to_jsonb(new)->>field;
    if chosen is null then continue; end if;
    if tg_op='UPDATE' then
      if chosen is not distinct from to_jsonb(old)->>field then continue; end if;
    end if;
    label:=case field when 'project_approver' then 'Aprobador Proyectos (UP)' else 'Aprobador Administrativo' end;
    if chosen !~ '^(employee|user):[1-9][0-9]*$' then raise exception '%: seleccione un empleado o usuario válido.',label; end if;
    if not exists(select 1 from subsidiary_approver_options where approver_id=chosen and is_active) then
      raise exception '%: el empleado o usuario no existe, está inactivo o no está disponible.',label;
    end if;
    -- Lock the source row so deleting it cannot race against this assignment.
    if chosen like 'employee:%' then perform 1 from employees where employee_id=split_part(chosen,':',2)::bigint for key share;
    else perform 1 from users where user_id=split_part(chosen,':',2)::bigint for key share; end if;
    if not found then raise exception '%: el registro ya no está disponible.',label; end if;
  end loop;
  return new;
end$function$;
