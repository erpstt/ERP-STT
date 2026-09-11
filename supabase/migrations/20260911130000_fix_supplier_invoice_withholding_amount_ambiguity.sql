create or replace function public.save_supplier_invoice(payload jsonb,target_invoice_id bigint default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  result jsonb;iid bigint;jid bigint;sid bigint:=active_subsidiary_id();supplier_key bigint;
  subtotal numeric:=0;taxes numeric:=0;gross numeric:=0;invoice_withheld numeric:=0;all_withheld numeric:=0;
  rule record;calculation_base_amount numeric;calculated_withholding numeric;ap_account bigint;
begin
  if target_invoice_id is not null and exists(select 1 from supplier_payment_application spa where spa.invoice_id=target_invoice_id) then
    raise exception 'La factura tiene pagos aplicados y sus retenciones ya no pueden recalcularse.';
  end if;
  result:=save_supplier_invoice_without_withholding(payload,target_invoice_id);
  iid:=(result->>'invoiceId')::bigint;jid:=(result->>'journalId')::bigint;supplier_key:=(payload->>'supplier_id')::bigint;
  select coalesce(sum(sil.amount),0),coalesce(sum(sil.tax_amount),0),coalesce(sum(sil.gross_amount),0)
  into subtotal,taxes,gross
  from supplier_invoice_line sil
  where sil.invoice_id=iid;
  delete from supplier_invoice_withholding siw where siw.invoice_id=iid;
  select jl.account_id into ap_account
  from journal_line jl
  join chart_accounts ca on ca.account_id=jl.account_id
  where jl.journal_id=jid and jl.credit>0 and ca.category='Pasivo'
    and ca.account_name~*'cuenta.*por pagar|proveedor.*por pagar'
  order by jl.credit desc limit 1;
  for rule in
    select r.rule_id,tc.tax_code_id,tc.code_name,tc.rate_percentage,tc.withholding_calculation_base,tc.withholding_application_moment,tt.liability_account_id
    from entity_withholding_rules r
    join tax_codes tc on tc.tax_code_id=r.tax_code_id
    join tax_types tt on tt.tax_type_id=tc.tax_type_id
    where r.supplier_id=supplier_key and r.subsidiary_id=sid and tc.is_withholding and tt.applies_to in('Compras','Ambos')
  loop
    if rule.liability_account_id is null or not exists(select 1 from account_subsidiaries asa where asa.account_id=rule.liability_account_id and asa.subsidiary_id=sid and asa.is_active) then
      raise exception 'La retención % no tiene una Cuenta Pasivo activa para la subsidiaria.',rule.code_name;
    end if;
    calculation_base_amount:=case rule.withholding_calculation_base when 'Importe de impuestos' then taxes when 'Total de la factura con impuestos' then gross else subtotal end;
    calculated_withholding:=round(calculation_base_amount*rule.rate_percentage/100,6);
    all_withheld:=all_withheld+calculated_withholding;
    insert into supplier_invoice_withholding(invoice_id,entity_rule_id,tax_code_id,liability_account_id,calculation_base,base_amount,rate_percentage,withholding_amount,application_moment,recognized_at_invoice)
    values(iid,rule.rule_id,rule.tax_code_id,rule.liability_account_id,rule.withholding_calculation_base,calculation_base_amount,rule.rate_percentage,calculated_withholding,rule.withholding_application_moment,rule.withholding_application_moment='Al registrar la factura');
    if rule.withholding_application_moment='Al registrar la factura' and calculated_withholding>0 then
      invoice_withheld:=invoice_withheld+calculated_withholding;
      insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,tax_code_id,tax_rate,gross_amount,note,entity_type,supplier_id)
      values(jid,rule.liability_account_id,0,calculated_withholding,0,calculated_withholding,rule.tax_code_id,rule.rate_percentage,calculation_base_amount,'Retención '||rule.code_name||' al registrar la factura','Proveedor',supplier_key);
    end if;
  end loop;
  if invoice_withheld>gross then raise exception 'Las retenciones al registrar no pueden superar el total de la factura.';end if;
  if invoice_withheld>0 then
    update journal_line jl set credit=jl.credit-invoice_withheld,credit_fx=jl.credit_fx-invoice_withheld where jl.journal_id=jid and jl.account_id=ap_account;
  end if;
  update supplier_invoice si set subtotal_amount=subtotal,tax_total=taxes,withholding_total=all_withheld,payable_amount=gross-invoice_withheld where si.invoice_id=iid;
  perform sync_journal_gl_impacts(jid);
  return result||jsonb_build_object('subtotal',subtotal,'taxTotal',taxes,'withholdingTotal',all_withheld,'withholdingAtInvoice',invoice_withheld,'payableTotal',gross-invoice_withheld);
end$$;

revoke all on function public.save_supplier_invoice(jsonb,bigint) from public,anon;
grant execute on function public.save_supplier_invoice(jsonb,bigint) to authenticated;
notify pgrst,'reload schema';
