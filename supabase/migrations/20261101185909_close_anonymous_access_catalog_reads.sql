-- No anonymous SELECT, including empty RLS-filtered lists and column grants.
do $$declare t text;c record;begin foreach t in array array['users','roles','user_roles','user_subsidiaries','permissions','role_permissions','role_access_matrix']loop
 execute format('revoke select on public.%I from public,anon',t);
 for c in select column_name from information_schema.columns where table_schema='public'and table_name=t loop execute format('revoke select(%I)on public.%I from public,anon',c.column_name,t);end loop;
 end loop;end$$;
notify pgrst,'reload schema';
