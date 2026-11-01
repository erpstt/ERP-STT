CREATE OR REPLACE FUNCTION public.validate_accounting_period()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare fiscal_start date; fiscal_end date;
begin
  select start_date,end_date into fiscal_start,fiscal_end from public.fiscal_years where fiscal_year_id=new.fiscal_year_id;
  if new.end_date<new.start_date then raise exception 'La fecha final no puede ser anterior a la fecha inicial.'; end if;
  if fiscal_start is not null and (new.start_date<fiscal_start or new.end_date>fiscal_end) then raise exception 'El período debe estar dentro de las fechas del año fiscal seleccionado.'; end if;
  if exists(select 1 from public.fiscal_periods p where p.subsidiary_id=new.subsidiary_id and p.fiscal_period_id<>coalesce(new.fiscal_period_id,0) and daterange(p.start_date,p.end_date,'[]') && daterange(new.start_date,new.end_date,'[]')) then raise exception 'Ya existe otro período contable para esta subsidiaria dentro del rango indicado.'; end if;
  if new.gl_closed and not(new.ap_closed and new.ar_closed) then raise exception 'Debe cerrar primero Compras (AP) y Ventas/Cuentas por cobrar (AR).'; end if;
  if new.is_closed and not(new.ap_closed and new.ar_closed and new.gl_closed) then raise exception 'Para cerrar el período deben estar cerrados AP, AR y GL.'; end if;
  if new.is_closed then new.checklist_completed:=true; end if;
  return new;
end $function$;
