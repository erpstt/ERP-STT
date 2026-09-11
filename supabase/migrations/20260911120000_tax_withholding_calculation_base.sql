alter table tax_codes add column if not exists withholding_calculation_base text;
update tax_codes set withholding_calculation_base='Subtotal antes de impuestos'where is_withholding and withholding_calculation_base is null;
update tax_codes set withholding_calculation_base=null where not is_withholding;
alter table tax_codes drop constraint if exists tax_codes_withholding_base_valid;
alter table tax_codes add constraint tax_codes_withholding_base_valid check(
 (is_withholding and withholding_calculation_base in('Subtotal antes de impuestos','Importe de impuestos','Total de la factura con impuestos'))
 or(not is_withholding and withholding_calculation_base is null)
);
comment on column tax_codes.withholding_calculation_base is'Importe sobre el cual se calcula el porcentaje de retención.';
notify pgrst,'reload schema';
