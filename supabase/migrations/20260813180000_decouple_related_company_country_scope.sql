drop trigger if exists related_company_subsidiary_country_check
  on public.related_company_subsidiaries;

drop function if exists public.validate_related_company_subsidiary_country();
