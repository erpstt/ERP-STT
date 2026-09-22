import {escapeHtml as esc} from '../notifications/payment-email.js';
type RecordRow=Record<string,any>;
type Report={kind:string;title?:string;company:string;currency:string;cutoff:string;dateFrom?:string;data?:RecordRow};
type Section={title:string;columns:string[];rows:unknown[][]};
const labels:Record<string,string>={
 rows:'Detalle',summary:'Resumen',lines:'Líneas del asiento',reversals:'Reversiones',runs:'Revaluaciones',accounts:'Cuentas',impairments:'Deterioros',disposals:'Bajas',period:'Período contable',localCurrency:'Moneda local',localAccounts:'Cuentas en moneda local',foreignAccounts:'Cuentas en moneda extranjera',localValidationGroups:'Conciliación en moneda local',foreignValidationGroups:'Conciliación en moneda extranjera',statementLines:'Movimientos del extracto',reconciliation:'Conciliación registrada',
 account_number:'Cuenta',account_name:'Nombre de cuenta',account:'Cuenta',accountNumber:'Cuenta',accountName:'Nombre de cuenta',date:'Fecha',issue_date:'Fecha de emisión',value_date:'Fecha valor',bank_date:'Fecha banco',closing_date:'Fecha de corte',reference:'Referencia',document_number:'Documento',document_type:'Tipo de documento',document_status:'Estado del documento',referenced_document:'Documento relacionado',journal_number:'Asiento',journalNumber:'Asiento',reversalNumber:'Asiento de reversión',transaction_number:'Transacción',transaction_type:'Tipo de transacción',transaction_code:'Código de transacción',module_category:'Módulo',
 debit:'Débito',credit:'Crédito',opening:'Saldo inicial',closing:'Saldo final',opening_balance:'Saldo inicial',running_balance:'Saldo acumulado',account_debit_total:'Débitos de la cuenta',account_credit_total:'Créditos de la cuenta',account_final_balance:'Saldo final de la cuenta',balance:'Saldo',initial:'Monto inicial',reversed:'Monto reversado',difference:'Diferencia',amount:'Importe',total:'Total',subtotal:'Subtotal',tax:'Impuestos',discount:'Descuento',taxable_base:'Base imponible',netBase:'Base neta',invoices:'Facturas',debitNotes:'Notas de débito',creditNotes:'Notas de crédito',netSales:'Ventas netas',netPurchases:'Compras netas',
 customer:'Cliente',customer_name:'Cliente',supplier_name:'Proveedor',supplier_category:'Categoría de proveedor',customer_tax_id:'Identificación del cliente',supplier_tax_id:'Identificación del proveedor',seller_name:'Vendedor',entity_name:'Tercero',entity_type:'Tipo de tercero',beneficiary:'Beneficiario',cost_center:'Centro de costo',cost_centers:'Centros de costo',subsidiary:'Sociedad',currency:'Moneda',currency_code:'Moneda',currencyName:'Nombre de moneda',code:'Código',name:'Nombre',symbol:'Símbolo',
 note:'Nota',memo:'Concepto',concept:'Concepto',description:'Descripción',status:'Estado',effective_status:'Estado efectivo',created_by:'Elaborado por',created_at:'Fecha de creación',posted_at:'Fecha de contabilización',cancelled_at:'Fecha de anulación',cancellation_reason:'Motivo de anulación',category:'Categoría',nature:'Naturaleza',cash_flow_activity:'Actividad de flujo de efectivo',
 asset:'Activo',number:'Código',assetAccount:'Cuenta de activo',depreciationAccount:'Cuenta de depreciación',ledgerCost:'Costo en Mayor',registerCost:'Costo en auxiliar',costDifference:'Diferencia de costo',ledgerDepreciation:'Depreciación en Mayor',registerDepreciation:'Depreciación en auxiliar',depreciationDifference:'Diferencia de depreciación',monthly:'Depreciación mensual',remaining:'Valor por depreciar',remainingMonths:'Meses restantes',projectedEnd:'Final proyectado',carryingAmount:'Valor en libros',recoverableAmount:'Valor recuperable',loss:'Pérdida',saleAmount:'Valor de venta',gainLoss:'Ganancia / pérdida',type:'Tipo',
 bank:'Banco',rate:'Tipo de cambio',closing_rate:'Tipo de cambio de cierre',balanceLocal:'Saldo local',balanceForeign:'Saldo extranjero',ledgerAccount:'Cuenta contable',ledgerAccountName:'Nombre de cuenta contable',ledgerBalance:'Saldo en Mayor',bankTotal:'Total bancario',localEquivalent:'Equivalente local',missingRate:'Falta tipo de cambio',revalued:'Revaluada',revaluedAt:'Fecha de revaluación',revaluationStatus:'Estado de revaluación',revaluationJournal:'Asiento de revaluación',matches:'Conciliado',allMatch:'Todas las cuentas conciliadas',missingRates:'Tipos de cambio faltantes',localBankBalance:'Saldo bancario local',localLedgerBalance:'Saldo local en Mayor',foreignLocalEquivalent:'Moneda extranjera expresada en local',foreignLedgerBalance:'Saldo extranjero en Mayor',totalLocalEquivalent:'Total equivalente local',totalLedgerBalance:'Total en Mayor',
 deposits:'Depósitos',withdrawals:'Retiros',bookBalance:'Saldo en libros',statementBalance:'Saldo del extracto',transitDeposits:'Depósitos en tránsito',transitPayments:'Pagos en tránsito',book_balance:'Saldo en libros',statement_balance:'Saldo del extracto',transit_deposits:'Depósitos en tránsito',transit_payments:'Pagos en tránsito',bank_adjustments:'Ajustes bancarios',reconciliation_status:'Estado de conciliación',reconciliation_date:'Fecha de conciliación',closed_at:'Fecha de cierre',
 balanced:'Cuadrado',finalDebtor:'Saldo final deudor',finalCreditor:'Saldo final acreedor',openingDebtor:'Saldo inicial deudor',openingCreditor:'Saldo inicial acreedor',resultExercise:'Resultado contabilizado del ejercicio',currentPeriodResult:'Resultado acumulado del ejercicio',periodResult:'Resultado del período',start:'Desde',end:'Hasta',auto_reverse:'Reversión automática',reversal_date:'Fecha de reversión',rate_reason:'Motivo del tipo de cambio',rate_source:'Origen del tipo de cambio',tax_note:'Nota fiscal',gain_taxable:'Ganancia gravable',loss_deductible:'Pérdida deducible'
};
const label=(key:string)=>labels[key]||key.replace(/([a-z])([A-Z])/g,'$1 $2').replaceAll('_',' ');
Object.assign(labels,{scopeNote:'Alcance',bankAccount:'Cuenta bancaria',value:'Valor',foreignBalance:'Saldo extranjero',foreign_balance:'Saldo extranjero',book_value:'Valor en libros',revalued_balance:'Saldo revaluado',currentLocal:'Saldo local actual',targetLocal:'Saldo local revaluado',adjustment:'Ajuste',gain:'Ganancia',loss:'Pérdida'});
const hidden=(key:string)=>!['customer_tax_id','supplier_tax_id'].includes(key)&&(key==='id'||key.endsWith('_id')||key.endsWith('Id')||['page','pageSize','total_count','fingerprint','snapshot','groupMode','actor_type','actor_source','updated_actor_type','updated_actor_source','created_by_id','updated_by_id','created_by_email','updated_by_email','created_by_name','updated_by_name','closed_by','cancelled_by'].includes(key));
const isScalar=(v:unknown)=>v===null||typeof v!=='object';
const number=(v:unknown)=>Number(v||0);
const formatted=(v:unknown)=>typeof v==='number'?v.toLocaleString('es-CR',{minimumFractionDigits:2,maximumFractionDigits:6}):typeof v==='boolean'?(v?'Sí':'No'):v===null||v===undefined?'—':String(v);

// Match the financial calculations used by the interactive reports; detail remains available below.
function financialSections(report:Report):Section[]{
 const rows:RecordRow[]=report.data?.rows||[],summary=report.data?.summary||{},sections:Section[]=[];
 const result=Math.abs(number(summary.currentPeriodResult))>.005?number(summary.currentPeriodResult):number(summary.resultExercise);
 const push=(title:string,values:[string,number][])=>sections.push({title,columns:['Concepto','Importe'],rows:values});
 if(report.kind==='balance-sheet'){
  const sum=(category:string)=>rows.filter(r=>r.category===category&&!/resultado del ejercicio/i.test(r.account_name||'')).reduce((s,r)=>s+number(r.closing)*(category==='Activo'?1:-1),0);
  const asset=sum('Activo'),liability=sum('Pasivo'),equity=rows.filter(r=>!['Activo','Pasivo'].includes(r.category)&&!/resultado del ejercicio/i.test(r.account_name||'')).reduce((s,r)=>s-number(r.closing),0)+result;
  push('Situación financiera',[['Activo',asset],['Pasivo',liability],['Resultado del ejercicio',result],['Patrimonio (incluye resultado)',equity],['Pasivo y patrimonio',liability+equity],['Diferencia',asset-liability-equity]]);
 }
 if(report.kind==='income-statement'){
  const totals={revenue:0,cost:0,expense:0,nonop:0,tax:0};
  for(const r of rows){const name=String(r.account_name||'').toLowerCase(),amount=(number(r.debit)-number(r.credit))*(r.category==='Ingreso'?-1:1);if(/(impuesto.*renta|renta.*impuesto|provisi[oó]n.*renta)/.test(name))totals.tax+=amount;else if(/(cambi|financier|inter[eé]s|no operativ|otros ingresos|otros gastos)/.test(name))totals.nonop+=amount*(r.category==='Ingreso'?1:-1);else totals[r.category==='Ingreso'?'revenue':r.category==='Costo'?'cost':'expense']+=amount;}
  const gross=totals.revenue-totals.cost,operating=gross-totals.expense;
  push('Resultados del período',[['Ingresos',totals.revenue],['Costos',totals.cost],['Utilidad bruta',gross],['Gastos operativos',totals.expense],['Resultado operativo',operating],['Resultado no operativo',totals.nonop],['Impuesto sobre la renta',totals.tax],['Resultado neto',operating+totals.nonop-totals.tax]]);
 }
 if(report.kind==='equity-changes'){
  const base=rows.filter(r=>!/resultado del ejercicio/i.test(r.account_name||'')),opening=base.reduce((s,r)=>s-number(r.opening),0)+number(summary.currentPeriodResult)-number(summary.periodResult),closing=base.reduce((s,r)=>s-number(r.closing),0)+result;
  push('Cambios en el patrimonio',[['Patrimonio inicial',opening],['Resultado del período',number(summary.periodResult)],['Otros movimientos',closing-opening-number(summary.periodResult)],['Patrimonio final',closing]]);
 }
 if(report.kind==='cash-flow'){
  const sum=(predicate:(r:RecordRow)=>boolean,amount:(r:RecordRow)=>number)=>rows.filter(predicate).reduce((s,r)=>s+amount(r),0),variation=(r:RecordRow)=>number(r.opening)-number(r.closing);
  const opening=sum(r=>r.cash_flow_activity==='EFECTIVO_EQUIVALENTE',r=>number(r.opening)),closing=sum(r=>r.cash_flow_activity==='EFECTIVO_EQUIVALENTE',r=>number(r.closing));
  const operating=number(summary.periodResult)+sum(r=>r.cash_flow_activity==='OPERACION'&&['Ingreso','Costo','Gasto'].includes(r.category)&&/(depreci|amortiza|deterior|provisi[oó]n|venta.*activo|diferencial cambiario)/.test(String(r.account_name).toLowerCase()),r=>number(r.debit)-number(r.credit))+sum(r=>r.cash_flow_activity==='OPERACION'&&['Activo','Pasivo'].includes(r.category),variation);
  const investing=sum(r=>r.cash_flow_activity==='INVERSION',variation),financing=sum(r=>r.cash_flow_activity==='FINANCIACION',variation);
  push('Flujos de efectivo · Método indirecto',[['Actividades de operación',operating],['Actividades de inversión',investing],['Actividades de financiación',financing],['Variación neta',operating+investing+financing],['Efectivo inicial',opening],['Efectivo final',closing],['Diferencia de conciliación',closing-opening-operating-investing-financing]]);
 }
 return sections;
}
export function reportSections(report:Report):Section[]{
 const sections=financialSections(report);let visited=0;
 const visit=(value:any,title:string,depth=0)=>{
  if(depth>8)throw Error('El detalle del reporte supera la profundidad permitida.');
  if(Array.isArray(value)){
   visited+=value.length;if(visited>50000)throw Error('El reporte supera el máximo de detalle. Reduzca el período.');
   if(!value.length){sections.push({title,columns:['Resultado'],rows:[['Sin movimientos para el período seleccionado.']]});return;}
   const records=value.map(v=>v&&typeof v==='object'?v:{value:v});
   const keys=[...new Set(records.flatMap(v=>Object.keys(v)))].filter(k=>!hidden(k)&&records.some(v=>isScalar(v[k])&&v[k]!==undefined));
   const priority=['journal_number','document_number','account_number','number','date','issue_date','account_name','customer','customer_name','supplier_name','entity_name','description'];
   keys.sort((a,b)=>(priority.includes(a)?priority.indexOf(a):99)-(priority.includes(b)?priority.indexOf(b):99));
   if(keys.length)sections.push({title,columns:['N.º',...keys.map(label)],rows:records.map((r,i)=>[i+1,...keys.map(k=>r[k]??null)])});
   records.forEach((r,i)=>Object.entries(r).forEach(([k,v])=>{if(!hidden(k)&&v&&!isScalar(v))visit(v,`${title} · ${r.journal_number||r.document_number||r.number||r.reference||i+1} · ${label(k)}`,depth+1);}));
  }else if(value&&typeof value==='object'){
   const scalars=Object.entries(value).filter(([k,v])=>!hidden(k)&&isScalar(v)&&!(k==='total'&&Array.isArray(value.rows)));
   if(scalars.length)sections.push({title,columns:['Concepto','Valor'],rows:scalars.map(([k,v])=>[label(k),v])});
   const entries=Object.entries(value).filter(([k,v])=>!hidden(k)&&v&&!isScalar(v));entries.sort(([a],[b])=>(a==='summary'?-1:b==='summary'?1:0));
   for(const [k,v]of entries)visit(v,label(k),depth+1);
  }
 };
 let data=report.data||{};
 if(sections.length){
  const {summary,...detail}=data;data=detail;
  if(report.kind==='income-statement')data={rows:(data.rows||[]).map((r:RecordRow)=>({account_number:r.account_number,account_name:r.account_name,category:r.category,amount:(number(r.debit)-number(r.credit))*(r.category==='Ingreso'?-1:1)}))};
  if(report.kind==='balance-sheet')data={rows:(data.rows||[]).map((r:RecordRow)=>({account_number:r.account_number,account_name:r.account_name,category:r.category,balance:number(r.closing)*(r.category==='Activo'?1:-1)}))};
 }
 visit(data,'Información del reporte');return sections;
}
export function genericReportCsv(report:Report){
 const rows:unknown[][]=[['Reporte',report.title||report.kind],['Sociedad',report.company],['Moneda local',report.currency],['Desde',report.dateFrom||''],['Fecha de corte',report.cutoff],[]];
 for(const s of reportSections(report))rows.push([s.title],s.columns,...s.rows,[]);
 const cell=(v:unknown)=>{let str=String(v??'');if(typeof v!=='number'&&/^[=+\-@\t\r]/.test(str))str="'"+str;return '"'+str.replaceAll('"','""')+'"';};
 return '\uFEFF'+rows.map(r=>r.map(cell).join(',')).join('\r\n');
}
export function genericReportHtml(report:Report){
 const sections=reportSections(report),tables=sections.map(s=>{
  // Split wide tables and repeat the row number to retain an unambiguous link between parts.
  const groups:number[][]=[];if(s.columns.length<=9)groups.push(s.columns.map((_,i)=>i));else for(let i=1;i<s.columns.length;i+=8)groups.push([0,...s.columns.slice(i,i+8).map((_,j)=>i+j)]);
  return groups.map((cols,part)=>`<section><h2>${esc(s.title)}${groups.length>1?` · ${part+1}/${groups.length}`:''}</h2><table><thead><tr>${cols.map(i=>`<th>${esc(s.columns[i])}</th>`).join('')}</tr></thead><tbody>${s.rows.map(r=>`<tr>${cols.map(i=>`<td class="${typeof r[i]==='number'?'num':''}">${esc(formatted(r[i]))}</td>`).join('')}</tr>`).join('')}</tbody></table></section>`).join('');
 }).join('');
 return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(report.title||report.kind)}</title><style>@page{size:A4 landscape;margin:14mm}*{box-sizing:border-box}body{font:10px Arial,sans-serif;color:#17324d;margin:0;print-color-adjust:exact;-webkit-print-color-adjust:exact}header{border-bottom:3px solid #0b8069;padding-bottom:14px;display:flex;justify-content:space-between;gap:20px}h1{font-size:23px;margin:6px 0}h2{font-size:13px;margin:18px 0 8px;break-after:avoid}.muted{color:#607286}.brand{font-weight:bold;letter-spacing:3px;color:#0b8069}table{width:100%;border-collapse:collapse;table-layout:fixed}thead{display:table-header-group}th{background:#17324d;color:white;text-align:left}td,th{padding:7px;border-bottom:1px solid #dce5ed;overflow-wrap:anywhere;vertical-align:top}tbody tr:nth-child(even){background:#f4f7fa}tr{break-inside:avoid}.num{text-align:right;font-variant-numeric:tabular-nums}footer{margin-top:20px;padding-top:10px;border-top:1px solid #dce5ed;color:#607286}</style></head><body><header><div><span class="brand">NEXO · INFORMES</span><h1>${esc(report.title||report.kind)}</h1><strong>${esc(report.company)}</strong></div><div>Fecha de corte: <b>${esc(report.cutoff)}</b>${report.dateFrom?`<p>Desde: ${esc(report.dateFrom)}</p>`:''}<p>Moneda local: ${esc(report.currency)}</p></div></header>${tables||'<p>Sin movimientos para el período seleccionado.</p>'}<footer>Reporte programado · Información correspondiente a la sociedad y al período indicados. Los importes de monedas extranjeras se identifican en su sección.</footer></body></html>`;
}
