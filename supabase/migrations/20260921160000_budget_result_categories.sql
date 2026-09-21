alter table public.presupuestos_encabezado add column categorias text[] not null default array['Costo','Gasto']::text[] check(cardinality(categorias)>0 and categorias <@ array['Ingreso','Costo','Gasto']::text[]);

create or replace function public.budget_options()returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sid bigint:=budget_access('BUDGET_VIEW');begin
 return jsonb_build_object('userId',app_user_id(),'permissions',jsonb_build_object('manage',budget_can('BUDGET_MANAGE'),'approve',budget_can('BUDGET_APPROVE'),'transfer',budget_can('BUDGET_TRANSFER_REQUEST'),'override',budget_can('BUDGET_OVERRIDE_APPROVE')),
 'subsidiary',(select jsonb_build_object('id',s.subsidiary_id,'name',s.name,'currency',c.currency_code)from subsidiaries s join currencies c using(currency_id)where s.subsidiary_id=sid),
 'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',a.account_id,'number',a.account_number,'name',a.account_name,'category',a.category)order by a.account_number)from chart_accounts a where a.category in('Ingreso','Costo','Gasto')and a.accepts_entries and not a.is_inactive and(exists(select 1 from account_subsidiaries x where x.account_id=a.account_id and x.subsidiary_id=sid and x.is_active)or not exists(select 1 from account_subsidiaries where account_id=a.account_id))),'[]'),
 'centers',coalesce((select jsonb_agg(jsonb_build_object('id',cost_center_id,'name',code||' · '||name)order by code)from cost_centers where subsidiary_id=sid and not coalesce(is_inactive,false)),'[]'),
 'headers',coalesce((select jsonb_agg(to_jsonb(h)order by anio desc,id desc)from presupuestos_encabezado h where h.id_subsidiaria=sid),'[]'));
end$$;

create or replace function public.budget_save_lines(p jsonb)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=budget_access('BUDGET_MANAGE');h presupuestos_encabezado%rowtype;r jsonb;acc bigint;cc bigint;dt date;amount numeric;
begin
 select * into h from presupuestos_encabezado where id=(p->>'id')::bigint and id_subsidiaria=sid for update;
 if h.id is null or h.estado<>'BORRADOR'then raise exception 'Seleccione una versión en borrador.';end if;
 if h.revision is distinct from(p->>'revision')::int then raise exception 'La versión cambió. Recargue la matriz.';end if;
 if jsonb_typeof(p->'lines')is distinct from 'array'or jsonb_array_length(p->'lines')>12000 then raise exception 'Importe hasta 12.000 líneas.';end if;
 delete from presupuestos_lineas where id_presupuesto_encabezado=h.id;
 for r in select value from jsonb_array_elements(p->'lines')loop
  acc:=nullif(r->>'accountId','')::bigint;cc:=coalesce(nullif(r->>'centerId',''),nullif(r->>'projectId',''))::bigint;
  if nullif(r->>'centerId','')is not null and nullif(r->>'projectId','')is not null and r->>'centerId'<>r->>'projectId'then raise exception 'Proyecto y centro de costo deben identificar la misma dimensión.';end if;
  if acc is null then select account_id into acc from chart_accounts where account_number=r->>'account';end if;
  if not exists(select 1 from chart_accounts a where a.account_id=acc and a.category=any(h.categorias)and a.accepts_entries and not a.is_inactive and(exists(select 1 from account_subsidiaries x where x.account_id=a.account_id and x.subsidiary_id=sid and x.is_active)or not exists(select 1 from account_subsidiaries where account_id=a.account_id)))then raise exception 'Seleccione una cuenta de resultados seleccionada habilitada para la subsidiaria.';end if;
  if cc is not null and not exists(select 1 from cost_centers where cost_center_id=cc and subsidiary_id=sid and not coalesce(is_inactive,false))then raise exception 'Centro de costo/proyecto inválido.';end if;
  dt:=(r->>'month'||'-01')::date;amount:=(r->>'amount')::numeric;
  if extract(year from dt)<>h.anio then raise exception 'El mes debe pertenecer al año del presupuesto.';end if;
  insert into presupuestos_lineas(id_presupuesto_encabezado,periodo_mes,id_cuenta_contable,id_centro_costo,id_proyecto,monto_presupuestado)values(h.id,dt,acc,cc,cc,amount);
 end loop;
 update presupuestos_encabezado set revision=revision+1,updated_at=now()where id=h.id returning * into h;return to_jsonb(h);
end$$;

create or replace function public.budget_actuals(p_sid bigint)returns table(account_id bigint,"month" date,center_id bigint,amount numeric)
language sql stable security definer set search_path=public,pg_temp as $$
 with g as(select x.transaction_id,x.account_id,date_trunc('month',x.posting_date)::date as "month",sum(x.debit_amount)d,sum(x.credit_amount)c
 from gl_impact x join accounting_books b using(accounting_book_id)join chart_accounts a on a.account_id=x.account_id
 where x.subsidiary_id=p_sid and b.is_primary and b.is_active and a.category in('Ingreso','Costo','Gasto')group by 1,2,3),
 dims as(select j.transaction_id,l.account_id,l.cost_center_id,sum(l.debit*j.exchange_rate)d,sum(l.credit*j.exchange_rate)c
 from journal_line l join journal j using(journal_id)where j.subsidiary_id=p_sid and j.status='CONTABILIZADO'group by 1,2,3),
 totals as(select transaction_id,account_id,sum(d)d,sum(c)c from dims group by 1,2),
 allocated as(select g.account_id,g.month,dims.cost_center_id,
 case when totals.d>0 then g.d*dims.d/totals.d else 0 end-case when totals.c>0 then g.c*dims.c/totals.c else 0 end amount
 from g join totals using(transaction_id,account_id)join dims using(transaction_id,account_id)
 union all select g.account_id,g.month,null,case when coalesce(t.d,0)=0 then g.d else 0 end-case when coalesce(t.c,0)=0 then g.c else 0 end
 from g left join totals t using(transaction_id,account_id))
 select a.account_id,a.month,a.cost_center_id,sum(a.amount)*case when ca.category='Ingreso'then -1 else 1 end from allocated a join chart_accounts ca on ca.account_id=a.account_id group by 1,2,3,ca.category having sum(a.amount)<>0
$$;

create or replace function public.budget_usage(p_header bigint)returns table(key text,line_id bigint,account_id bigint,"month" date,center_id bigint,initial numeric,modifications numeric,committed numeric,executed numeric,available numeric)
language sql stable security definer set search_path=public,pg_temp as $$
 with h as(select * from presupuestos_encabezado where id=p_header),
 moves as(select a.account_id,a.month,a.center_id,0::numeric committed,a.amount executed from h cross join lateral budget_actuals(h.id_subsidiaria)a where extract(year from a.month)=h.anio
 union all select c.account_id,c.month,c.center_id,c.amount,0 from h cross join lateral budget_commitments(h.id_subsidiaria)c where extract(year from c.month)=h.anio),
 mapped as(select m.*,budget_match(p_header,m.month,m.account_id,m.center_id,m.center_id)line_id from moves m join chart_accounts ca on ca.account_id=m.account_id where ca.category=any((select categorias from h)::text[])),
 keys as(select 'L:'||l.id key,l.id line_id,l.id_cuenta_contable account_id,l.periodo_mes as "month",l.id_centro_costo center_id,l.monto_presupuestado initial,l.monto_modificaciones modifications from presupuestos_lineas l where l.id_presupuesto_encabezado=p_header
 union all select distinct 'U:'||m.account_id||':'||m.month||':'||coalesce(m.center_id,0),null::bigint,m.account_id,m.month,m.center_id,0,0 from mapped m where m.line_id is null),
 amounts as(select k.*,coalesce(sum(m.committed),0)committed,coalesce(sum(m.executed),0)executed from keys k left join mapped m on
 (k.line_id is not null and m.line_id=k.line_id)or(k.line_id is null and m.line_id is null and m.account_id=k.account_id and m.month=k.month and m.center_id is not distinct from k.center_id)group by k.key,k.line_id,k.account_id,k.month,k.center_id,k.initial,k.modifications)
 select a.*,a.initial+a.modifications-a.committed-a.executed from amounts a
$$;

create or replace function public.budget_state(p_sid bigint)returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce(jsonb_agg(to_jsonb(u)||jsonb_build_object('headerId',h.id,'revision',h.revision,'control',case when h.estado='CERRADO'then 'HARD_LOCK'else h.tipo_control end,'closed',h.estado='CERRADO','account',a.account_number,'center',coalesce(cc.name,'General'))),'[]')
 from presupuestos_encabezado h cross join lateral budget_usage(h.id)u join chart_accounts a on a.account_id=u.account_id left join cost_centers cc on cc.cost_center_id=u.center_id
 where a.category in('Costo','Gasto')and h.id_subsidiaria=p_sid and h.estado in('APROBADO','CERRADO')
$$;

create or replace function public.budget_header_action(p jsonb)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=budget_access(case when p->>'action'='copy'then 'BUDGET_MANAGE'else 'BUDGET_APPROVE'end);h presupuestos_encabezado%rowtype;key bigint;factor numeric;cur text;
begin
 perform pg_advisory_xact_lock(hashtextextended('budget:'||sid,0));
 select * into h from presupuestos_encabezado where id=(p->>'id')::bigint and id_subsidiaria=sid for update;
 if h.id is null then raise exception 'Presupuesto no encontrado.';end if;
 if p->>'action'='copy'then
  factor:=1+coalesce((p->>'percent')::numeric,0)/100;if factor<0 or factor>101 then raise exception 'El ajuste debe estar entre -100%% y 10000%%.';end if;
  insert into presupuestos_encabezado(id_subsidiaria,anio,nombre_version,moneda,tipo_control,categorias)values(sid,(p->>'year')::int,p->>'name',h.moneda,h.tipo_control,h.categorias)returning id into key;
  insert into presupuestos_lineas(id_presupuesto_encabezado,periodo_mes,id_cuenta_contable,id_centro_costo,id_proyecto,monto_presupuestado)
  select key,make_date((p->>'year')::int,extract(month from periodo_mes)::int,1),id_cuenta_contable,id_centro_costo,id_proyecto,round((monto_presupuestado+monto_modificaciones)*factor,6)from presupuestos_lineas where id_presupuesto_encabezado=h.id;
 elsif p->>'action'='approve'then
  if h.estado<>'BORRADOR'or not exists(select 1 from presupuestos_lineas where id_presupuesto_encabezado=h.id)then raise exception 'Solo se aprueban borradores con líneas.';end if;
  if(select count(*)from accounting_books where subsidiary_id=sid and is_primary and is_active)<>1 then raise exception 'Configure un único libro principal activo.';end if;
  if h.tipo_control='HARD_LOCK'and exists(select 1 from budget_usage(h.id)u join chart_accounts a on a.account_id=u.account_id where a.category in('Costo','Gasto')and available<-.000001)then raise exception 'El presupuesto estricto no cubre los compromisos y ejecuciones existentes. Revise las líneas sin presupuesto.';end if;
  update presupuestos_encabezado set estado='HISTORICO',updated_at=now()where id_subsidiaria=sid and anio=h.anio and estado in('APROBADO','CERRADO');
  update presupuestos_encabezado set estado='APROBADO',revision=revision+1,updated_at=now()where id=h.id;key:=h.id;
 elsif p->>'action'='close'then
  if h.estado<>'APROBADO'then raise exception 'Solo se puede cerrar una versión aprobada.';end if;
  update presupuestos_encabezado set estado='CERRADO',updated_at=now()where id=h.id;key:=h.id;
 else raise exception 'Acción inválida.';end if;
 insert into budget_events(subsidiary_id,source_type,source_id,event,details)values(sid,'PRESUPUESTO',key,upper(p->>'action'),p);
 return(select to_jsonb(x)from presupuestos_encabezado x where x.id=key);
end$$;

create or replace function public.budget_report(p jsonb default '{}')returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sid bigint:=budget_access('BUDGET_VIEW');h presupuestos_encabezado%rowtype;
begin
 select * into h from presupuestos_encabezado where id=(p->>'id')::bigint and id_subsidiaria=sid;
 if h.id is null then raise exception 'Presupuesto no encontrado.';end if;
 return jsonb_build_object('header',to_jsonb(h),'rows',coalesce((select jsonb_agg(to_jsonb(u)||jsonb_build_object('category',a.category,'account',a.account_number,'name',a.account_name,'center',coalesce(cc.name,'General / todas las dimensiones'),'percentage',case when u.initial+u.modifications>0 then round((u.committed+u.executed)/(u.initial+u.modifications)*100,2)else null end,'status',case when a.category='Ingreso'then case when u.available<=0 then 'META_CUMPLIDA'else 'POR_ALCANZAR'end when u.available<0 then 'EXCEDIDO'when u.initial+u.modifications>0 and u.available<=(u.initial+u.modifications)*.1 then 'ALERTA'else 'NORMAL'end)order by u.month,a.account_number,u.center_id)from budget_usage(h.id)u join chart_accounts a on a.account_id=u.account_id left join cost_centers cc on cc.cost_center_id=u.center_id where nullif(p->>'month','')is null or to_char(u.month,'YYYY-MM')=p->>'month'),'[]'),
 'transfers',coalesce((select jsonb_agg(to_jsonb(m)||jsonb_build_object('workflowId',w.id,'workflowStatus',w.status)order by m.id desc)from presupuestos_modificaciones m left join wf_instances w on w.entity_type='BUDGET_TRANSFER'and w.entity_id=m.id where m.id_subsidiaria=sid and(m.id_linea_origen in(select id from presupuestos_lineas where id_presupuesto_encabezado=h.id)or m.id_linea_destino in(select id from presupuestos_lineas where id_presupuesto_encabezado=h.id))),'[]'),
 'overrides',coalesce((select jsonb_agg(to_jsonb(o)-'payload'order by o.id desc)from budget_overrides o where o.subsidiary_id=sid),'[]'),
 'events',coalesce((select jsonb_agg(to_jsonb(e)order by e.id desc)from(select * from budget_events where subsidiary_id=sid order by id desc limit 100)e),'[]'));
end$$;

alter function public.budget_save_header(jsonb)rename to budget_save_header_without_categories;
revoke all on function public.budget_save_header_without_categories(jsonb)from public,anon,authenticated;

create function public.budget_save_header(p jsonb)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=budget_access('BUDGET_MANAGE');h presupuestos_encabezado%rowtype;cats text[];result jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('budget:'||sid,0));
 result:=budget_save_header_without_categories(p);
 select * into h from presupuestos_encabezado where id=(result->>'id')::bigint;
 if p ? 'categories'then
  if jsonb_typeof(p->'categories')<>'array'then raise exception 'Seleccione las categorías de resultados.';end if;
  select array_agg(distinct value)into cats from jsonb_array_elements_text(p->'categories');
  if cats is null or not(cats <@ array['Ingreso','Costo','Gasto']::text[])then raise exception 'Seleccione al menos una categoría válida: Ingresos, Costos o Gastos.';end if;
  if exists(select 1 from presupuestos_lineas l join chart_accounts a on a.account_id=l.id_cuenta_contable where l.id_presupuesto_encabezado=h.id and not(a.category=any(cats)))then raise exception 'La matriz contiene cuentas de una categoría desmarcada. Conserve esa categoría o retire primero sus filas de la matriz.';end if;
  update presupuestos_encabezado set categorias=cats where id=h.id;
  insert into presupuestos_lineas(id_presupuesto_encabezado,periodo_mes,id_cuenta_contable,monto_presupuestado)
  select h.id,make_date(h.anio,m,1),a.account_id,0 from chart_accounts a cross join generate_series(1,12)m
  where a.category=any(cats)and a.accepts_entries and not a.is_inactive
  and(exists(select 1 from account_subsidiaries x where x.account_id=a.account_id and x.subsidiary_id=sid and x.is_active)or not exists(select 1 from account_subsidiaries where account_id=a.account_id))
  and not exists(select 1 from presupuestos_lineas l where l.id_presupuesto_encabezado=h.id and l.id_cuenta_contable=a.account_id);
 end if;
 return(select to_jsonb(x)from presupuestos_encabezado x where x.id=h.id);
end$$;
revoke all on function public.budget_save_header(jsonb)from public,anon;
grant execute on function public.budget_save_header(jsonb)to authenticated;
notify pgrst,'reload schema';

create or replace function public.budget_check_availability(p jsonb)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=budget_access('BUDGET_VIEW');h presupuestos_encabezado%rowtype;matched_line bigint;dt date;balance numeric:=0;amount numeric:=(p->>'monto')::numeric;
begin
 if (p->>'id_subsidiaria')::bigint is distinct from sid then raise exception 'Seleccione la subsidiaria activa.';end if;
 if amount is null or amount<0 then raise exception 'Importe inválido.';end if;
 dt:=(p->>'periodo'||'-01')::date;
 select * into h from presupuestos_encabezado where id_subsidiaria=sid and anio=extract(year from dt)and estado in('APROBADO','CERRADO');
 if h.id is null then return jsonb_build_object('controlActivo',false,'disponible',true,'saldo_remanente',null);end if;
 if not exists(select 1 from chart_accounts a where a.account_id=(p->>'id_cuenta_contable')::bigint and a.category in('Costo','Gasto')and a.category=any(h.categorias))then return jsonb_build_object('controlActivo',false,'disponible',true,'saldo_remanente',null);end if;
 matched_line:=budget_match(h.id,dt,(p->>'id_cuenta_contable')::bigint,nullif(p->>'id_centro_costo','')::bigint,nullif(p->>'id_centro_costo','')::bigint);
 if matched_line is not null then select available into balance from budget_usage(h.id)where line_id=matched_line;end if;
 return jsonb_build_object('controlActivo',true,'tipo_control',h.tipo_control,'disponible',h.estado<>'CERRADO'and balance>=amount,'saldo_remanente',balance-amount);
end$$;

notify pgrst,'reload schema';
