create table if not exists public.solicitudes_pago_respaldos(
 id bigint generated always as identity primary key,
 id_solicitud bigint not null references public.solicitudes_pago(id) on delete cascade,
 tipo text not null check(tipo in('Archivo','Enlace')),
 nombre_visible varchar(180) not null,
 enlace text,
 nombre_archivo varchar(255),
 tipo_mime varchar(150),
 tamano_archivo bigint,
 contenido_archivo text,
 created_at timestamptz not null default now(),
 check((tipo='Enlace' and enlace is not null and contenido_archivo is null)
    or (tipo='Archivo' and nombre_archivo is not null and contenido_archivo is not null and tamano_archivo between 1 and 5242880))
);
create index if not exists solicitudes_pago_respaldos_solicitud_idx on public.solicitudes_pago_respaldos(id_solicitud,id);
alter table public.solicitudes_pago_respaldos enable row level security;
revoke all on public.solicitudes_pago_respaldos from anon,authenticated;

create or replace function public.pr_supports(p jsonb) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',r.id,'type',r.tipo,'displayName',r.nombre_visible,'url',r.enlace,
  'fileName',r.nombre_archivo,'mimeType',r.tipo_mime,'fileSize',r.tamano_archivo,
  'fileData',r.contenido_archivo,'createdAt',r.created_at,
  'createdByName',r.created_by_name,'createdByEmail',r.created_by_email
 ) order by r.id),'[]'::jsonb)
 from solicitudes_pago_respaldos r join solicitudes_pago s on s.id=r.id_solicitud
 where r.id_solicitud=(p->>'id')::bigint and s.id_subsidiaria=pr_access()
$$;

create or replace function public.pr_support_save(p jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare h solicitudes_pago%rowtype; rid bigint; kind text:=p->>'type'; display_name text:=trim(p->>'displayName'); target_url text:=trim(p->>'url');
begin
 select * into h from solicitudes_pago where id=(p->>'id')::bigint and id_subsidiaria=pr_access() for update;
 if h.id is null or h.estado not in('BORRADOR','RECHAZADO') or (h.id_solicitante<>app_user_id() and not app_is_admin()) then
  raise exception 'No puede modificar los respaldos de esta solicitud.';
 end if;
 if kind not in('Archivo','Enlace') or display_name='' or length(display_name)>180 then raise exception 'El respaldo no es válido.'; end if;
 if kind='Enlace' then
  if target_url!~* '^https?://[^[:space:]]+$' then raise exception 'Ingrese un enlace válido que comience con http:// o https://.'; end if;
  insert into solicitudes_pago_respaldos(id_solicitud,tipo,nombre_visible,enlace)
  values(h.id,kind,display_name,target_url) returning id into rid;
 else
  if nullif(p->>'fileName','') is null or length(p->>'fileName')>255
   or coalesce((p->>'fileSize')::bigint,0) not between 1 and 5242880
   or coalesce(p->>'fileData','')!~ '^data:[^;]+;base64,' then raise exception 'El archivo de respaldo no es válido o supera 5 MB.'; end if;
  insert into solicitudes_pago_respaldos(id_solicitud,tipo,nombre_visible,nombre_archivo,tipo_mime,tamano_archivo,contenido_archivo)
  values(h.id,kind,display_name,p->>'fileName',left(coalesce(nullif(p->>'mimeType',''),'application/octet-stream'),150),(p->>'fileSize')::bigint,p->>'fileData') returning id into rid;
 end if;
 return jsonb_build_object('id',rid);
end $$;

create or replace function public.pr_support_delete(p jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare h solicitudes_pago%rowtype;
begin
 select s.* into h from solicitudes_pago s join solicitudes_pago_respaldos r on r.id_solicitud=s.id
 where r.id=(p->>'supportId')::bigint and s.id=(p->>'id')::bigint and s.id_subsidiaria=pr_access() for update of s;
 if h.id is null or h.estado not in('BORRADOR','RECHAZADO') or (h.id_solicitante<>app_user_id() and not app_is_admin()) then
  raise exception 'No puede eliminar este respaldo.';
 end if;
 delete from solicitudes_pago_respaldos where id=(p->>'supportId')::bigint and id_solicitud=h.id;
 return jsonb_build_object('success',true);
end $$;

revoke all on function public.pr_supports(jsonb),public.pr_support_save(jsonb),public.pr_support_delete(jsonb) from public,anon;
grant execute on function public.pr_supports(jsonb),public.pr_support_save(jsonb),public.pr_support_delete(jsonb) to authenticated;
notify pgrst,'reload schema';
