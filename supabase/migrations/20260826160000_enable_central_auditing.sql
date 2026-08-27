-- Auditoria transversal e inmutable para todas las tablas de negocio.
alter table public.audit_log alter column entity_id drop not null;
alter table public.audit_log add column if not exists module text;
alter table public.audit_log add column if not exists entity_key text;
alter table public.audit_log add column if not exists description text;
alter table public.audit_log add column if not exists result text not null default 'EXITOSA';
alter table public.audit_log add column if not exists session_id text;
alter table public.audit_log add column if not exists created_at timestamptz not null default now();
alter table public.audit_log add column if not exists transaction_id uuid not null default gen_random_uuid();
alter table public.change_log add column if not exists change_type text not null default 'MODIFICACION';
alter table public.event_log add column if not exists result text not null default 'EXITOSA';
alter table public.event_log add column if not exists details jsonb;
alter table public.event_log add column if not exists transaction_id uuid not null default gen_random_uuid();
alter table public.deleted_records alter column deleted_by_user_id drop not null;
alter table public.deleted_records add column if not exists module text;
alter table public.deleted_records add column if not exists reason text;
alter table public.deleted_records add column if not exists audit_log_id bigint references public.audit_log(log_id);
alter table public.deleted_records add column if not exists transaction_id uuid not null default gen_random_uuid();
create index if not exists audit_log_entity_idx on public.audit_log(entity_type,entity_key,"timestamp" desc);
create index if not exists audit_log_user_idx on public.audit_log(user_id,"timestamp" desc);
create index if not exists activity_log_user_time_idx on public.activity_log(user_id,"timestamp" desc);

create or replace function public.audit_request_ip() returns inet language plpgsql stable as $$
declare h jsonb; value text;
begin
  begin h:=current_setting('request.headers',true)::jsonb; exception when others then return null; end;
  value:=split_part(coalesce(h->>'x-forwarded-for',h->>'x-real-ip',''),',',1);
  begin return nullif(trim(value),'')::inet; exception when others then return null; end;
end$$;

create or replace function public.audit_primary_key(target regclass,row_data jsonb) returns text language sql stable as $$
 select string_agg(format('%s=%s',a.attname,row_data->>a.attname),',' order by k.ordinality)
 from pg_index i cross join lateral unnest(i.indkey) with ordinality k(attnum,ordinality)
 join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum
 where i.indrelid=target and i.indisprimary
$$;

create or replace function public.capture_row_audit() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare before_row jsonb:=case when tg_op in('UPDATE','DELETE') then to_jsonb(old) end;
 after_row jsonb:=case when tg_op in('INSERT','UPDATE') then to_jsonb(new) end;
 row_data jsonb:=coalesce(after_row,before_row); actor bigint:=public.app_user_id(); audit_id bigint;
 entity_key text; numeric_id bigint; field record;
 action_name text:=case tg_op when 'INSERT' then 'CREACION' when 'UPDATE' then 'MODIFICACION' else 'ELIMINACION' end;
begin
 entity_key:=public.audit_primary_key(tg_relid,row_data);
 begin numeric_id:=split_part(split_part(entity_key,'=',2),',',1)::bigint; exception when others then numeric_id:=null; end;
 insert into audit_log(user_id,action,module,entity_type,entity_id,entity_key,description,result,ip_address,session_id)
 values(actor,action_name,tg_table_schema,tg_table_name,numeric_id,entity_key,format('%s sobre %I.%I (%s)',action_name,tg_table_schema,tg_table_name,coalesce(entity_key,'sin clave primaria')),'EXITOSA',public.audit_request_ip(),public.app_session_id()) returning log_id into audit_id;
 if tg_op='UPDATE' then
  for field in select o.key,o.value old_value,n.value new_value from jsonb_each(before_row)o join jsonb_each(after_row)n using(key) where o.value is distinct from n.value loop
   insert into change_log(audit_log_id,field_name,old_value,new_value,change_type) values(audit_id,field.key,field.old_value#>>'{}',field.new_value#>>'{}','MODIFICACION');
  end loop;
 elsif tg_op='DELETE' then
  insert into deleted_records(original_table_name,original_record_id,deleted_by_user_id,record_data_json,module,audit_log_id) values(tg_table_name,coalesce(numeric_id,0),actor,before_row::text,tg_table_schema,audit_id);
 end if;
 if actor is not null then insert into activity_log(user_id,activity_type,path_accessed) values(actor,action_name,format('%I.%I/%s',tg_table_schema,tg_table_name,coalesce(entity_key,''))); end if;
 if tg_op='DELETE' then return old; else return new; end if;
end$$;

create or replace function public.install_audit_trigger(target regclass) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare schema_name text; table_name text;
begin
 select n.nspname,c.relname into schema_name,table_name from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.oid=target;
 if schema_name<>'public' or table_name in('audit_log','change_log','event_log','activity_log','deleted_records') then return; end if;
 execute format('drop trigger if exists central_row_audit on %I.%I',schema_name,table_name);
 execute format('create trigger central_row_audit after insert or update or delete on %I.%I for each row execute function public.capture_row_audit()',schema_name,table_name);
end$$;
do $$declare item record;begin for item in select c.oid::regclass target from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in('r','p') loop perform public.install_audit_trigger(item.target);end loop;end$$;

do $$declare t text;begin foreach t in array array['audit_log','change_log','event_log','activity_log','deleted_records'] loop execute format('drop policy if exists "audit_insert" on public.%I',t);execute format('drop policy if exists "audit_update" on public.%I',t);execute format('drop policy if exists "audit_delete" on public.%I',t);end loop;end$$;
revoke insert,update,delete on public.audit_log,public.change_log,public.event_log,public.activity_log,public.deleted_records from authenticated;
grant select on public.audit_log,public.change_log,public.event_log,public.activity_log,public.deleted_records to authenticated;

create or replace function public.record_system_event(event_type text,source_component text,description text,result text default 'EXITOSA',details jsonb default null) returns bigint language plpgsql security definer set search_path=public,pg_temp as $$
declare new_id bigint;begin insert into event_log(event_type,source_component,description,result,details) values(event_type,source_component,description,result,details) returning event_id into new_id;return new_id;end$$;
revoke all on function public.record_system_event(text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.record_system_event(text,text,text,text,jsonb) to service_role;
