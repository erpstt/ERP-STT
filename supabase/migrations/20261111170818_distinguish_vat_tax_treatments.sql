-- Explicit VAT treatment. Preserve report access checks and historical tax/GL amounts.
set local lock_timeout='5s';
set local statement_timeout='60s';
alter table public.tax_codes add column tax_treatment text not null default 'Sin clasificar';
update public.tax_codes set tax_treatment='Gravado' where rate_percentage>0;
update public.tax_codes t set tax_treatment=case t.code_name when 'IVA-SV-EXENTO' then 'Exento' when 'IVA-SV-NOSUJETO' then 'No sujeto' end
from public.countries c where c.country_id=t.country_id and c.name='El Salvador' and t.code_name in('IVA-SV-EXENTO','IVA-SV-NOSUJETO') and t.rate_percentage=0 and not t.is_withholding and not t.is_purchase_creditable;
alter table public.tax_codes add constraint tax_codes_treatment_allowed check(tax_treatment in('Gravado','Exento','No sujeto','Tasa cero','Sin clasificar'));
alter table public.tax_codes add constraint tax_codes_treatment_conditions check(
 (tax_treatment not in('Exento','No sujeto','Tasa cero') or (rate_percentage=0 and not is_withholding and not is_import_tax))
 and (tax_treatment not in('Exento','No sujeto') or not is_purchase_creditable)
 and (tax_treatment<>'Gravado' or rate_percentage>0));

-- Patch only the field allowlist; existing authorization and immutability remain.
do $patch$ declare body text; old text; begin
 body:=pg_get_functiondef('tax_catalog_private.meta(text)'::regprocedure);
 old:='''rate_percentage'',''is_withholding''';
 if position(old in body)=0 then raise exception 'Tax catalog metadata differs';end if;
 execute replace(body,old,'''rate_percentage'',''tax_treatment'',''is_withholding''');
end $patch$;

-- Keep the RPC defaults compatible with its new allowlisted field.
do $patch$ declare body text;old text;begin
 body:=pg_get_functiondef('public.save_tax_catalog(text,jsonb,bigint)'::regprocedure);
 old:='"is_import_tax":false}';
 if position(old in body)=0 then raise exception 'Tax code defaults differ';end if;
 execute replace(body,old,'"is_import_tax":false,"tax_treatment":"Sin clasificar"}');
end $patch$;

-- Patch the installed report, preserving all current authorization guards and grants.
do $patch$ declare body text; old text; replacement text; expected integer; begin
 body:=pg_get_functiondef('public.run_vat_declaration_report(jsonb)'::regprocedure);
 old:=$old$tc.is_purchase_creditable,tc.is_import_tax,$old$;replacement:=$new$tc.is_purchase_creditable,tc.is_import_tax,tc.tax_treatment,$new$;expected:=1;
 if (length(body)-length(replace(body,old,'')))/length(old)<>expected then raise exception 'Unexpected VAT report definition: %',left(old,80);end if;
 body:=replace(body,old,replacement);
 old:=$old$when coalesce(line.tax_rate,tax.rate_percentage,0)=0 then tax.type_name||' · Tarifa 0%'$old$;replacement:=$new$when tax.tax_treatment in('Exento','No sujeto','Tasa cero') then tax.type_name||' · '||tax.tax_treatment
        when coalesce(line.tax_rate,tax.rate_percentage,0)=0 then tax.type_name||' · Sin clasificar (0%)'$new$;expected:=4;
 if (length(body)-length(replace(body,old,'')))/length(old)<>expected then raise exception 'Unexpected VAT report definition: %',left(old,80);end if;
 body:=replace(body,old,replacement);
 old:=$old$when coalesce(line.tax_rate,tax.rate_percentage,0)=0 then'ZERO_RATE'$old$;replacement:=$new$when tax.tax_treatment='Exento' then'EXEMPT'
        when tax.tax_treatment='No sujeto' then'NON_SUBJECT'
        when tax.tax_treatment='Tasa cero' then'ZERO_RATE'
        when coalesce(line.tax_rate,tax.rate_percentage,0)=0 then'UNCLASSIFIED'$new$;expected:=4;
 if (length(body)-length(replace(body,old,'')))/length(old)<>expected then raise exception 'Unexpected VAT report definition: %',left(old,80);end if;
 body:=replace(body,old,replacement);
 old:=$old$when not tax.is_purchase_creditable then'NON_CREDITABLE'$old$;replacement:=$new$when tax.tax_treatment='Exento' then'EXEMPT'
        when tax.tax_treatment='No sujeto' then'NON_SUBJECT'
        when tax.tax_treatment='Tasa cero' then'ZERO_RATE'
        when coalesce(line.tax_rate,tax.rate_percentage,0)=0 then'UNCLASSIFIED'
        when not tax.is_purchase_creditable then'NON_CREDITABLE'$new$;expected:=2;
 if (length(body)-length(replace(body,old,'')))/length(old)<>expected then raise exception 'Unexpected VAT report definition: %',left(old,80);end if;
 body:=replace(body,old,replacement);
 old:=$old$when not tax.is_purchase_creditable then tax.type_name||' · Impuesto no acreditable'$old$;replacement:=$new$when tax.tax_treatment in('Exento','No sujeto','Tasa cero') then tax.type_name||' · '||tax.tax_treatment
        when coalesce(line.tax_rate,tax.rate_percentage,0)=0 then tax.type_name||' · Sin clasificar (0%)'
        when not tax.is_purchase_creditable then tax.type_name||' · Impuesto no acreditable'$new$;expected:=2;
 if (length(body)-length(replace(body,old,'')))/length(old)<>expected then raise exception 'Unexpected VAT report definition: %',left(old,80);end if;
 body:=replace(body,old,replacement);
 old:=$old$coalesce(sum(base_amount)filter(where side='SALES'and(not tax_reportable or tax_rate=0)),0)sales_exempt_base,$old$;replacement:=$new$coalesce(sum(base_amount)filter(where side='SALES'and tax_classification='EXEMPT'),0)sales_exempt_base,
   coalesce(sum(base_amount)filter(where side='SALES'and tax_classification='NON_SUBJECT'),0)sales_non_subject_base,
   coalesce(sum(base_amount)filter(where side='SALES'and tax_classification='ZERO_RATE'),0)sales_zero_rate_base,
   coalesce(sum(base_amount)filter(where side='SALES'and tax_classification not in('EXEMPT','NON_SUBJECT','ZERO_RATE')and(not tax_reportable or tax_rate=0)),0)sales_unclassified_base,$new$;expected:=1;
 if (length(body)-length(replace(body,old,'')))/length(old)<>expected then raise exception 'Unexpected VAT report definition: %',left(old,80);end if;
 body:=replace(body,old,replacement);
 old:=$old$'salesExemptBase',sales_exempt_base,$old$;replacement:=$new$'salesExemptBase',sales_exempt_base,'salesNonSubjectBase',sales_non_subject_base,'salesZeroRateBase',sales_zero_rate_base,'salesUnclassifiedBase',sales_unclassified_base,$new$;expected:=1;
 if (length(body)-length(replace(body,old,'')))/length(old)<>expected then raise exception 'Unexpected VAT report definition: %',left(old,80);end if;
 body:=replace(body,old,replacement);
 old:=$old$coalesce(sum(base_amount)filter(where side='PURCHASES'and(not tax_reportable or tax_rate=0)),0)purchase_exempt_base,$old$;replacement:=$new$coalesce(sum(base_amount)filter(where side='PURCHASES'and tax_classification='EXEMPT'),0)purchase_exempt_base,
   coalesce(sum(base_amount)filter(where side='PURCHASES'and tax_classification='NON_SUBJECT'),0)purchase_non_subject_base,
   coalesce(sum(base_amount)filter(where side='PURCHASES'and tax_classification='ZERO_RATE'),0)purchase_zero_rate_base,
   coalesce(sum(base_amount)filter(where side='PURCHASES'and tax_classification not in('EXEMPT','NON_SUBJECT','ZERO_RATE')and(not tax_reportable or tax_rate=0)),0)purchase_unclassified_base,$new$;expected:=1;
 if (length(body)-length(replace(body,old,'')))/length(old)<>expected then raise exception 'Unexpected VAT report definition: %',left(old,80);end if;
 body:=replace(body,old,replacement);
 old:=$old$'purchaseExemptBase',purchase_exempt_base,$old$;replacement:=$new$'purchaseExemptBase',purchase_exempt_base,'purchaseNonSubjectBase',purchase_non_subject_base,'purchaseZeroRateBase',purchase_zero_rate_base,'purchaseUnclassifiedBase',purchase_unclassified_base,$new$;expected:=1;
 if (length(body)-length(replace(body,old,'')))/length(old)<>expected then raise exception 'Unexpected VAT report definition: %',left(old,80);end if;
 body:=replace(body,old,replacement);
 old:=$old$(case when prior_credit>0 then$old$;replacement:=$new$(case when exists(select 1 from details where tax_classification='UNCLASSIFIED')then'Hay códigos con porcentaje cero sin clasificación fiscal. Revise si son exentos, no sujetos o de tasa cero.'end),
    (case when prior_credit>0 then$new$;expected:=1;
 if (length(body)-length(replace(body,old,'')))/length(old)<>expected then raise exception 'Unexpected VAT report definition: %',left(old,80);end if;
 body:=replace(body,old,replacement);
 execute body;
end $patch$;
notify pgrst,'reload schema';
