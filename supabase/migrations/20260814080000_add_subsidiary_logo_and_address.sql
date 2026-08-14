alter table public.subsidiaries
  add column if not exists logo_url text,
  add column if not exists address text;

comment on column public.subsidiaries.logo_url is
  'Logo corporativo en formato data URL (PNG, JPG, WebP o SVG; máximo 1 MB desde la aplicación).';
comment on column public.subsidiaries.address is
  'Dirección física o fiscal de la subsidiaria.';
