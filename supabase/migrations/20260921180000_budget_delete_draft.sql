alter function public.budget_header_action(jsonb)rename to budget_header_action_without_delete;
revoke all on function public.budget_header_action_without_delete(jsonb)from public,anon,authenticated;
create function public.budget_header_action(p jsonb)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint;h presupuestos_encabezado%rowtype;line_count bigint;
begin
 if p->>'action' is distinct from 'delete'then return budget_header_action_without_delete(p);end if;
 sid:=budget_access('BUDGET_MANAGE');
 perform pg_advisory_xact_lock(hashtextextended('budget:'||sid,0));
 select * into h from presupuestos_encabezado where id=(p->>'id')::bigint and id_subsidiaria=sid for update;
 if h.id is null then raise exception 'Presupuesto no encontrado en la sociedad activa.';end if;
 if h.estado<>'BORRADOR'then raise exception 'Solo se pueden eliminar presupuestos en borrador. Las versiones aprobadas, cerradas e históricas se conservan para consulta.';end if;
 if h.revision is distinct from (p->>'revision')::int then raise exception 'El presupuesto cambió. Actualice la pantalla antes de eliminarlo.';end if;
 if exists(select 1 from presupuestos_modificaciones m join presupuestos_lineas l on l.id in(m.id_linea_origen,m.id_linea_destino)where l.id_presupuesto_encabezado=h.id)then raise exception 'El presupuesto tiene modificaciones vinculadas y no puede eliminarse.';end if;
 select count(*)into line_count from presupuestos_lineas where id_presupuesto_encabezado=h.id;
 insert into budget_events(subsidiary_id,source_type,source_id,event,details)values(sid,'PRESUPUESTO',h.id,'ELIMINAR_BORRADOR',jsonb_build_object('header',to_jsonb(h),'deletedLines',line_count));
 delete from presupuestos_encabezado where id=h.id;
 return jsonb_build_object('id',h.id,'deleted',true);
end$$;
revoke all on function public.budget_header_action(jsonb)from public,anon;
grant execute on function public.budget_header_action(jsonb)to authenticated;
notify pgrst,'reload schema';
