create sequence if not exists public.uom_code_seq;

do $$declare current_max bigint;
begin
  select coalesce(max(substring(unit_code from '^UM-([0-9]{8})$')::bigint),0)
    into current_max from public.uom where unit_code ~ '^UM-[0-9]{8}$';
  if current_max=0 then perform setval('public.uom_code_seq',1,false);
  else perform setval('public.uom_code_seq',current_max,true); end if;
end$$;

alter table public.uom alter column unit_code
  set default ('UM-'||lpad(nextval('public.uom_code_seq')::text,8,'0'));

insert into public.uom(name,symbol)
select seed.name,seed.symbol
from (values
 ('Servicios Profesionales','Sp'),
 ('Servicios Personales','Spe'),
 ('Servicios Técnicos','St'),
 ('Otro tipo de servicio','Os'),
 ('Alquiler de uso habitacional','Al'),
 ('Alquiler de uso comercial','Alc'),
 ('Alquiler de uso mixto','Alm'),
 ('Unidad / Pieza','u / ea'),
 ('Kilogramo','kg'),
 ('Gramo','g'),
 ('Litro','L'),
 ('Metro','m'),
 ('Metro cuadrado','m²'),
 ('Metro cúbico','m³'),
 ('Centímetro cúbico','cc / cm³'),
 ('Galón','gal'),
 ('Kilómetro','km'),
 ('Kilovatio / Kilowatt','kW'),
 ('Quintal','qq'),
 ('Fanega (ej. sector cafetalero)','fa'),
 ('Activo Virtual / Criptoactivo','ACV'),
 ('Otras unidades de medida no contempladas','Ot')
) seed(name,symbol)
where not exists(select 1 from public.uom existing where lower(existing.name)=lower(seed.name));
