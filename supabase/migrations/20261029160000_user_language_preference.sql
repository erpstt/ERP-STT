-- Preferencia global de idioma por usuario. El catálogo Core > Idiomas sigue
-- siendo la fuente maestra y solo sus idiomas activos pueden seleccionarse.

alter table public.users
  add column if not exists language_id bigint references public.languages(language_id) on delete set null;

create index if not exists users_language_idx on public.users(language_id);

create or replace function public.app_supported_language_locale(
  p_code text,
  p_iso_code text
) returns text
language sql
immutable
set search_path=public,pg_temp
as $$
  select case
    when upper(btrim(coalesce(p_iso_code,''))) in ('ES','SPA','ESP','ES-ES','ES-CR')
      or upper(btrim(coalesce(p_code,''))) in ('ES','SPA','ESP','SPANISH','ESPAÑOL') then 'es'
    when upper(btrim(coalesce(p_iso_code,''))) in ('EN','ENG','EN-US','EN-GB')
      or upper(btrim(coalesce(p_code,''))) in ('EN','ENG','ENGLISH','INGLÉS','INGLES') then 'en'
    when upper(btrim(coalesce(p_iso_code,''))) in ('PT','POR','PRT','PT-BR','PT-PT')
      or upper(btrim(coalesce(p_code,''))) in ('PT','POR','PRT','PORTUGUESE','PORTUGUÊS','PORTUGUES') then 'pt'
    else null
  end
$$;

create or replace function public.user_language_preference()
returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
  current_user_id bigint:=public.app_user_id();
  selected_language public.languages%rowtype;
  selected_locale text;
  available_languages jsonb;
begin
  if current_user_id is null then
    raise exception using errcode='42501',message='No fue posible identificar al usuario autenticado.';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'languageId',language_id,
        'code',code,
        'isoCode',coalesce(iso_code,''),
        'locale',locale,
        'name',name
      ) order by case locale when 'es' then 1 when 'en' then 2 else 3 end,language_id
    ),
    '[]'::jsonb
  ) into available_languages
  from(
    select language_id,code,iso_code,name,
      public.app_supported_language_locale(code,iso_code) locale
    from public.languages
    where is_active
  ) supported
  where locale is not null;

  select language.* into selected_language
  from public.users account
  join public.languages language on language.language_id=account.language_id
  where account.user_id=current_user_id
    and language.is_active
    and public.app_supported_language_locale(language.code,language.iso_code) is not null;

  if selected_language.language_id is null then
    select language.* into selected_language
    from public.languages language
    where language.is_active
      and public.app_supported_language_locale(language.code,language.iso_code)='es'
    order by language.language_id
    limit 1;
  end if;

  selected_locale:=coalesce(
    public.app_supported_language_locale(selected_language.code,selected_language.iso_code),
    'es'
  );

  return jsonb_build_object(
    'languageId',selected_language.language_id,
    'code',coalesce(selected_language.code,''),
    'isoCode',coalesce(selected_language.iso_code,''),
    'locale',selected_locale,
    'name',coalesce(selected_language.name,case selected_locale when 'en' then 'English' when 'pt' then 'Português' else 'Español' end),
    'languages',available_languages
  );
end;
$$;

create or replace function public.set_user_language_preference(p_locale text)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  current_user_id bigint:=public.app_user_id();
  requested_locale text:=lower(split_part(btrim(coalesce(p_locale,'')),'-',1));
  selected_language_id bigint;
begin
  if current_user_id is null then
    raise exception using errcode='42501',message='No fue posible identificar al usuario autenticado.';
  end if;
  if requested_locale not in('es','en','pt') then
    raise exception using errcode='22023',message='Seleccione un idioma compatible: Español, Inglés o Portugués.';
  end if;

  select language_id into selected_language_id
  from public.languages
  where is_active
    and public.app_supported_language_locale(code,iso_code)=requested_locale
  order by language_id
  limit 1;

  if selected_language_id is null then
    raise exception using errcode='22023',message='El idioma seleccionado no está activo en Core > Idiomas.';
  end if;

  update public.users
  set language_id=selected_language_id
  where user_id=current_user_id;

  return public.user_language_preference();
end;
$$;

-- El perfil propio se consulta y actualiza solamente mediante los RPC de
-- preferencia; no se amplían los permisos generales de edición de usuarios.
revoke all on function public.app_supported_language_locale(text,text) from public,anon,authenticated;
revoke all on function public.user_language_preference() from public,anon;
revoke all on function public.set_user_language_preference(text) from public,anon;
grant execute on function public.user_language_preference() to authenticated,service_role;
grant execute on function public.set_user_language_preference(text) to authenticated,service_role;

comment on column public.users.language_id is
  'Idioma global preferido por el usuario, seleccionado desde el catálogo Core > Idiomas.';
comment on function public.user_language_preference() is
  'Devuelve el idioma global del usuario y las opciones activas soportadas por la interfaz.';
comment on function public.set_user_language_preference(text) is
  'Actualiza exclusivamente el idioma del usuario autenticado validando Core > Idiomas.';

notify pgrst,'reload schema';
