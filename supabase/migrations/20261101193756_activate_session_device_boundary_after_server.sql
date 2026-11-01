-- Activate only after the server uses trusted registration and forwards device context.
create or replace function public.app_user_id()returns bigint language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$select session_boundary_private.identity()$$;
create or replace function public.assert_request_access(p_session_token_hash text,p_device_token_hash text)returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare u bigint:=session_boundary_private.identity();did bigint;begin
 if u is null or p_session_token_hash is null or p_session_token_hash!~'^[0-9a-f]{64}$'or p_device_token_hash is null or p_device_token_hash!~'^[0-9a-f]{64}$'then return jsonb_build_object('allowed',false,'reason','SESSION_INVALID');end if;
 select s.device_id into did from public.sessions s join public.devices d on d.device_id=s.device_id and d.user_id=s.user_id where s.user_id=u and s.auth_session_id::text=auth.jwt()->>'session_id'and s.session_token=p_session_token_hash and d.device_token=p_device_token_hash and s.expires_at>clock_timestamp()and s.revoked_at is null and d.revoked_at is null;
 if did is null then return jsonb_build_object('allowed',false,'reason','DEVICE_INVALID');end if;
 update public.devices set last_used=clock_timestamp()where device_id=did and(last_used is null or last_used<clock_timestamp()-interval '5 minutes');
 return jsonb_build_object('allowed',true,'roleAccess',public.security_my_role_access());end$$;
do $$declare t text;p record;c record;cols text;begin foreach t in array array['sessions','devices','login_history']loop
 for p in select policyname from pg_policies where schemaname='public'and tablename=t loop execute format('drop policy %I on public.%I',p.policyname,t);end loop;
 execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
 for c in select column_name from information_schema.columns where table_schema='public'and table_name=t loop execute format('revoke select(%I),insert(%I),update(%I),references(%I)on public.%I from public,anon,authenticated,service_role',c.column_name,c.column_name,c.column_name,c.column_name,t);end loop;
 cols:=case t when'sessions'then'session_id,user_id,ip_address,expires_at,created_at,revoked_at'when'devices'then'device_id,user_id,device_name,last_used,revoked_at'else'history_id,user_id,login_time,ip_address,status'end;
 execute format('grant select(%s)on public.%I to authenticated',cols,t);execute format('create policy connection_read on public.%I for select to authenticated using(session_boundary_private.visible(user_id))',t);
 end loop;end$$;
revoke all on function public.assert_request_access(text,text)from public,anon,authenticated,service_role;
grant execute on function public.assert_request_access(text,text)to authenticated;
notify pgrst,'reload schema';
