alter table public.tax_codes
  add column if not exists withholding_application_moment text;

update public.tax_codes
set withholding_application_moment = 'Al registrar la factura'
where is_withholding = true
  and withholding_application_moment is null;

update public.tax_codes
set withholding_application_moment = null
where is_withholding = false;

alter table public.tax_codes
  drop constraint if exists tax_codes_withholding_moment_valid;

alter table public.tax_codes
  add constraint tax_codes_withholding_moment_valid check (
    (is_withholding = true and withholding_application_moment in ('Al registrar la factura', 'Al aplicar el pago'))
    or
    (is_withholding = false and withholding_application_moment is null)
  );

comment on column public.tax_codes.withholding_application_moment is
  'Momento en que se reconoce la retención: al registrar la factura o al aplicar su pago.';

notify pgrst, 'reload schema';
