-- Expand first. Activation is a separate migration after the compatible server deploy.
create schema session_boundary_private;
revoke all on schema session_boundary_private from public,anon,authenticated,service_role;
grant usage on schema session_boundary_private to authenticated;
alter table public.devices add column revoked_at timestamptz;
alter table public.sessions add column auth_session_id uuid,add column device_id bigint references public.devices(device_id),add column revoked_at timestamptz;
create index sessions_auth_device_idx on public.sessions(auth_session_id,device_id)where revoked_at is null;

create function session_boundary_private.identity()returns bigint language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare u bigint;sid uuid;dh text;begin
 begin sid:=(auth.jwt()->>'session_id')::uuid;dh:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb->>'x-erp-device-hash';exception when invalid_text_representation then return null;end;
 if auth.uid()is null or sid is null or dh is null or dh!~'^[0-9a-f]{64}$'then return null;end if;
 select a.user_id into u from public.users a join auth.sessions sa on sa.user_id=a.auth_user_id and sa.id=sid
 join public.sessions s on s.auth_session_id=sa.id and s.user_id=a.user_id and s.expires_at>now()and s.revoked_at is null
 join public.devices d on d.device_id=s.device_id and d.user_id=a.user_id and d.device_token=dh and d.revoked_at is null
 where a.auth_user_id=auth.uid()and a.is_active and(sa.not_after is null or sa.not_after>now())limit 1;return u;end$$;
create function session_boundary_private.central()returns boolean language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$select exists(select 1 from public.roles where role_id=public.app_active_role_id()and is_system_role and lower(btrim(role_name))in('administrador','administrator','admin'))$$;
create function session_boundary_private.visible(owner_id bigint)returns boolean language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$select session_boundary_private.identity()is not null and(owner_id=session_boundary_private.identity()or session_boundary_private.central())$$;

create function public.security_register_login(p_auth_user_id uuid,p_auth_session_id uuid,p_session_token_hash text,p_device_token_hash text,p_device_name text,p_expires_at timestamptz,p_ip_address inet default null)returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare u bigint;did bigint;existing public.devices;expiry timestamptz;
begin
 if p_auth_user_id is null or p_auth_session_id is null or p_session_token_hash is null or p_session_token_hash!~'^[0-9a-f]{64}$'or p_device_token_hash is null or p_device_token_hash!~'^[0-9a-f]{64}$'or p_expires_at is null or p_expires_at<=clock_timestamp()then raise exception using errcode='42501',message='Credenciales de registro no autorizadas.';end if;
 select a.user_id,least(p_expires_at,clock_timestamp()+interval '15 minutes',coalesce(sa.not_after,'infinity'::timestamptz))into u,expiry from public.users a join auth.sessions sa on sa.user_id=a.auth_user_id and sa.id=p_auth_session_id where a.auth_user_id=p_auth_user_id and a.is_active and(sa.not_after is null or sa.not_after>clock_timestamp());
 if u is null then raise exception using errcode='42501',message='La identidad no esta activa en el ERP.';end if;
 perform pg_advisory_xact_lock(793153,1);
 select *into existing from public.devices where device_token=p_device_token_hash for update;
 if found and(existing.user_id<>u or existing.revoked_at is not null)then raise exception using errcode='42501',message='Dispositivo no autorizado.';end if;
 if existing.device_id is null then insert into public.devices(user_id,device_name,device_token,last_used)values(u,left(coalesce(nullif(btrim(p_device_name),''),'Navegador'),240),p_device_token_hash,clock_timestamp())returning device_id into did;
 else did:=existing.device_id;update public.devices set last_used=clock_timestamp(),device_name=left(coalesce(nullif(btrim(p_device_name),''),'Navegador'),240)where device_id=did;end if;
 insert into public.sessions(user_id,auth_session_id,device_id,session_token,expires_at,ip_address)values(u,p_auth_session_id,did,p_session_token_hash,expiry,p_ip_address);
 insert into public.login_history(user_id,status,ip_address)values(u,'EXITOSO',p_ip_address);
 return jsonb_build_object('userId',u,'expiresAt',expiry);end$$;

create function public.security_connection_catalog(p_catalog text)returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare u bigint:=session_boundary_private.identity();d jsonb;begin if u is null then raise exception using errcode='42501',message='Sesion no autorizada.';end if;
 if p_catalog='sessions'then select coalesce(jsonb_agg(jsonb_build_object('session_id',s.session_id,'user_id',s.user_id,'ip_address',s.ip_address,'expires_at',s.expires_at,'created_at',s.created_at,'_revision',md5(to_jsonb(s)::text),'_actions',jsonb_build_object('canEdit',false,'canDelete',true))order by s.session_id),'[]')into d from public.sessions s where s.revoked_at is null and s.expires_at>now()and session_boundary_private.visible(s.user_id);
 elsif p_catalog='devices'then select coalesce(jsonb_agg(jsonb_build_object('device_id',r.device_id,'user_id',r.user_id,'device_name',r.device_name,'last_used',r.last_used,'_revision',md5(to_jsonb(r)::text),'_actions',jsonb_build_object('canEdit',false,'canDelete',true))order by r.device_id),'[]')into d from public.devices r where r.revoked_at is null and session_boundary_private.visible(r.user_id);
 elsif p_catalog='login-history'then select coalesce(jsonb_agg(to_jsonb(r)order by r.history_id desc),'[]')into d from(select h.history_id,h.user_id,h.login_time,h.ip_address,h.status from public.login_history h where session_boundary_private.visible(h.user_id)order by history_id desc limit 1000)r;
 else raise exception using errcode='42501',message='Catalogo no disponible.';end if;return d;end$$;
create function public.security_revoke_connection(p_catalog text,p_id bigint,p_revision text)returns boolean language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare u bigint:=session_boundary_private.identity();r jsonb;begin if u is null or p_catalog not in('sessions','devices')then raise exception using errcode='42501',message='Revocacion no autorizada.';end if;perform pg_advisory_xact_lock(793153,1);
 if p_catalog='sessions'then select to_jsonb(s)into r from public.sessions s where s.session_id=p_id and s.revoked_at is null for update;
 else select to_jsonb(d)into r from public.devices d where d.device_id=p_id and d.revoked_at is null for update;end if;
 if r is null or not session_boundary_private.visible((r->>'user_id')::bigint)then raise exception using errcode='42501',message='Conexion no autorizada.';end if;
 if p_revision is null or p_revision is distinct from md5(r::text)then raise exception using errcode='55000',message='La conexion cambio. Consulte nuevamente.';end if;
 if p_catalog='devices'then update public.devices set revoked_at=clock_timestamp()where device_id=p_id;update public.sessions set revoked_at=clock_timestamp()where device_id=p_id and revoked_at is null;
 else update public.sessions set revoked_at=clock_timestamp()where session_id=p_id;end if;
 delete from public.user_role_sessions c where c.user_id=(r->>'user_id')::bigint and not exists(select 1 from public.sessions s where s.auth_session_id::text=c.session_id and s.user_id=c.user_id and s.revoked_at is null and s.expires_at>now());
 delete from public.user_company_sessions c where c.user_id=(r->>'user_id')::bigint and not exists(select 1 from public.sessions s where s.auth_session_id::text=c.session_id and s.user_id=c.user_id and s.revoked_at is null and s.expires_at>now());return true;end$$;
create function public.security_logout_session()returns boolean language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare u bigint:=session_boundary_private.identity();sid text:=auth.jwt()->>'session_id';begin if u is null then return false;end if;perform pg_advisory_xact_lock(793153,1);update public.sessions set revoked_at=clock_timestamp()where user_id=u and auth_session_id::text=sid and revoked_at is null;delete from public.user_role_sessions where user_id=u and session_id=sid;delete from public.user_company_sessions where user_id=u and session_id=sid;return true;end$$;
create function public.security_revoke_user_sessions(p_user_id bigint)returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin perform pg_advisory_xact_lock(793153,1);update public.sessions set revoked_at=clock_timestamp()where user_id=p_user_id and revoked_at is null;delete from public.user_role_sessions where user_id=p_user_id;delete from public.user_company_sessions where user_id=p_user_id;end$$;
revoke all on all functions in schema session_boundary_private from public,anon,authenticated,service_role;
grant execute on function session_boundary_private.visible(bigint)to authenticated;
revoke all on function public.security_register_login(uuid,uuid,text,text,text,timestamptz,inet)from public,anon,authenticated,service_role;
grant execute on function public.security_register_login(uuid,uuid,text,text,text,timestamptz,inet)to service_role;
revoke all on function public.security_revoke_user_sessions(bigint)from public,anon,authenticated,service_role;
grant execute on function public.security_revoke_user_sessions(bigint)to service_role;
revoke all on function public.security_connection_catalog(text),public.security_revoke_connection(text,bigint,text),public.security_logout_session()from public,anon,authenticated,service_role;
grant execute on function public.security_connection_catalog(text),public.security_revoke_connection(text,bigint,text),public.security_logout_session()to authenticated;
notify pgrst,'reload schema';
