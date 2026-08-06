insert into public.users(email,password_hash,first_name,last_name,is_active)
values('daanny.valderrama@grupostt.com','auth:managed-by-supabase','Daanny','Valderrama',true)
on conflict(email) do update set is_active=true;

insert into public.user_subsidiaries(user_id,subsidiary_id)
select u.user_id,s.subsidiary_id
from public.users u
cross join public.subsidiaries s
where lower(u.email)='daanny.valderrama@grupostt.com'
  and s.subsidiary_id in (1,2,3)
  and s.is_active=true
on conflict(user_id,subsidiary_id) do nothing;
