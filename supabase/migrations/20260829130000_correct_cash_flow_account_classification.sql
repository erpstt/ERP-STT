-- Uniformes y equipo de protección son gastos operativos. La clasificación
-- anterior como inversión separaba una reclasificación sin movimiento de efectivo.
update public.chart_accounts
set cash_flow_activity='OPERACION'
where account_number='612002'
  and category='Gasto'
  and cash_flow_activity='INVERSION';
