do $$begin if exists(select 1 from presupuestos_lineas where id_centro_costo is not null or id_proyecto is not null)then raise exception 'Existen partidas por centro de costo. Consolide sus importes antes de activar el presupuesto general.';end if;end$$;

alter table public.presupuestos_lineas add constraint budget_general_only check(id_centro_costo is null and id_proyecto is null);

create or replace function public.budget_save_lines(p jsonb)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=budget_access('BUDGET_MANAGE');h presupuestos_encabezado%rowtype;r jsonb;acc bigint;cc bigint;dt date;amount numeric;
begin
 select * into h from presupuestos_encabezado where id=(p->>'id')::bigint and id_subsidiaria=sid for update;
 if h.id is null or h.estado<>'BORRADOR'then raise exception 'Seleccione una versión en borrador.';end if;
 if h.revision is distinct from(p->>'revision')::int then raise exception 'La versión cambió. Recargue la matriz.';end if;
 if jsonb_typeof(p->'lines')is distinct from 'array'or jsonb_array_length(p->'lines')>12000 then raise exception 'Importe hasta 12.000 líneas.';end if;
 delete from presupuestos_lineas where id_presupuesto_encabezado=h.id;
 for r in select value from jsonb_array_elements(p->'lines')loop
  acc:=nullif(r->>'accountId','')::bigint;cc:=null;
  if nullif(trim(r->>'centerId'),'')is not null or nullif(trim(r->>'projectId'),'')is not null then raise exception 'El presupuesto es general por sociedad. No ingrese centros de costo ni proyectos.';end if;
  if acc is null then select account_id into acc from chart_accounts where account_number=r->>'account';end if;
  if not exists(select 1 from chart_accounts a where a.account_id=acc and a.category=any(h.categorias)and a.accepts_entries and not a.is_inactive and(exists(select 1 from account_subsidiaries x where x.account_id=a.account_id and x.subsidiary_id=sid and x.is_active)or not exists(select 1 from account_subsidiaries where account_id=a.account_id)))then raise exception 'Seleccione una cuenta de resultados seleccionada habilitada para la subsidiaria.';end if;
  if cc is not null and not exists(select 1 from cost_centers where cost_center_id=cc and subsidiary_id=sid and not coalesce(is_inactive,false))then raise exception 'Centro de costo/proyecto inválido.';end if;
  dt:=(r->>'month'||'-01')::date;amount:=(r->>'amount')::numeric;
  if extract(year from dt)<>h.anio then raise exception 'El mes debe pertenecer al año del presupuesto.';end if;
  insert into presupuestos_lineas(id_presupuesto_encabezado,periodo_mes,id_cuenta_contable,id_centro_costo,id_proyecto,monto_presupuestado)values(h.id,dt,acc,cc,cc,amount);
 end loop;
 update presupuestos_encabezado set revision=revision+1,updated_at=now()where id=h.id returning * into h;return to_jsonb(h);
end$$;

create or replace function public.budget_options()returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sid bigint:=budget_access('BUDGET_VIEW');begin
 return jsonb_build_object('userId',app_user_id(),'permissions',jsonb_build_object('manage',budget_can('BUDGET_MANAGE'),'approve',budget_can('BUDGET_APPROVE'),'transfer',budget_can('BUDGET_TRANSFER_REQUEST'),'override',budget_can('BUDGET_OVERRIDE_APPROVE')),
 'subsidiary',(select jsonb_build_object('id',s.subsidiary_id,'name',s.name,'currency',c.currency_code)from subsidiaries s join currencies c using(currency_id)where s.subsidiary_id=sid),
 'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',a.account_id,'number',a.account_number,'name',a.account_name,'category',a.category)order by a.account_number)from chart_accounts a where a.category in('Ingreso','Costo','Gasto')and a.accepts_entries and not a.is_inactive and(exists(select 1 from account_subsidiaries x where x.account_id=a.account_id and x.subsidiary_id=sid and x.is_active)or not exists(select 1 from account_subsidiaries where account_id=a.account_id))),'[]'),
 'centers','[]'::jsonb,
 'headers',coalesce((select jsonb_agg(to_jsonb(h)order by anio desc,id desc)from presupuestos_encabezado h where h.id_subsidiaria=sid),'[]'));
end$$;

create or replace function public.budget_usage(p_header bigint)returns table(key text,line_id bigint,account_id bigint,"month" date,center_id bigint,initial numeric,modifications numeric,committed numeric,executed numeric,available numeric)
language sql stable security definer set search_path=public,pg_temp as $$
 with h as(select * from presupuestos_encabezado where id=p_header),
 dimension_moves as(select a.account_id,a.month,a.center_id,0::numeric committed,a.amount executed from h cross join lateral budget_actuals(h.id_subsidiaria)a where extract(year from a.month)=h.anio
 union all select c.account_id,c.month,c.center_id,c.amount,0 from h cross join lateral budget_commitments(h.id_subsidiaria)c where extract(year from c.month)=h.anio),
 moves as(select account_id,month,null::bigint center_id,sum(committed)committed,sum(executed)executed from dimension_moves group by account_id,month),
 mapped as(select m.*,budget_match(p_header,m.month,m.account_id,m.center_id,m.center_id)line_id from moves m join chart_accounts ca on ca.account_id=m.account_id where ca.category=any((select categorias from h)::text[])),
 keys as(select 'L:'||l.id key,l.id line_id,l.id_cuenta_contable account_id,l.periodo_mes as "month",l.id_centro_costo center_id,l.monto_presupuestado initial,l.monto_modificaciones modifications from presupuestos_lineas l where l.id_presupuesto_encabezado=p_header
 union all select distinct 'U:'||m.account_id||':'||m.month||':'||coalesce(m.center_id,0),null::bigint,m.account_id,m.month,m.center_id,0,0 from mapped m where m.line_id is null),
 amounts as(select k.*,coalesce(sum(m.committed),0)committed,coalesce(sum(m.executed),0)executed from keys k left join mapped m on
 (k.line_id is not null and m.line_id=k.line_id)or(k.line_id is null and m.line_id is null and m.account_id=k.account_id and m.month=k.month and m.center_id is not distinct from k.center_id)group by k.key,k.line_id,k.account_id,k.month,k.center_id,k.initial,k.modifications)
 select a.*,a.initial+a.modifications-a.committed-a.executed from amounts a
$$;

notify pgrst,'reload schema';
