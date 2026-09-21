-- Proposals retain the original posting; capitalization never posts the cost twice.
alter table supplier_invoice_line add column if not exists es_activo_fijo boolean not null default false;
alter table journal_line add column if not exists es_activo_fijo boolean not null default false;
alter table journal add column if not exists asset_proposal_internal boolean not null default false;

create table activos_fijos_propuestas(
 proposal_id bigint generated always as identity primary key,
 subsidiary_id bigint not null references subsidiaries,
 journal_line_id bigint unique references journal_line on delete cascade,
 gl_impact_id bigint unique references gl_impact on delete cascade,
 transaction_id bigint not null references "transaction",
 account_id bigint not null references chart_accounts,
 currency_id bigint not null references currencies,
 source_number text not null,source_date date not null,description text,
 supplier_id bigint references suppliers,third_party text,invoice_number text,
 department_id bigint references departments,cost_center_id bigint references cost_centers,class_id bigint references classes,
 amount_local numeric(24,6) not null check(amount_local>0),amount_foreign numeric(24,6) not null,
 status text not null default 'PENDIENTE' check(status in('PENDIENTE','CAPITALIZADO','DESECHADO_GASTO')),
 reason text,processing_journal_id bigint references journal,
 created_at timestamptz not null default now(),processed_at timestamptz,processed_by bigint references users,
 check(num_nonnulls(journal_line_id,gl_impact_id)=1)
);
create index on activos_fijos_propuestas(subsidiary_id,status);
create table fixed_asset_proposal_allocation(
 proposal_id bigint not null references activos_fijos_propuestas,
 asset_id bigint not null references asset,
 amount_local numeric(24,6) not null check(amount_local>0),amount_foreign numeric(24,6) not null,
 primary key(proposal_id,asset_id)
);
alter table activos_fijos_propuestas enable row level security;
alter table fixed_asset_proposal_allocation enable row level security;
create policy proposal_read on activos_fijos_propuestas for select to authenticated using(subsidiary_id=active_subsidiary_id());
create policy allocation_read on fixed_asset_proposal_allocation for select to authenticated using(exists(select 1 from activos_fijos_propuestas p where p.proposal_id=fixed_asset_proposal_allocation.proposal_id and p.subsidiary_id=active_subsidiary_id()));
grant select on activos_fijos_propuestas,fixed_asset_proposal_allocation to authenticated;
insert into permissions(code,module,description)values('fixed-assets:proposals:manage','Activos Fijos','Capitalizar, dividir, agrupar y reclasificar propuestas de activos.')on conflict(code)do nothing;
insert into role_permissions(role_id,permission_id)select r.role_id,p.permission_id from roles r cross join permissions p where p.code='fixed-assets:proposals:manage'and(r.is_system_role or lower(r.role_name)like'%admin%')on conflict do nothing;

create function fixed_asset_ppe_account(p_account bigint)returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select account_belongs_to_group(p_account,'propiedad.*planta.*equipo')
 and not exists(select 1 from asset_category where depreciation_account_id=p_account)
 and not account_belongs_to_group(p_account,'depreciaci.*acumul|deterioro')
 and not exists(select 1 from chart_accounts where account_id=p_account and account_name~*'depreciaci.*acumul|deterioro')
$$;

create function capture_fixed_asset_journal_line(p_line bigint)returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare r record;
begin
 select l.*,j.subsidiary_id,j.currency_id,j.exchange_rate,j.journal_number,j.journal_date,j.memo,j.transaction_id,j.status journal_status,j.asset_proposal_internal,
 coalesce(s.company_name,c.company_name,nullif(concat_ws(' ',e.first_name,e.last_name),'')) supplier_name,i.invoice_number
 into r from journal_line l join journal j using(journal_id)left join suppliers s on s.supplier_id=l.supplier_id left join customers c on c.customer_id=l.customer_id left join employees e on e.employee_id=l.employee_id left join supplier_invoice i on i.journal_id=j.journal_id where l.journal_line_id=p_line;
 if not found then return;end if;
 if r.journal_status<>'CONTABILIZADO' or r.asset_proposal_internal or coalesce(current_setting('app.asset_proposal_internal',true),'')='1' or r.debit<=0 or not(r.es_activo_fijo or fixed_asset_ppe_account(r.account_id))then
  delete from activos_fijos_propuestas where journal_line_id=p_line and status='PENDIENTE';return;
 end if;
 insert into activos_fijos_propuestas(subsidiary_id,journal_line_id,transaction_id,account_id,currency_id,source_number,source_date,description,supplier_id,third_party,invoice_number,department_id,cost_center_id,class_id,amount_local,amount_foreign)
 values(r.subsidiary_id,p_line,r.transaction_id,r.account_id,r.currency_id,r.journal_number,r.journal_date,coalesce(nullif(r.note,''),r.memo),r.supplier_id,coalesce(r.supplier_name,r.entity_type,'Sin tercero'),r.invoice_number,r.department_id,r.cost_center_id,r.class_id,round(r.debit*r.exchange_rate,6),r.debit)
 on conflict(journal_line_id)do update set account_id=excluded.account_id,currency_id=excluded.currency_id,source_date=excluded.source_date,source_number=excluded.source_number,description=excluded.description,supplier_id=excluded.supplier_id,third_party=excluded.third_party,invoice_number=excluded.invoice_number,department_id=excluded.department_id,cost_center_id=excluded.cost_center_id,class_id=excluded.class_id,amount_local=excluded.amount_local,amount_foreign=excluded.amount_foreign where activos_fijos_propuestas.status='PENDIENTE';
end$$;
create function capture_fixed_asset_line_trigger()returns trigger language plpgsql security definer set search_path=public,pg_temp as $$begin perform capture_fixed_asset_journal_line(new.journal_line_id);return new;end$$;
create trigger capture_fixed_asset_line after insert or update on journal_line for each row execute function capture_fixed_asset_line_trigger();
create function capture_fixed_asset_header_trigger()returns trigger language plpgsql security definer set search_path=public,pg_temp as $$declare k bigint;begin for k in select journal_line_id from journal_line where journal_id=new.journal_id loop perform capture_fixed_asset_journal_line(k);end loop;return new;end$$;
create trigger capture_fixed_asset_header after update on journal for each row execute function capture_fixed_asset_header_trigger();

-- Postings without journal lines (imports and other modules) are captured separately.
create function capture_fixed_asset_gl_trigger()returns trigger language plpgsql security definer set search_path=public,pg_temp as $$declare t record;begin
 if coalesce(current_setting('app.asset_proposal_internal',true),'')='1'or exists(select 1 from journal j where j.transaction_id=new.transaction_id and(j.asset_proposal_internal or exists(select 1 from journal_line l where l.journal_id=j.journal_id and l.account_id=new.account_id and round(l.debit*j.exchange_rate,6)=new.debit_amount and round(l.credit*j.exchange_rate,6)=new.credit_amount)))then return new;end if;
 if new.debit_amount<=0 or not fixed_asset_ppe_account(new.account_id)or not exists(select 1 from accounting_books where accounting_book_id=new.accounting_book_id and is_primary and is_active)then
  delete from activos_fijos_propuestas where gl_impact_id=new.gl_impact_id and status='PENDIENTE';return new;
 end if;
 select tr.*,s.company_name into t from "transaction" tr left join suppliers s using(supplier_id)where tr.transaction_id=new.transaction_id;
 insert into activos_fijos_propuestas(subsidiary_id,gl_impact_id,transaction_id,account_id,currency_id,source_number,source_date,description,supplier_id,third_party,amount_local,amount_foreign)
 values(new.subsidiary_id,new.gl_impact_id,new.transaction_id,new.account_id,t.currency_id,t.tran_number,new.posting_date,'Movimiento directo del mayor',t.supplier_id,coalesce(t.company_name,'Sin tercero'),new.debit_amount,new.debit_fx)
 on conflict(gl_impact_id)do update set account_id=excluded.account_id,currency_id=excluded.currency_id,source_date=excluded.source_date,amount_local=excluded.amount_local,amount_foreign=excluded.amount_foreign where activos_fijos_propuestas.status='PENDIENTE';return new;
end$$;
create trigger capture_fixed_asset_gl after insert or update on gl_impact for each row execute function capture_fixed_asset_gl_trigger();

create function protect_fixed_asset_proposal_source()returns trigger language plpgsql security definer set search_path=public,pg_temp as $$declare used boolean;begin
 if tg_op='UPDATE'and new is not distinct from old then return new;end if;
 if tg_table_name='journal_line'then
  perform 1 from activos_fijos_propuestas where journal_line_id=old.journal_line_id or processing_journal_id=old.journal_id order by proposal_id for update;
  select exists(select 1 from activos_fijos_propuestas where(journal_line_id=old.journal_line_id or processing_journal_id=old.journal_id)and status<>'PENDIENTE')into used;
 elsif tg_table_name='gl_impact'then
  select status<>'PENDIENTE'into used from activos_fijos_propuestas where gl_impact_id=old.gl_impact_id for update;
 else
  if tg_op='UPDATE'and (new.journal_date,new.exchange_rate,new.currency_id,new.subsidiary_id,new.status,new.transaction_id) is not distinct from(old.journal_date,old.exchange_rate,old.currency_id,old.subsidiary_id,old.status,old.transaction_id)then return new;end if;
  perform 1 from activos_fijos_propuestas p where p.transaction_id=old.transaction_id or p.processing_journal_id=old.journal_id order by proposal_id for update;
  select exists(select 1 from activos_fijos_propuestas p where(p.transaction_id=old.transaction_id or p.processing_journal_id=old.journal_id)and p.status<>'PENDIENTE')into used;
 end if;
 if used then raise exception 'El documento tiene propuestas procesadas. No puede modificarse ni eliminarse su origen contable.';end if;return case when tg_op='DELETE'then old else new end;
end$$;
create trigger protect_proposal_line before update or delete on journal_line for each row execute function protect_fixed_asset_proposal_source();
create trigger protect_proposal_gl before update or delete on gl_impact for each row execute function protect_fixed_asset_proposal_source();
create trigger protect_proposal_header before update or delete on journal for each row execute function protect_fixed_asset_proposal_source();
create function protect_capitalized_asset()returns trigger language plpgsql security definer set search_path=public,pg_temp as $$begin
 if exists(select 1 from fixed_asset_proposal_allocation where asset_id=old.asset_id)and(tg_op='DELETE'or(new.purchase_cost,new.category_id,new.subsidiary_id,new.currency_id) is distinct from(old.purchase_cost,old.category_id,old.subsidiary_id,old.currency_id))then raise exception 'El costo y la cuenta de este activo están vinculados a propuestas capitalizadas.';end if;return case when tg_op='DELETE'then old else new end;
end$$;
create trigger protect_capitalized_asset before update or delete on asset for each row execute function protect_capitalized_asset();
create function protect_capitalized_category()returns trigger language plpgsql security definer set search_path=public,pg_temp as $$begin
 if new.asset_account_id is distinct from old.asset_account_id and exists(select 1 from asset a join fixed_asset_proposal_allocation x using(asset_id)where a.category_id=old.category_id)then raise exception 'No puede cambiar la cuenta de una categoría con activos capitalizados desde propuestas.';end if;return new;
end$$;
create trigger protect_capitalized_category before update on asset_category for each row execute function protect_capitalized_category();

create function fixed_asset_proposal_origins(p_asset_id bigint)returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('proposalId',p.proposal_id,'document',p.source_number,'invoice',p.invoice_number,'date',p.source_date,'supplier',p.third_party,'amount',x.amount_local,'foreignAmount',x.amount_foreign,'currency',c.currency_code,'journalId',j.journal_id,'reclassificationJournalId',p.processing_journal_id)order by p.source_date,p.proposal_id),'[]')
 from fixed_asset_proposal_allocation x join activos_fijos_propuestas p using(proposal_id)join currencies c on c.currency_id=p.currency_id left join journal j on j.transaction_id=p.transaction_id
 where x.asset_id=p_asset_id and p.subsidiary_id=active_subsidiary_id()
$$;

-- Extend the original invoice writer while preserving the current withholding wrapper.
do $$declare original text;updated text;begin
 original:=pg_get_functiondef('save_supplier_invoice_without_withholding(jsonb,bigint)'::regprocedure);
 updated:=replace(original,'related_company_id) values','related_company_id,es_activo_fijo) values');
 updated:=replace(updated,'nullif(line->>''related_company_id'','''')::bigint);','nullif(line->>''related_company_id'','''')::bigint,coalesce((line->>''es_activo_fijo'')::boolean,false));');
 updated:=replace(updated,'elsif not exists(select 1 from chart_accounts a join account_group g','elsif not fixed_asset_ppe_account((line->>''account_id'')::bigint) and not exists(select 1 from chart_accounts a join account_group g');
 if updated=original then raise exception 'No se pudo ampliar el guardado de facturas para el indicador de activo fijo.';end if;
 execute updated;
end$$;

create function fixed_asset_proposal_access(p_write boolean default false)returns bigint language plpgsql stable security definer set search_path=public,pg_temp as $$declare sid bigint:=active_subsidiary_id();begin
 if sid is null or not exists(select 1 from user_subsidiaries where user_id=app_user_id()and subsidiary_id=sid)then raise exception 'No tiene acceso a la subsidiaria activa.';end if;
 if p_write and not exists(select 1 from user_roles ur join role_permissions rp using(role_id)join permissions p using(permission_id)where ur.user_id=app_user_id()and p.code='fixed-assets:proposals:manage')then raise exception 'No tiene permiso para procesar propuestas de activos.';end if;return sid;
end$$;

create function fixed_asset_proposal_report(p_filters jsonb default '{}')returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sid bigint:=fixed_asset_proposal_access();result jsonb;reconciliation jsonb;begin
 with accounts as(select a.account_id,a.account_number,a.account_name from chart_accounts a join account_subsidiaries s using(account_id)where s.subsidiary_id=sid and fixed_asset_ppe_account(a.account_id)),
 amounts as(select a.*,coalesce((select sum(g.debit_amount-g.credit_amount)from gl_impact g join accounting_books b using(accounting_book_id)where g.subsidiary_id=sid and g.account_id=a.account_id and b.is_primary and b.is_active),0)gl,
 coalesce((select sum(x.purchase_cost)from asset x join asset_category c using(category_id)where x.subsidiary_id=sid and c.asset_account_id=a.account_id and x.status<>'BAJA'),0)auxiliary,
 coalesce((select sum(p.amount_local)from activos_fijos_propuestas p where p.subsidiary_id=sid and p.account_id=a.account_id and p.status='PENDIENTE'),0)pending from accounts a)
 select jsonb_build_object('accounts',coalesce(jsonb_agg(jsonb_build_object('id',account_id,'number',account_number,'name',account_name,'gl',gl,'auxiliary',auxiliary,'pending',pending,'difference',gl-auxiliary-pending)order by account_number),'[]'),'gl',coalesce(sum(gl),0),'auxiliary',coalesce(sum(auxiliary),0),'pending',coalesce(sum(pending),0),'difference',coalesce(sum(gl-auxiliary-pending),0),'balanced',coalesce(bool_and(gl-auxiliary-pending=0),true),'hasPrimaryBook',exists(select 1 from accounting_books where subsidiary_id=sid and is_primary and is_active),'outsidePpe',coalesce((select sum(amount_local)from activos_fijos_propuestas where subsidiary_id=sid and status='PENDIENTE'and not fixed_asset_ppe_account(account_id)),0))into reconciliation from amounts;
 select jsonb_build_object('rows',coalesce(jsonb_agg(to_jsonb(q)order by q.source_date,q.proposal_id),'[]'))into result from(
 select p.*,a.account_number,a.account_name,c.currency_code,fixed_asset_ppe_account(p.account_id)is_ppe,
 coalesce((select jsonb_agg(jsonb_build_object('id',x.asset_id,'number',z.asset_number,'amount',x.amount_local))from fixed_asset_proposal_allocation x join asset z using(asset_id)where x.proposal_id=p.proposal_id),'[]')assets
 from activos_fijos_propuestas p join chart_accounts a using(account_id)join currencies c on c.currency_id=p.currency_id where p.subsidiary_id=sid
 and(p.status=coalesce(nullif(p_filters->>'status',''),'PENDIENTE'))
 and(nullif(p_filters->>'from','')is null or p.source_date>=(p_filters->>'from')::date)and(nullif(p_filters->>'to','')is null or p.source_date<=(p_filters->>'to')::date)
 and(nullif(p_filters->>'search','')is null or concat_ws(' ',p.source_number,p.invoice_number,p.description,p.third_party,a.account_number)ilike'%'||(p_filters->>'search')||'%'))q;
 return result||jsonb_build_object('reconciliation',reconciliation,'options',fixed_asset_options()||jsonb_build_object('canManage',exists(select 1 from user_roles ur join role_permissions rp using(role_id)join permissions p using(permission_id)where ur.user_id=app_user_id()and p.code='fixed-assets:proposals:manage'),'categories',coalesce((select jsonb_agg(jsonb_build_object('id',category_id,'name',category_name,'accountId',asset_account_id))from asset_category where subsidiary_id=sid and is_active),'[]'),'expenseAccounts',coalesce((select jsonb_agg(jsonb_build_object('id',a.account_id,'name',a.account_number||' · '||a.account_name))from chart_accounts a join account_subsidiaries s using(account_id)where s.subsidiary_id=sid and s.is_active and a.accepts_entries and not a.is_inactive and a.category in('Costo','Gasto')),'[]')));
end$$;

create function process_fixed_asset_proposals(p_payload jsonb)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=fixed_asset_proposal_access(true);ids bigint[];r activos_fijos_propuestas%rowtype;kind text:=p_payload->>'action';n integer:=coalesce((p_payload->>'quantity')::integer,1);i integer;cid bigint;target_account bigint;cur bigint;pid bigint;jid bigint;aid bigint;result jsonb;assets jsonb:='[]';lines jsonb:='[]';total numeric;part numeric;foreign_part numeric;asset_cost numeric;dt date;purchase_dt date;name text:=nullif(trim(p_payload->>'name'),'');v_reason text:=nullif(trim(p_payload->>'reason'),'');
begin
 if kind is null or kind not in('CAPITALIZE','DISCARD')then raise exception 'Acción no válida.';end if;
 select array_agg(distinct value::bigint order by value::bigint)into ids from jsonb_array_elements_text(p_payload->'ids');
 if coalesce(cardinality(ids),0)=0 then raise exception 'Seleccione al menos una propuesta.';end if;
 perform 1 from activos_fijos_propuestas where proposal_id=any(ids)order by proposal_id for update;
 if(select count(*)from activos_fijos_propuestas where proposal_id=any(ids)and subsidiary_id=sid and status='PENDIENTE')<>cardinality(ids)then raise exception 'Una propuesta ya fue procesada o no pertenece a la subsidiaria.';end if;
 select sum(amount_local),min(source_date)into total,purchase_dt from activos_fijos_propuestas where proposal_id=any(ids);
 select currency_id into cur from subsidiaries where subsidiary_id=sid;
 dt:=nullif(p_payload->>'date','')::date;if dt is null or dt<purchase_dt then raise exception 'La fecha no puede ser anterior a la adquisición.';end if;
 if kind='CAPITALIZE'then
  if name is null then raise exception 'Indique el nombre del activo.';end if;
  if n<1 or n>1000 or(n>1 and cardinality(ids)<>1)then raise exception 'El desglose admite de 1 a 1000 activos a partir de una sola propuesta.';end if;
  cid:=nullif(p_payload->>'category_id','')::bigint;
  select asset_account_id into target_account from asset_category where category_id=cid and subsidiary_id=sid and is_active;
  if target_account is null or not fixed_asset_ppe_account(target_account)then raise exception 'Seleccione una categoría con cuenta de costo PPE.';end if;
  if not exists(select 1 from locations l left join location_subsidiaries s using(location_id)where l.location_id=(p_payload->>'location_id')::bigint and(l.subsidiary_id=sid or s.subsidiary_id=sid))then raise exception 'Seleccione una ubicación de la subsidiaria.';end if;
 else
  n:=1;if v_reason is null or length(v_reason)<15 then raise exception 'Indique una justificación de al menos 15 caracteres.';end if;
  target_account:=nullif(p_payload->>'expense_account_id','')::bigint;
  if not exists(select 1 from chart_accounts a join account_subsidiaries s using(account_id)where a.account_id=target_account and s.subsidiary_id=sid and s.is_active and a.accepts_entries and not a.is_inactive and a.category in('Costo','Gasto'))then raise exception 'Seleccione una cuenta de gasto o costo operativa.';end if;
 end if;
 if not exists(select 1 from account_subsidiaries s join chart_accounts a using(account_id)where s.account_id=target_account and s.subsidiary_id=sid and s.is_active and a.accepts_entries and not a.is_inactive)then raise exception 'La cuenta destino no está habilitada.';end if;
 if not exists(select 1 from accounting_books where subsidiary_id=sid and is_primary and is_active)then raise exception 'Configure un libro contable principal activo.';end if;
 for r in select * from activos_fijos_propuestas where proposal_id=any(ids)order by proposal_id loop
  if r.source_date>dt then raise exception 'La fecha no puede ser anterior a ninguno de los documentos seleccionados.';end if;
  if r.account_id<>target_account then
   lines:=lines||jsonb_build_array(jsonb_build_object('account_id',target_account,'debit',r.amount_local,'credit',0,'note',coalesce(v_reason,name),'department_id',r.department_id,'cost_center_id',r.cost_center_id,'class_id',r.class_id),jsonb_build_object('account_id',r.account_id,'debit',0,'credit',r.amount_local,'note','Propuesta '||r.proposal_id,'department_id',r.department_id,'cost_center_id',r.cost_center_id,'class_id',r.class_id));
  end if;
 end loop;
 if jsonb_array_length(lines)>0 then
  select fiscal_period_id into pid from fiscal_periods where subsidiary_id=sid and dt between start_date and end_date and not is_closed and not coalesce(gl_closed,false)and not coalesce(is_inactive,false)order by start_date desc limit 1;
  if pid is null then raise exception 'No existe un período contable abierto para reclasificar.';end if;
  perform set_config('app.asset_proposal_internal','1',true);
  jid:=create_journal_entry(jsonb_build_object('journal_date',dt,'currency_id',cur,'fiscal_period_id',pid,'exchange_rate',1,'journal_type','Estándar','memo',case when kind='DISCARD'then'Descarte de propuesta: '||v_reason else'Capitalización de propuestas: '||name end,'lines',lines));
  update journal set asset_proposal_internal=true where journal_id=jid;perform sync_journal_gl_impacts(jid);
  perform set_config('app.asset_proposal_internal','',true);
 end if;
 if kind='CAPITALIZE'then
  for i in 1..n loop
   asset_cost:=case when i=n then total-round(total/n,6)*(n-1)else round(total/n,6)end;
   if asset_cost<=0 then raise exception 'El monto es insuficiente para la cantidad de activos.';end if;
   result:=save_fixed_asset(p_payload||jsonb_build_object('name',name||case when n>1 then' · '||i||'/'||n else''end,'cost',asset_cost,'purchase_date',purchase_dt,'service_date',dt,'currency_id',cur,'rate',1,'status','ACTIVO'),null);
   aid:=(result->>'id')::bigint;assets:=assets||jsonb_build_array(result);
   for r in select * from activos_fijos_propuestas where proposal_id=any(ids)order by proposal_id loop
    part:=case when i=n then r.amount_local-round(r.amount_local/n,6)*(n-1)else round(r.amount_local/n,6)end;
    foreign_part:=case when i=n then r.amount_foreign-round(r.amount_foreign/n,6)*(n-1)else round(r.amount_foreign/n,6)end;
    insert into fixed_asset_proposal_allocation(proposal_id,asset_id,amount_local,amount_foreign)values(r.proposal_id,aid,part,foreign_part);
   end loop;
  end loop;
 end if;
 update activos_fijos_propuestas set status=case when kind='CAPITALIZE'then'CAPITALIZADO'else'DESECHADO_GASTO'end,reason=v_reason,processing_journal_id=jid,processed_at=now(),processed_by=app_user_id()where proposal_id=any(ids);
 return jsonb_build_object('assets',assets,'journalId',jid,'amount',total,'processed',cardinality(ids));
end$$;

-- Historical entries are detected, not silently matched to pre-existing asset cards.
do $$declare k bigint;begin for k in select journal_line_id from journal_line loop perform capture_fixed_asset_journal_line(k);end loop;end$$;
update gl_impact set debit_amount=debit_amount where not exists(select 1 from journal j where j.transaction_id=gl_impact.transaction_id);
revoke all on function fixed_asset_ppe_account(bigint),capture_fixed_asset_journal_line(bigint),capture_fixed_asset_line_trigger(),capture_fixed_asset_header_trigger(),capture_fixed_asset_gl_trigger(),protect_fixed_asset_proposal_source(),protect_capitalized_asset(),protect_capitalized_category(),fixed_asset_proposal_access(boolean),fixed_asset_proposal_report(jsonb),process_fixed_asset_proposals(jsonb)from public,anon;
grant execute on function fixed_asset_proposal_report(jsonb),process_fixed_asset_proposals(jsonb)to authenticated;
revoke all on function fixed_asset_proposal_origins(bigint)from public,anon;
grant execute on function fixed_asset_proposal_origins(bigint)to authenticated;
notify pgrst,'reload schema';
